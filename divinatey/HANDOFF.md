# Divinatey handoff

Where the project stands, the decisions behind it, and what's next. The code in this folder is a copy of `scinery1234/divinatey` on branch `claude/friendly-johnson-cdgyq7` (the deployment builds from that branch). Hypnoy's own app is unrelated and unchanged.

## What Divinatey is

One site (Express server + React/Vite client) with:

- **The draw**: an I Ching hexagram and a 7-card Tarot spread cast from the moment (seeded with ANU quantum noise), each interpreted by Claude, plus a synthesis. Free.
- **Four birth charts**: Gene Keys (Hologenetic Profile), Human Design (bodygraph), Western natal (tropical, Placidus), Vedic (sidereal, Lahiri, whole-sign, Vimshottari dasha, Panchang). Calculated on the server with the open-source Astronomy Engine; birth places from GeoNames (111k places with coordinates and timezones).
- **Numerology** (fifth chart, Pythagorean): from the full name at birth and the birth date (time and place optional). Core numbers, name letters and number balance (karmic lessons, hidden passion, karmic debt), pinnacles and challenges, personal year/month/day and the next 7 days. Same tiers, guide, reading, chat and chart linking as the others. AI prompts get only the numbers and the date, never the birth name.
- **Home page** with pricing, FAQ, disclaimers and links to genekeys.com and jovianarchive.com (not affiliated).

## Tiers

| | Free | Paid ($20/month or $180/year) |
|---|---|---|
| Draw + interpretation | ✓ | ✓ |
| Chat on the draw | locked teaser | ✓ |
| Charts | all five systems for **2 people per IP per day** (one person's details open every system and count once) | no daily limit, 2 saved chart slots |
| Chart guide | fixed reference text | "Explain →" per item, overviews, four-part reading, chat about the chart |
| Link charts into the draw's chat | — | ✓, 5 draws per week; $5 per extra question |

`/preview` (any page under it) unlocks every paid feature for anyone, for testing until Stripe is live. `PAID_PREVIEW=0` closes it.

## Key decisions (from the user)

- **Readings stay separate.** Every AI call is a single fresh prompt built on the server from recalculated data; no generated text is fed into another prompt; systems never mix. Explicit exceptions: Gene Keys sequence summaries (and the per-tab overviews) see their own tab's items; linking charts to a question is opt-in.
- **Chat with linked charts** runs in four steps: retrieve (fast model picks 3–6 relevant chart fact cards) → make sense (private notes) → insight (plain language, at most one explained term) → polish (fast model). Shows "drew on: …" in plain words. Changing the linked charts re-answers the latest question. The chat also sees what the reading page says about each card and the hexagram (server keeps its own copy).
- **No card or hexagram names** in the chat teaser.
- Gene Keys layout: Vocation upper-left, Culture upper-right, IQ lower-left, EQ lower-right.
- Leaving or refreshing keeps the person on screen, chats, explanations and the last reading (sessionStorage, per tab).
- Sign-in: email + password **or** magic link (Supabase Auth).
- Disclaimer on every page: reflection and entertainment only, AI can be wrong, not professional advice.

## Code map

- `server/index.js` — routes, limits, paywall, preview, quotas
- `server/astro.js` — chart engine on the server (each system in its own isolated instance), place search, prompts for explanations/readings/chat, fact cards
- `server/oracle-ai.js` — Claude calls: draw interpretation, chats, linked-chart pipeline, explanations
- `server/store.js` — Supabase store (or in-memory for tests); `server/billing.js` — Stripe
- `shared/astro/` — the chart engine and the four system modules; `scripts/astro/build-pages.mjs` builds standalone chart pages
- `src/` — React app: `App.jsx`, `components/` (Home, ChartScreen, ChartGuide, ChartChat, LinkCharts, AccountScreen, Billing, ChatTeaser)
- `supabase/migrations/0001–0004` — run in order in the Supabase SQL editor (0004 adds Numerology to saved charts)
- `scripts/stripe-setup.mjs` (`npm run stripe:setup`) — creates prices, billing portal and webhook
- `shared/astro/systems/numerology.js` — Numerology (no astronomy; `needsBirthName` and `dateOnly` flags change the form)
- Tests: `npm test` (58 tests; Claude, Supabase and Stripe are mocked)

## Setup still to do (by the user)

1. Supabase: run migrations 0001, 0002, 0003, 0004; add redirect URLs `/account` and `/preview/account`; set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `FREE_LIMIT_SECRET`.
2. Stripe (test mode first): `STRIPE_SECRET_KEY=sk_test_... PUBLIC_URL=https://site npm run stripe:setup`; set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PUBLIC_URL`; test with card 4242 4242 4242 4242.
3. Before launch: Stripe business details and activation; legal review of Terms/Privacy (refunds); currency (USD now, AUD on request); run setup with the live key; `PAID_PREVIEW=0`.

## Open items / ideas

- Verify real linked-chat quality and speed on the deployed site (expect 10–20 s). If the host cuts requests off, stream the reply.
- If `claude-haiku-5-5` isn't available to the key, set `ANTHROPIC_QUICK_MODEL`.
- Free-limit and rate-limit counters are per process unless Supabase is configured; use the proxy's limits with several instances.
- No real Supabase or Stripe test has been run yet (no keys in the build environment).
- Numerology: a numerology chart opened without a birth place counts as a separate person for the free limit (its key uses UTC). The personal day uses the birth place's timezone, not where the person is now.
