# Hypnoy — Hypnotic Voice

A standalone AI tool that **generates** a fully timed hypnosis script from a prompt
and **speaks** it aloud with deliberate timing, tone, and pause.

- **Generate** — `POST /api/hypnosis` calls Claude (`claude-opus-4-8`) with structured
  output and returns a four-phase, timed script (induction → deepener → therapeutic →
  emergence). Each line carries an explicit `pauseAfterMs`.
- **Speak** — the front end plays the script with the browser **Web Speech API**
  (no TTS cost), with per-line highlighting, play/pause/resume, a progress bar, a
  voice picker, and a pace slider. A slow-pulsing amber orb breathes faster during
  playback.

## Stack

- Vite + React 19 (single page, no router)
- Tailwind CSS v4
- One Vercel serverless function (`api/hypnosis/index.ts`) using `@anthropic-ai/sdk`

## Local development

```bash
npm install
cp .env.example .env        # then put your sk-ant-... key in .env
npm run dev:vercel          # runs Vite + the /api function together (needs `vercel` CLI)
```

> Plain `npm run dev` serves the UI but NOT the `/api/hypnosis` function — generation
> will fail until you run under `vercel dev` (or deploy). Install the CLI with
> `npm i -g vercel` if you don't have it.

## Deploy

### Option A — one-shot script

With the `gh` and `vercel` CLIs installed and logged in:

```bash
./deploy-hypnoy.sh
```

It creates a private GitHub repo `Hypnoy`, links/creates a Vercel project, prompts
for your Anthropic key (hidden), sets it for Production + Preview, and deploys to prod.

> ⚠️ The script runs `rm -rf .git && git init` in this folder — run it only on this
> standalone copy, not inside another repo you want to keep.

### Option B — Vercel dashboard

1. Push this folder to a new GitHub repo.
2. Import it in Vercel (framework auto-detects as Vite).
3. Set `ANTHROPIC_API_KEY` in **Settings → Environment Variables** (Production + Preview).
4. Deploy.

## API contract

**Request** `POST /api/hypnosis`

```json
{ "prompt": "string (3–600 chars)", "durationMinutes": 5, "tone": "gentle" }
```

`durationMinutes` ∈ {5, 10, 20} (default 10). `tone` ∈ {gentle, authoritative, warm} (default gentle).

**Response** `200`

```json
{ "script": {
  "title": "string", "intention": "string", "durationMinutes": 10,
  "phases": [ { "name": "induction", "label": "Induction",
    "segments": [ { "text": "string", "pauseAfterMs": 2000 } ] } ]
} }
```

Errors: `400` invalid input · `422` model declined · `500` missing key / unexpected · `502` model/output failure.
