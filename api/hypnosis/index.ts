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

const ALLOWED_DURATIONS = [5, 10, 20] as const;
const ALLOWED_TONES: Tone[] = ['gentle', 'authoritative', 'warm'];

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
  };

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (prompt.length < 3) {
    return res
      .status(400)
      .json({ message: 'A prompt of at least 3 characters is required.' });
  }
  if (prompt.length > 600) {
    return res.status(400).json({ message: 'Prompt is too long (max 600 characters).' });
  }

  const durationMinutes = ALLOWED_DURATIONS.includes(body.durationMinutes as 5 | 10 | 20)
    ? (body.durationMinutes as number)
    : 10;
  const tone = ALLOWED_TONES.includes(body.tone as Tone) ? (body.tone as Tone) : 'gentle';

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 16000,
      system: buildSystemPrompt(durationMinutes, tone),
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
          content: `Create a hypnosis session for this intention: "${prompt}". Desired length: ${durationMinutes} minutes. Tone: ${tone}.`,
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
