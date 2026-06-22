import type { VercelRequest, VercelResponse } from '@vercel/node';
import OpenAI from 'openai';

export const config = { maxDuration: 30 };

const ALLOWED_VOICES = ['nova', 'shimmer', 'alloy', 'echo', 'fable', 'onyx'] as const;
type Voice = (typeof ALLOWED_VOICES)[number];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ message: 'Server is missing OPENAI_API_KEY configuration.' });
  }

  const { text, voice = 'nova' } = (req.body ?? {}) as { text?: unknown; voice?: unknown };

  if (typeof text !== 'string' || text.trim().length < 1) {
    return res.status(400).json({ message: 'text is required.' });
  }
  if (text.length > 4096) {
    return res.status(400).json({ message: 'text too long (max 4096 chars).' });
  }
  if (!ALLOWED_VOICES.includes(voice as Voice)) {
    return res.status(400).json({ message: 'Invalid voice.' });
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  try {
    const response = await client.audio.speech.create({
      model: 'tts-1-hd',
      voice: voice as Voice,
      input: text.trim(),
      response_format: 'mp3',
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.status(200).send(buffer);
  } catch (err) {
    if (err instanceof OpenAI.APIError) {
      return res.status(502).json({ message: err.message });
    }
    return res.status(500).json({ message: 'Unexpected TTS error.' });
  }
}
