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

---

## Coaching Companion (standalone)

A second, self-contained app: a **holistic therapist-led coaching chat** with four
guided modules. It lives at **`/coach.html`** (served statically from `public/`) and
talks to one shared serverless endpoint, `POST /api/coach`. It reuses the same
`ANTHROPIC_API_KEY` — no extra configuration.

Modules (a single `module` key selects the coach's method and voice):

- **Reducing the Charge** — lower the emotional intensity held around a memory,
  trigger, or belief with a gentle somatic + reframing process (name it → rate 0–10 →
  locate it in the body → breathe → soften → re-rate).
- **CBT Coach** — a Socratic thought record: situation → emotion → automatic thought →
  thinking traps → evidence → balanced alternative → small experiment.
- **Executive Function Ally** — get unstuck when overwhelmed or unable to start
  (externalise → name the block → shrink to the tiniest next action → lower activation
  energy → time-box), framing it as brain wiring, never laziness.
- **Inner Compass** — a self-compassion / inner-parts guide (IFS + compassion-focused
  therapy) for turning toward a struggling or self-critical part with warmth.

Every module shares one guardrail layer: warm, brief, one-question-at-a-time replies,
plus a safety net that pauses the exercise and signposts crisis support (local
emergency line, or 988 in the US) if someone sounds in danger. The app is a coaching
companion, **not** therapy, diagnosis, or medical advice, and says so in the UI.

Conversations are kept per-module in the browser's `localStorage`; switching modules
keeps each thread separate. As with `/api/hypnosis`, the `/api/coach` function only
runs under `vercel dev` or a Vercel deploy — plain `vite dev` serves `coach.html` but
not the endpoint.

**Request** `POST /api/coach`

```json
{ "module": "cbt", "messages": [ { "role": "user", "content": "string" } ] }
```

`module` ∈ {`reducing-the-charge`, `cbt`, `executive-dysfunction`, `inner-compass`}.

**Response** `200`

```json
{ "reply": "string" }
```

Errors: `400` unknown module / no user message · `500` missing key / unexpected · `502` empty or upstream model failure.
