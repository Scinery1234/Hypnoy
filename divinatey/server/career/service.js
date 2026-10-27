// Career Readings from cast to finished report.
//
//   cast()     the draw is cast on the server and sealed (the cards are never sent
//              until the reading is written), and a reading record is created.
//   submit()   the person's answers, birth details and question arrive after the
//              cast; everything is validated by preparing the reading once. Then
//              either Stripe checkout (paid) or straight to the queue (preview).
//   paid()     Stripe's webhook confirms payment and the reading is queued.
//   run()      writes the reading in the background: every step, retried, with
//              progress saved as it goes so a restart can resume it.
import { prepare, buildSteps, runSteps, ReadingInputError } from "./pipeline.js";
import { renderMarkdown } from "./render.js";
import { QuizError } from "./quiz.js";
import { ChartInputError } from "../astro.js";

export class CareerError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const str = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");

export function createCareerService({ store, billing, runner, mailer, getSeed, publicUrl, env = process.env, log = console }) {
  const keepDays = Number(env.CAREER_KEEP_DAYS) || 90;
  const parallel = Number(env.CAREER_PARALLEL) || 2;          // readings written at once
  const concurrency = Number(env.CAREER_CONCURRENCY) || 8;    // steps at once within one reading
  const retryDelay = env.CAREER_RETRY_MS != null ? Number(env.CAREER_RETRY_MS) : 2000;
  const queue = [], active = new Set();
  if (billing) billing.hooks.readingPaid = (id, session) => paid(id, session);

  // Only what the person should see, at each stage.
  function view(r) {
    const v = { id: r.id, status: r.status, castAt: r.cast_at, preview: r.preview };
    if (r.status === "cast") return v;
    Object.assign(v, { askedAt: r.asked_at, progress: r.progress || null, email: !!r.email });
    if (r.status === "done") v.report = r.report;
    if (r.status === "failed") v.error = "generation_failed";
    return v;
  }

  async function get(id) {
    if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new CareerError(404, "not_found");
    const r = await store.careerGet(id);
    if (!r) throw new CareerError(404, "not_found");
    return r;
  }

  function cleanPerson(p) {
    p = p || {};
    const out = { birthName: str(p.birthName, 100), name: str(p.name, 60), date: str(p.date, 10), time: str(p.time, 5) || "12:00",
      tz: str(p.tz, 60), place: str(p.place, 120), timeUnknown: !!p.timeUnknown };
    if (p.lat != null && p.lon != null) { out.lat = Number(p.lat); out.lon = Number(p.lon); }
    return out;
  }

  async function checkoutUrl(r) {
    const base = publicUrl().replace(/\/+$/, "") + (r.preview ? "/preview" : "") + "/career/r/" + r.id;
    const session = await billing.checkoutReading({ readingId: r.id, email: r.email, returnUrl: base });
    await store.careerUpdate(r.id, { stripe_session: session.id });
    return session.url;
  }

  async function paid(id, session) {
    const email = session && session.customer_details && session.customer_details.email;
    const r = await store.careerGet(id);
    if (!r) return "career_reading_unknown";
    const updated = await store.careerUpdate(id, { status: "queued", paid: true, ...(r.email || !email ? {} : { email: String(email).slice(0, 254) }) }, "awaiting_payment");
    if (!updated) return "career_reading_already";
    start(id);
    return "career_reading_started";
  }

  function start(id) {
    if (active.has(id) || queue.includes(id)) return;
    queue.push(id);
    pump();
  }
  function pump() {
    while (active.size < parallel && queue.length) {
      const id = queue.shift();
      active.add(id);
      run(id).catch(err => log.error("Career reading " + id + " failed:", err)).finally(() => { active.delete(id); pump(); });
    }
  }

  // Each step gets up to three tries; a refusal or a bad schema isn't retried forever.
  const retrying = async st => {
    let last;
    for (let i = 0; i < 3; i++) {
      try { return await runner(st); }
      catch (err) { last = err; if (i < 2) await new Promise(r => setTimeout(r, retryDelay * (i + 1) ** 2)); }
    }
    throw last;
  };

  async function run(id) {
    const r = await store.careerGet(id);
    if (!r || !["queued", "running"].includes(r.status)) return;
    await store.careerUpdate(id, { status: "running" });
    const ctx = prepare({ ...r.input, draw: { seed: r.seed, castAt: r.cast_at }, question: { text: r.input.question.text, askedAt: r.asked_at } });
    const steps = buildSteps(ctx);
    const outputs = { ...(r.outputs || {}) };
    const todo = steps.filter(s => !outputs[s.id] || outputs[s.id].error);
    const total = steps.length;
    let done = total - todo.length, lastSave = 0;
    const save = async force => {
      if (!force && Date.now() - lastSave < 3000) return;
      lastSave = Date.now();
      await store.careerUpdate(id, { progress: { done, total }, outputs });
    };
    await save(true);
    await runSteps(todo, async st => {
      try { outputs[st.id] = await retrying(st); }
      catch (err) { outputs[st.id] = { error: String(err && err.message || err).slice(0, 300) }; }
      done++;
      await save(false);
      return outputs[st.id];
    }, { concurrency });
    const failed = steps.filter(s => !outputs[s.id] || outputs[s.id].error);
    if (failed.length > Math.max(3, total * 0.05)) {
      log.error(`Career reading ${id}: ${failed.length} of ${total} steps failed`, failed.slice(0, 5).map(s => s.id + ": " + outputs[s.id].error));
      await store.careerUpdate(id, { status: "failed", progress: { done, total }, outputs, error: `${failed.length} steps failed` });
      return;
    }
    const report = renderMarkdown(ctx, outputs, { missing: "This part couldn't be written this time." });
    await store.careerUpdate(id, { status: "done", progress: { done: total, total }, outputs, report });
    log.log(`Career reading ${id} done (${total} steps, ${failed.length} missing)`);
    if (r.email && mailer && mailer.enabled) {
      const link = publicUrl().replace(/\/+$/, "") + (r.preview ? "/preview" : "") + "/career/r/" + id;
      try {
        await mailer.send({
          to: r.email, subject: "Your Career Reading is ready",
          text: `Your Career Reading is ready:\n${link}\n\nKeep this link private: anyone with it can open your reading. It's kept for ${keepDays} days.\n\nCoaching, not therapy. In crisis? Call Lifeline on 13 11 14, any time.`,
          html: `<p>Your Career Reading is ready.</p><p><a href="${link}">Open your reading</a></p><p>Keep this link private: anyone with it can open your reading. It's kept for ${keepDays} days.</p><p style="color:#56607A;font-size:13px">Coaching, not therapy. In crisis? Call Lifeline on 13 11 14, any time.</p>`,
        });
      } catch (err) { log.error("Career reading email failed:", err.message || err); }
    }
  }

  return {
    async cast({ userId, preview }) {
      store.careerCleanup(new Date(Date.now() - keepDays * 864e5).toISOString()).catch(() => {});
      const { seed } = await getSeed();
      const r = await store.careerCreate({ seed, cast_at: new Date().toISOString(), user_id: userId || null, preview: !!preview });
      return { id: r.id, castAt: r.cast_at };
    },

    async submit(id, body, { preview }) {
      const r = await get(id);
      if (r.status !== "cast") throw new CareerError(409, "already_submitted");
      if (!!r.preview !== !!preview) throw new CareerError(403, "wrong_mode");
      const text = str(body && body.question, 1200);
      if (text.length < 10) throw new CareerError(400, "question_too_short");
      const email = str(body && body.email, 254).toLowerCase();
      if (email && !EMAIL.test(email)) throw new CareerError(400, "invalid_email");
      const askedAt = new Date().toISOString();
      const input = { person: cleanPerson(body && body.person), answers: body && body.answers, question: { text } };
      try { prepare({ ...input, draw: { seed: r.seed, castAt: r.cast_at }, question: { text, askedAt } }); }
      catch (err) {
        if (err instanceof ReadingInputError || err instanceof QuizError || err instanceof ChartInputError) throw new CareerError(400, err.message);
        throw err;
      }
      if (!preview && !billing) throw new CareerError(503, "billing_off");
      const status = preview ? "queued" : "awaiting_payment";
      const updated = await store.careerUpdate(id, { status, input, asked_at: askedAt, email: email || null }, "cast");
      if (!updated) throw new CareerError(409, "already_submitted");
      if (preview) { start(id); return view(updated); }
      return { ...view(updated), checkoutUrl: await checkoutUrl(updated) };
    },

    async checkout(id) {
      const r = await get(id);
      if (r.status !== "awaiting_payment") throw new CareerError(409, "not_awaiting_payment");
      if (!billing) throw new CareerError(503, "billing_off");
      return checkoutUrl(r);
    },

    async status(id) { return view(await get(id)); },

    // A failed reading can be tried again; steps that already succeeded are kept.
    async retry(id) {
      const updated = await store.careerUpdate((await get(id)).id, { status: "queued", error: null }, "failed");
      if (!updated) throw new CareerError(409, "not_failed");
      start(id);
      return view(updated);
    },

    async report(id) {
      const r = await get(id);
      if (r.status !== "done") throw new CareerError(409, "not_ready");
      return r.report;
    },

    async price() { return billing ? billing.readingPrice() : null; },

    paid,
    // After a restart: carry on with readings that were queued or being written.
    async resume() {
      const ids = await store.careerPending();
      ids.forEach(start);
      return ids.length;
    },
    idle: () => !active.size && !queue.length,
  };
}
