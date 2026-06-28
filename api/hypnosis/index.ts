import type { VercelRequest, VercelResponse } from '@vercel/node';
import Anthropic from '@anthropic-ai/sdk';

/**
 * Hypnosis script generator.
 * POST /api/hypnosis
 * Body: { prompt: string, durationMinutes?: 5|10|20, tone?: 'gentle'|'authoritative'|'warm' }
 *
 * Returns a fully structured, timed hypnosis script that the client speaks
 * with the Web Speech API. Claude produces the four classic phases
 * (induction → deepener → therapeutic core → emergence) with explicit
 * pause timings so the front-end pacing engine can reproduce the intended
 * duration and cadence.
 */

// Generation can involve a fair amount of reasoning + long output; give it room.
export const config = { maxDuration: 60 };

type Tone = 'gentle' | 'authoritative' | 'warm';

const MIN_DURATION = 1;
const MAX_DURATION = 60;
const ALLOWED_TONES: Tone[] = ['gentle', 'authoritative', 'warm'];

function clampDuration(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 10;
  return Math.max(MIN_DURATION, Math.min(MAX_DURATION, n));
}

const SCRIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', description: 'A short, evocative title for the session.' },
    intention: {
      type: 'string',
      description: 'One sentence describing the therapeutic intention.',
    },
    durationMinutes: { type: 'number' },
    phases: {
      type: 'array',
      description: 'The four phases of the session, in order.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: {
            type: 'string',
            enum: ['induction', 'deepener', 'therapeutic', 'emergence'],
          },
          label: { type: 'string', description: 'Human-readable phase name.' },
          segments: {
            type: 'array',
            description: 'Spoken lines in this phase, in order.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                text: {
                  type: 'string',
                  description: 'A single spoken sentence or short phrase, no stage directions.',
                },
                pauseAfterMs: {
                  type: 'number',
                  description:
                    'Silence to hold after speaking this line, in milliseconds (0–20000).',
                },
              },
              required: ['text', 'pauseAfterMs'],
            },
          },
        },
        required: ['name', 'label', 'segments'],
      },
    },
  },
  required: ['title', 'intention', 'durationMinutes', 'phases'],
} as const;

function buildSystemPrompt(durationMinutes: number, tone: Tone): string {
  return `You are an expert clinical hypnotherapist and scriptwriter. You write hypnosis scripts that are calming, safe, ethical, and effective.

Write a complete guided hypnosis session of approximately ${durationMinutes} minutes in a ${tone} tone of voice.

Structure the session in exactly four phases, in this order, with roughly these proportions of the total time:
1. induction (~20%) — settling in, slow breathing, progressive physical relaxation, body scan, an anchor of safety.
2. deepener (~15%) — counting down, staircase or descending imagery, deepening the relaxed state step by step.
3. therapeutic (~50%) — the heart of the session, directly addressing the listener's stated intention with vivid, positive, present-tense suggestions and imagery.
4. emergence (~15%) — gently guiding the listener back to full awareness, reorienting, leaving them refreshed with a positive anchor to carry forward.

Pacing rules (these drive the actual playback timing — they matter):
- Each segment is ONE spoken sentence or short phrase. Keep lines short and breathable.
- Use second person ("you"). Never use stage directions, markup, or bracketed notes inside the text — text is spoken verbatim.
- Set pauseAfterMs to control rhythm: short reflective pauses (800–2500ms) between most lines; longer pauses (4000–10000ms) after breathing cues, after asking the listener to notice or feel something, and at phase transitions.
- Pace the session so the cumulative speaking time plus pauses lands near ${durationMinutes} minutes. Spoken words run at roughly 110 words per minute for a slow hypnotic delivery; budget the rest of the time as pauses. Longer sessions need more segments and longer pauses, not padding.
- Begin gently and never include anything alarming, medical claims, or instructions to ignore real-world safety. Do not reference being a recording or an AI.

Return only the structured script.`;
}

function buildRevisionSystemPrompt(durationMinutes: number, tone: Tone): string {
  return `You are an expert clinical hypnotherapist and scriptwriter revising an existing guided hypnosis script.

You will be given the current script as JSON and a short instruction describing how the listener wants it changed. Apply the requested change while keeping the session calming, safe, ethical, and effective.

Rules for the revision:
- Honour the listener's instruction directly. If it asks to change focus, tone, length, pacing, imagery, or a specific phase, make exactly that change.
- Preserve the four-phase structure (induction → deepener → therapeutic → emergence) unless the instruction explicitly asks otherwise. Keep anything the instruction does not ask to change largely intact.
- Keep the target length near ${durationMinutes} minutes and an overall ${tone} tone unless the instruction overrides this.
- Each segment is ONE spoken sentence or short phrase, second person ("you"), no stage directions or bracketed notes — text is spoken verbatim.
- pauseAfterMs controls rhythm (0–20000): short reflective pauses (800–2500ms) between most lines; longer pauses (4000–10000ms) after breathing cues and at phase transitions.
- Never include anything alarming, medical claims, or references to being a recording or an AI.

Return the complete revised script — every phase and segment, not just the changed parts.`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res
      .status(500)
      .json({ message: 'Server is missing ANTHROPIC_API_KEY configuration.' });
  }

  const body = (req.body ?? {}) as {
    prompt?: unknown;
    durationMinutes?: unknown;
    tone?: unknown;
    editInstruction?: unknown;
    baseScript?: unknown;
  };

  const tone = ALLOWED_TONES.includes(body.tone as Tone) ? (body.tone as Tone) : 'gentle';
  const durationMinutes = clampDuration(body.durationMinutes);

  // Refine mode: revise an existing script from a short chat instruction.
  const editInstruction =
    typeof body.editInstruction === 'string' ? body.editInstruction.trim() : '';
  const isRefine = editInstruction.length > 0;

  let systemPrompt: string;
  let userContent: string;

  if (isRefine) {
    if (editInstruction.length > 400) {
      return res
        .status(400)
        .json({ message: 'Edit instruction is too long (max 400 characters).' });
    }
    if (!body.baseScript || typeof body.baseScript !== 'object' || Array.isArray(body.baseScript)) {
      return res
        .status(400)
        .json({ message: 'A baseScript object is required to refine a session.' });
    }
    let baseJson: string;
    try {
      baseJson = JSON.stringify(body.baseScript);
    } catch {
      return res.status(400).json({ message: 'baseScript could not be processed.' });
    }
    if (baseJson.length > 40000) {
      return res.status(400).json({ message: 'baseScript is too large.' });
    }
    const baseDuration =
      typeof (body.baseScript as { durationMinutes?: unknown }).durationMinutes === 'number'
        ? clampDuration((body.baseScript as { durationMinutes: number }).durationMinutes)
        : durationMinutes;
    systemPrompt = buildRevisionSystemPrompt(baseDuration, tone);
    userContent = `Here is the current session script as JSON:\n\n${baseJson}\n\nRevise it according to this instruction: "${editInstruction}". Return the complete updated script.`;
  } else {
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (prompt.length < 3) {
      return res
        .status(400)
        .json({ message: 'A prompt of at least 3 characters is required.' });
    }
    if (prompt.length > 600) {
      return res.status(400).json({ message: 'Prompt is too long (max 600 characters).' });
    }
    systemPrompt = buildSystemPrompt(durationMinutes, tone);
    userContent = `Create a hypnosis session for this intention: "${prompt}". Desired length: ${durationMinutes} minutes. Tone: ${tone}.`;
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 16000,
      system: systemPrompt,
      tools: [
        {
          name: 'generate_script',
          description: 'Output the fully structured hypnosis script.',
          input_schema: SCRIPT_SCHEMA as Record<string, unknown>,
        },
      ],
      tool_choice: { type: 'tool', name: 'generate_script' },
      messages: [
        {
          role: 'user',
          content: userContent,
        },
      ],
    });

    const toolBlock = message.content.find((b) => b.type === 'tool_use');
    if (!toolBlock || toolBlock.type !== 'tool_use') {
      return res.status(502).json({ message: 'The model returned no usable script.' });
    }

    const script = toolBlock.input;

    return res.status(200).json({ script });
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      console.error('Hypnosis generation API error:', err.status, err.message);
      const status = err.status && err.status >= 500 ? 502 : 400;
      return res
        .status(status)
        .json({ message: err.message, status: err.status, error: 'APIError' });
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Hypnosis generation error:', err);
    return res.status(500).json({ message: msg, error: 'UnexpectedError' });
  }
}
