// The Career Reading pages: /career (questions, birth details, the cast and the
// question), /career/r/<id> (progress, payment and the finished reading) and
// /career/sample. New Page look, scoped under .np.
import { useState, useEffect, useRef, useCallback } from "react";
import { marked } from "marked";
import raw from "./career.css?raw";
import { scopeCss } from "../astroStyles.js";
import { PREVIEW, routePath, href } from "../preview.js";
import { detectCrisis } from "../../shared/safety.js";
import { COMPASS, COMPASS_SCALE, STATEMENTS, LIKE, SITUATIONS, WELLBEING, asksSatisfaction } from "../../server/career/quiz.js";
import { findPlaces, careerConfig, careerCast, careerSubmit, careerStatus, careerCheckout, careerRetry, careerReportUrl, careerErrorText } from "../api.js";

let styled = false;
function useStyles() {
  if (styled || typeof document === "undefined") return;
  styled = true;
  const font = document.createElement("link");
  font.rel = "stylesheet";
  font.href = "https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@600;700&family=Figtree:wght@400;500;600;700&family=Caveat:wght@600&display=swap";
  document.head.appendChild(font);
  const el = document.createElement("style");
  el.textContent = scopeCss(raw.replace(/\/\*[\s\S]*?\*\//g, ""), ".np");   // comments would end up in selectors
  document.head.appendChild(el);
}

const store = {
  get(k, area = sessionStorage) { try { return JSON.parse(area.getItem("career:" + k)); } catch (e) { return null; } },
  set(k, v, area = sessionStorage) { try { area.setItem("career:" + k, JSON.stringify(v)); } catch (e) { /* storage off: fine */ } },
  drop(k, area = sessionStorage) { try { area.removeItem("career:" + k); } catch (e) { /* fine */ } },
};
const QCOL = { Recharge: "var(--recharge)", Explore: "var(--explore)", Unstick: "var(--unstick)", Launch: "var(--launch)" };
const money = p => p ? new Intl.NumberFormat("en-AU", { style: "currency", currency: p.currency.toUpperCase(), minimumFractionDigits: p.amount % 100 ? 2 : 0 }).format(p.amount / 100) : null;
const readingLink = id => window.location.origin + href("career/r/" + id);

// ── Routing ──────────────────────────────────────────────────────────────────
export default function CareerApp() {
  useStyles();
  const [path, setPath] = useState(routePath);
  useEffect(() => {
    const h = () => setPath(routePath());
    window.addEventListener("popstate", h);
    return () => window.removeEventListener("popstate", h);
  }, []);
  const nav = useCallback(p => { window.history.pushState(null, "", href(p)); setPath(p); window.scrollTo(0, 0); }, []);
  const m = /^career\/r\/([0-9a-f-]{36})$/.exec(path);
  useEffect(() => { document.title = m ? "Your Career Reading · Divinatey" : "Career Reading · Divinatey"; }, [m && m[1]]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (m) return <ReadingPage id={m[1]} nav={nav} />;
  if (path === "career/sample") return <SamplePage nav={nav} />;
  return <Intake nav={nav} />;
}

function Shell({ wide, nav, children }) {
  return (
    <div className="np">
      <div className={"page" + (wide ? " wide" : "")}>
        <header className="top">
          <a className="logo" href={href("career")} onClick={e => { e.preventDefault(); nav("career"); }} aria-label="new page, a career program by Vikashan: Career Reading">
            <svg width="28" height="32" viewBox="0 0 32 36" aria-hidden="true"><path d="M3 2h18l8 8v24H3z" fill="#FFFFFF" stroke="#15203B" strokeWidth="2.4" strokeLinejoin="round" /><path d="M21 2v8h8" fill="none" stroke="#15203B" strokeWidth="2.4" strokeLinejoin="round" /><rect x="7" y="19" width="17" height="6" rx="2" fill="#D4F36B" /><path d="M8 29h11" stroke="#15203B" strokeWidth="2.2" strokeLinecap="round" /></svg>
            <span><b>new page</b><small>Career Reading · with Divinatey</small></span>
          </a>
          <a className="linkbtn" href={href("")} style={{ display: "inline-flex", alignItems: "center" }}>Divinatey home</a>
        </header>
        {PREVIEW && <p className="banner noprint" style={{ marginBottom: 24 }}><span className="label">Preview</span><span>Readings are free here while we test. Nothing is charged.</span></p>}
        <main aria-live="polite">{children}</main>
        <footer className="foot">
          <span><b>Coaching, not therapy.</b> For people 18 and over. In crisis? Call Lifeline on <b>13 11 14</b>, any time. In an emergency, call <b>000</b>.</span>
          <span>This reading is for reflection. It isn't a prediction or professional advice, and AI can be wrong.</span>
        </footer>
      </div>
    </div>
  );
}

// ── The questions ────────────────────────────────────────────────────────────
const EMPTY = { compass: {}, statements: Array(8).fill(null), situation: null, satisfied: null, wellbeing: null,
  birth: { birthName: "", name: "", date: "", time: "12:00", timeUnknown: false, place: null }, cast: null, question: "", email: "" };

function Intake({ nav }) {
  const saved = store.get("intake");
  const [S, setS] = useState(() => (saved && saved.S) || EMPTY);
  const [screen, setScreen] = useState(() => (saved && saved.screen) || { name: "start" });
  const [price, setPrice] = useState(null);
  useEffect(() => { store.set("intake", { S, screen }); }, [S, screen]);
  useEffect(() => { careerConfig().then(c => setPrice(c.price)).catch(() => {}); }, []);
  const up = patch => setS(s => ({ ...s, ...patch }));
  const go = sc => { setScreen(sc); window.scrollTo(0, 0); };

  const steps = [
    ...COMPASS.map((q, n) => ({ kind: "compass", q, n, part: "How you like to work" })),
    ...STATEMENTS.map((q, n) => ({ kind: "statement", q, n, part: "Where you're at" })),
    { kind: "situation", part: "Your situation" },
    ...(asksSatisfaction(S.situation) ? [{ kind: "satisfied", part: "Your situation" }] : []),
    { kind: "wellbeing", part: "How you've been" },
  ];
  const question = i => go(i >= steps.length ? (S.wellbeing === 4 ? { name: "support", fromQuiz: true } : { name: "birth" }) : { name: "q", i });

  const sc = screen.name;
  let body;
  if (sc === "start") body = <Start price={price} onStart={() => question(0)} onSupport={() => go({ name: "support" })} onSample={() => nav("career/sample")} resume={saved && saved.screen && saved.screen.name !== "start" ? () => go(saved.screen) : null} />;
  else if (sc === "q") body = <Question step={steps[Math.min(screen.i, steps.length - 1)]} i={screen.i} total={steps.length} S={S} up={up}
    onNext={() => question(screen.i + 1)} onBack={() => screen.i === 0 ? go({ name: "start" }) : question(screen.i - 1)} />;
  else if (sc === "support") body = <Support fromQuiz={screen.fromQuiz} onContinue={() => go(screen.then || { name: "birth" })} onLater={() => go({ name: "start" })} />;
  else if (sc === "birth") body = <Birth birth={S.birth} onBack={() => question(steps.length - 1)} onNext={birth => { up({ birth }); go({ name: "cast" }); }} />;
  else if (sc === "cast") body = <Cast cast={S.cast} onCast={cast => up({ cast })} onBack={() => go({ name: "birth" })} onNext={() => go({ name: "ask" })} />;
  else if (sc === "ask") body = <Ask S={S} up={up} price={price} onBack={() => go({ name: "cast" })} nav={nav}
    onCrisis={() => go({ name: "support", fromQuiz: true, then: { name: "ask", crisisOk: true } })} crisisOk={!!screen.crisisOk}
    onStale={() => { up({ cast: null }); go({ name: "cast" }); }} />;
  return <Shell nav={nav}>{body}</Shell>;
}

function Start({ price, onStart, onSupport, onSample, resume }) {
  return (
    <section className="stack" style={{ gap: 26 }}>
      <div className="stack" style={{ gap: 12 }}><span className="label">Career Reading</span><span className="note">about 8 minutes</span>
        <h1>Your career, read <span className="hl">five ways</span>.</h1></div>
      <p>A long, personal reading about your work: how you like to work and where you're at right now, a draw cast before you ask your question, five birth charts read for your career, the next 30 days, and a 4-week plan made for you.</p>
      <ul className="ticks">
        <li>22 quick questions about how you work and how you're going</li>
        <li>Your full name at birth, and your birth date, time and place</li>
        <li>An I Ching and Tarot draw, cast and sealed before you type your question</li>
        <li>Natal and Vedic astrology, Human Design, Gene Keys and Numerology, each read on its own</li>
        <li>Your question answered, and a tailored 4-week plan, ready in about five minutes</li>
      </ul>
      {!PREVIEW && price && <p><b>{money(price)}</b> <span className="muted">for the full reading, paid once after your question. Answering the questions is free.</span></p>}
      <div className="row">
        <button className="btn" type="button" onClick={onStart}>{resume ? "Start again" : "Let's start"}</button>
        {resume && <button className="btn2" type="button" onClick={resume}>Carry on where I was</button>}
        <button className="linkbtn" type="button" onClick={onSample}>See a sample reading</button>
      </div>
      <p className="small muted">There are no right answers. Go with your first instinct. For people 18 and over. This is coaching, not therapy. If you're going through a hard time, <button className="linkbtn inline" type="button" onClick={onSupport}>support is available any time</button>.</p>
    </section>
  );
}

function Question({ step, i, total, S, up, onNext, onBack }) {
  const pick = (patch, el) => { up(patch); el.currentTarget.classList.add("on"); setTimeout(onNext, 160); };
  let body;
  if (step.kind === "compass") {
    const val = S.compass[step.q.id], sizes = [34, 26, 18, 26, 34];
    body = <>
      <h2 style={{ fontSize: 24 }}>Which is more like you?</h2>
      <div className="pair"><div><span className="label">Left</span><br />{step.q.left}</div><div><span className="label">Right</span><br />{step.q.right}</div></div>
      <div className="scale" role="radiogroup" aria-label="Where you sit between the two">
        {COMPASS_SCALE.map((t, k) => <button key={k} className={"dot" + (val === k - 2 ? " on" : "")} type="button" role="radio" aria-checked={val === k - 2}
          onClick={e => pick({ compass: { ...S.compass, [step.q.id]: k - 2 } }, e)}><i style={{ width: sizes[k], height: sizes[k] }} />{t}</button>)}
      </div>
      <p className="hint">Answer for how you naturally prefer to work, not how you have to right now.</p>
    </>;
  } else {
    const opts = step.kind === "situation" ? SITUATIONS : step.kind === "wellbeing" ? WELLBEING : LIKE;
    const cur = step.kind === "statement" ? S.statements[step.n] : step.kind === "situation" ? S.situation : step.kind === "satisfied" ? S.satisfied : S.wellbeing;
    const valueOf = k => (step.kind === "statement" || step.kind === "satisfied" ? k + 1 : k);
    const patch = v => step.kind === "statement" ? { statements: S.statements.map((x, j) => j === step.n ? v : x) }
      : step.kind === "situation" ? { situation: v, ...(asksSatisfaction(v) ? {} : { satisfied: null }) }
      : step.kind === "satisfied" ? { satisfied: v } : { wellbeing: v };
    const title = step.kind === "statement" ? step.q.text : step.kind === "situation" ? "Which fits you best right now?"
      : step.kind === "satisfied" ? "I'm satisfied with my job." : "Over the last couple of weeks, how have you been feeling overall?";
    body = <>
      {(step.kind === "statement" || step.kind === "satisfied") && <p className="label">How much is this like you right now?</p>}
      <h2>{title}</h2>
      <div className="answers">{opts.map((t, k) => <button key={t} className={"ans" + (cur === valueOf(k) ? " on" : "")} type="button" onClick={e => pick(patch(valueOf(k)), e)}>{t}</button>)}</div>
    </>;
  }
  return (
    <>
      <div className="progress"><div className="bar" aria-hidden="true"><i style={{ width: Math.round((i / total) * 100) + "%" }} /></div><span>{i + 1} of {total}</span></div>
      <section className="stack" key={i}><span className="label">{step.part}</span>{body}<div><button className="linkbtn" type="button" onClick={onBack}>Back</button></div></section>
    </>
  );
}

function Support({ fromQuiz, onContinue, onLater }) {
  return (
    <section className="stack">
      <h2>Thanks for being honest.</h2>
      <p>It sounds like things are really hard right now. Your career can wait. Talking to someone today matters more.</p>
      <div className="support stack" style={{ gap: 8 }}>
        <span>Lifeline: <b>13 11 14</b> (24/7)</span><span>Beyond Blue: <b>1300 22 4636</b></span>
        <span>13YARN: <b>13 92 76</b> (Aboriginal and Torres Strait Islander crisis support)</span><span>Emergency: <b>000</b></span>
      </div>
      <div className="row">
        {fromQuiz && <button className="btn" type="button" onClick={onContinue}>Continue to my reading</button>}
        <button className="btn2" type="button" onClick={onLater}>I'll come back later</button>
      </div>
      {fromQuiz && <p className="small muted">If you continue, your reading won't include any New Page offers.</p>}
    </section>
  );
}

function PlaceField({ value, onPick }) {
  const [q, setQ] = useState(value ? value.label : "");
  const [list, setList] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [msg, setMsg] = useState(null);
  const req = useRef(0);
  useEffect(() => {
    if (value && q === value.label) return;
    const text = q.trim();
    if (text.length < 2) { setList([]); setMsg(null); return; }
    const id = ++req.current;
    const t = setTimeout(() => {
      setMsg("Searching places…"); setOpen(true);
      findPlaces(text).then(r => { if (id === req.current) { setList(r); setActive(-1); setMsg(r.length ? null : "No places match. Try a nearby town, or check the spelling."); } })
        .catch(() => { if (id === req.current) { setList([]); setMsg("Couldn't search places just now. Try again in a moment."); } });
    }, 150);
    return () => clearTimeout(t);
  }, [q, value]);
  const pick = p => { onPick(p); setQ(p.label); setOpen(false); setList([]); };
  return (
    <div className="field">
      <label htmlFor="cplace">Birth place</label>
      <input id="cplace" value={q} autoComplete="off" placeholder="Start typing a town or city" role="combobox" aria-expanded={open && list.length > 0} aria-controls="cplace-list"
        onChange={e => { setQ(e.target.value); if (value) onPick(null); }} onFocus={() => (list.length || msg) && setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={e => {
          if (!list.length) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setActive(a => (a + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length); }
          else if (e.key === "Enter") { e.preventDefault(); pick(list[Math.max(0, active)]); }
          else if (e.key === "Escape") setOpen(false);
        }} />
      {open && (list.length > 0 || msg) && <div className="drop" id="cplace-list" role="listbox">
        {list.length ? list.map((p, i) => { const name = p.label.split(", ")[0]; return <button key={p.label + i} type="button" role="option" aria-selected={i === active} className={i === active ? "on" : ""}
          onMouseDown={e => { e.preventDefault(); pick(p); }}><b>{name}</b><span>{p.label.slice(name.length)}</span></button>; }) : <p>{msg}</p>}
      </div>}
      <span className="hint">{value ? `Timezone ${value.tz} · ${Math.abs(value.lat).toFixed(2)}°${value.lat < 0 ? "S" : "N"}, ${Math.abs(value.lon).toFixed(2)}°${value.lon < 0 ? "W" : "E"}` : "Any town of 1,000+ people. If yours isn't listed, pick the nearest one."}</span>
    </div>
  );
}

function Birth({ birth, onBack, onNext }) {
  const [b, setB] = useState(birth);
  const [err, setErr] = useState(null);
  const set = patch => setB(x => ({ ...x, ...patch }));
  const submit = e => {
    e.preventDefault();
    const e2 = !/[a-z]/i.test(b.birthName.normalize("NFD")) ? "Enter your full name at birth." : !b.date ? "Enter your birth date." : !b.place ? "Choose your birth place from the list." : null;
    if (e2) return setErr(e2);
    onNext(b);
  };
  return (
    <section className="stack">
      <span className="label">Your birth details</span><h2>Now, when and where it all started</h2>
      <p className="muted">Your charts are calculated from these. Numerology uses your full name at birth; the AI readings only ever see the resulting numbers.</p>
      <form className="stack" noValidate onSubmit={submit}>
        <div className="field"><label htmlFor="cbname">Full name at birth</label><input id="cbname" autoComplete="off" maxLength={100} value={b.birthName} onChange={e => set({ birthName: e.target.value })} placeholder="Every first, middle and last name you were given" /></div>
        <div className="field"><label htmlFor="cname">Name you use now (optional)</label><input id="cname" maxLength={60} value={b.name} onChange={e => set({ name: e.target.value })} placeholder="If it's different" /></div>
        <div className="two">
          <div className="field"><label htmlFor="cdate">Birth date</label><input id="cdate" type="date" value={b.date} onChange={e => set({ date: e.target.value })} /></div>
          <div className="field"><label htmlFor="ctime">Birth time</label><input id="ctime" type="time" value={b.time} disabled={b.timeUnknown} onChange={e => set({ time: e.target.value })} /></div>
        </div>
        <label className="check"><input type="checkbox" id="ctunk" checked={b.timeUnknown} onChange={e => set({ timeUnknown: e.target.checked })} /> I don't know my birth time</label>
        {b.timeUnknown && <p className="hint">We'll set your charts for midday and leave out what depends on the time: the rising signs, the houses and some timing.</p>}
        <PlaceField value={b.place} onPick={place => set({ place })} />
        {err && <p className="err" role="alert">{err}</p>}
        <div className="row"><button className="btn" type="submit">Next: cast your draw</button></div>
      </form>
      <div><button className="linkbtn" type="button" onClick={onBack}>Back</button></div>
    </section>
  );
}

function Cast({ cast, onCast, onBack, onNext }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const doCast = async () => {
    setBusy(true); setErr(null);
    try { onCast(await careerCast()); } catch (e) { setErr(careerErrorText(e)); }
    setBusy(false);
  };
  return (
    <section className="stack">
      <span className="label">The cast</span><h2>We cast your draw <span className="hl">before</span> you ask.</h2>
      <p>Your I Ching hexagram and seven Tarot cards are drawn from this moment, then sealed. Your question comes next, so it can't steer the cards. You'll see them in your reading, so they can't steer your question either.</p>
      <div className="card seal">
        <div className="hexa" aria-hidden="true">{Array.from({ length: 6 }, (_, k) => <i key={k} />)}</div>
        <div className="stack" style={{ gap: 10 }}>
          <div className="cards7" aria-hidden="true">{Array.from({ length: 7 }, (_, k) => <span key={k} />)}</div>
          <p className="small">{cast ? <>Sealed at <b>{new Date(cast.castAt).toLocaleTimeString()}</b>.</> : "Not cast yet."}</p>
        </div>
      </div>
      {err && <p className="err" role="alert">{err}</p>}
      <div className="row">{cast ? <button className="btn" type="button" onClick={onNext}>Next: your question</button>
        : <button className="btn" type="button" onClick={doCast} disabled={busy}>{busy ? "Casting…" : "Cast my draw"}</button>}</div>
      <div><button className="linkbtn" type="button" onClick={onBack}>Back</button></div>
    </section>
  );
}

function Ask({ S, up, price, onBack, onCrisis, crisisOk, onStale, nav }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const send = async e => {
    e.preventDefault();
    const text = S.question.trim();
    if (text.length < 10) return setErr("Write your question in a sentence or two.");
    if (!crisisOk && detectCrisis(text)) return onCrisis();
    setBusy(true); setErr(null);
    const b = S.birth;
    try {
      const r = await careerSubmit(S.cast.id, {
        person: { birthName: b.birthName, name: b.name, date: b.date, time: b.time, timeUnknown: b.timeUnknown, place: b.place.label, tz: b.place.tz, lat: b.place.lat, lon: b.place.lon },
        answers: { compass: S.compass, statements: S.statements, situation: S.situation, satisfied: S.satisfied, wellbeing: S.wellbeing },
        question: text, email: S.email.trim(),
      });
      const mine = store.get("mine", localStorage) || [];
      store.set("mine", [{ id: r.id, at: new Date().toISOString() }, ...mine.filter(x => x.id !== r.id)].slice(0, 10), localStorage);
      store.drop("intake");
      if (r.checkoutUrl) window.location.assign(r.checkoutUrl);
      else nav("career/r/" + r.id);
    } catch (e2) {
      setBusy(false);
      if (e2.code === "already_submitted" || e2.code === "wrong_mode" || e2.status === 404) return onStale();
      setErr(careerErrorText(e2));
    }
  };
  return (
    <section className="stack">
      <span className="label">Your question</span><h2>What do you want to know about your work?</h2>
      <form className="stack" noValidate onSubmit={send}>
        <div className="field"><label htmlFor="cq">Your question</label>
          <textarea id="cq" maxLength={1200} value={S.question} onChange={e => up({ question: e.target.value })} placeholder="For example: should I leave my job this year to start my own practice, or push for a bigger role where I am first?" />
          <span className="hint">Be specific. Name the decision, the options and any timing that matters.</span></div>
        <div className="field"><label htmlFor="cemail">Email me when it's ready (optional)</label>
          <input id="cemail" type="email" autoComplete="email" maxLength={254} value={S.email} onChange={e => up({ email: e.target.value })} placeholder="you@example.com" />
          <span className="hint">We only use it to send you the link to your reading.</span></div>
        {err && <p className="err" role="alert">{err}</p>}
        <div className="row"><button className="btn" type="submit" disabled={busy}>{busy ? "Sending…" : PREVIEW || !price ? "Make my reading" : `Pay ${money(price)} and make my reading`}</button></div>
        {!PREVIEW && <p className="small muted">Payment is handled by Stripe. Your reading starts as soon as it's paid.</p>}
      </form>
      <div><button className="linkbtn" type="button" onClick={onBack}>Back</button></div>
    </section>
  );
}

// ── A reading: payment, progress, the result ─────────────────────────────────
function stagesFor(p) {
  const total = (p && p.total) || 202, done = (p && p.done) || 0;
  const bounds = [["The draw, read card by card", 17], ["The draw applied to your question", 18], ["Your five charts, each on its own", total - 6], ["Across all five: profile, now, the month, your answer, your plan", total]];
  let prev = 0;
  return bounds.map(([name, end]) => { const s = { name, state: done >= end ? "done" : done >= prev ? "run" : "" }; prev = end; return s; });
}

function ReadingPage({ id, nav }) {
  const [st, setSt] = useState(null);
  const [err, setErr] = useState(null);
  const [price, setPrice] = useState(null);
  const [busy, setBusy] = useState(false);
  const checkout = new URLSearchParams(window.location.search).get("checkout");
  useEffect(() => {
    let alive = true, timer;
    const tick = async () => {
      try {
        const s = await careerStatus(id);
        if (!alive) return;
        setSt(s); setErr(null);
        const waiting = s.status === "queued" || s.status === "running" || (s.status === "awaiting_payment" && checkout === "success");
        if (waiting) timer = setTimeout(tick, 2500);
      } catch (e) {
        if (!alive) return;
        setErr(e.status === 404 ? "notfound" : careerErrorText(e));
        if (e.status !== 404) timer = setTimeout(tick, 5000);
      }
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [id, checkout]);
  useEffect(() => { if (st && st.status === "awaiting_payment") careerConfig().then(c => setPrice(c.price)).catch(() => {}); }, [st && st.status]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (st && st.status === "done") return <Shell wide nav={nav}><Report md={st.report} id={id} /></Shell>;

  let body;
  if (err === "notfound") body = <section className="stack"><h2>We can't find that reading</h2><p>Check the link, or start a new reading. Readings are kept for 90 days.</p><div><button className="btn" type="button" onClick={() => nav("career")}>Start a reading</button></div></section>;
  else if (!st) body = <section className="stack"><p className="muted">{err || "Opening your reading…"}</p></section>;
  else if (st.status === "cast") body = <section className="stack"><h2>This reading wasn't finished</h2><p>The draw was cast, but the question never arrived. Start again to make your reading.</p><div><button className="btn" type="button" onClick={() => nav("career")}>Start again</button></div></section>;
  else if (st.status === "awaiting_payment") {
    const pay = async () => { setBusy(true); try { window.location.assign(await careerCheckout(id).then(r => r.url)); } catch (e) { setErr(careerErrorText(e)); setBusy(false); } };
    body = checkout === "success"
      ? <section className="stack"><span className="note">thank you</span><h2>Confirming your payment…</h2><p className="muted">This usually takes a few seconds. Your reading starts as soon as Stripe confirms it.</p></section>
      : <section className="stack"><span className="label">Almost there</span><h2>Your answers and question are in</h2>
        <p>{checkout === "cancelled" ? "Payment was cancelled, so your reading hasn't started. " : ""}Pay once and your reading starts straight away. It takes about five minutes.</p>
        {err && <p className="err" role="alert">{err}</p>}
        <div className="row"><button className="btn" type="button" onClick={pay} disabled={busy}>{busy ? "Opening payment…" : price ? `Pay ${money(price)}` : "Pay and make my reading"}</button></div></section>;
  } else if (st.status === "failed") {
    const retry = async () => { setBusy(true); try { setSt(await careerRetry(id)); window.location.reload(); } catch (e) { setErr(careerErrorText(e)); setBusy(false); } };
    body = <section className="stack"><h2>Your reading didn't finish</h2><p>Part of the writing failed, so we stopped rather than give you a reading with gaps. Your answers and the parts already written are kept. Try again, and if it fails twice, email us with this link.</p>
      {err && <p className="err" role="alert">{err}</p>}
      <div className="row"><button className="btn" type="button" onClick={retry} disabled={busy}>{busy ? "Starting…" : "Try again"}</button></div><CopyLink id={id} /></section>;
  } else {
    const p = st.progress, pct = p && p.total ? Math.round((p.done / p.total) * 100) : 0;
    body = <section className="stack">
      <span className="note">writing it now</span><span className="label">Making your reading</span>
      <h2>{p ? `${p.done} of ${p.total} pieces written` : "Starting your reading…"}</h2>
      <div className="meter" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Reading progress"><div className="bar"><i style={{ width: pct + "%" }} /></div></div>
      <ul className="stages">{stagesFor(p).map(s => <li key={s.name} className={s.state}><span className="st" aria-hidden="true" /><span>{s.name}</span></li>)}</ul>
      <p className="muted">Every section is written in its own request, from only what that section may see. It takes about five minutes. You can close this page: {st.email ? "we'll email you the link when it's ready, and " : ""}the link below always opens your reading.</p>
      <CopyLink id={id} />
    </section>;
  }
  return <Shell nav={nav}>{body}</Shell>;
}

function CopyLink({ id }) {
  const [done, setDone] = useState(false);
  const link = readingLink(id);
  const copy = () => navigator.clipboard.writeText(link).then(() => { setDone(true); setTimeout(() => setDone(false), 2000); }, () => {});
  return <div className="stack" style={{ gap: 6 }}><span className="label">Your private link</span>
    <div className="copy"><code>{link}</code><button className="btn2" type="button" onClick={copy}>{done ? "Copied" : "Copy link"}</button></div>
    <span className="hint">Anyone with this link can open your reading, so keep it to yourself.</span></div>;
}

function SamplePage({ nav }) {
  const [md, setMd] = useState(null);
  useEffect(() => { import("../../docs/career-reading/sample/report.md?raw").then(m => setMd(m.default)); }, []);
  return <Shell wide nav={nav}>{md ? <Report md={md} sample onStart={() => nav("career")} /> : <p className="muted">Opening the sample…</p>}</Shell>;
}

// ── The finished reading ─────────────────────────────────────────────────────
function Report({ md, id, sample, onStart }) {
  const ref = useRef(null);
  const [heads, setHeads] = useState([]);
  const [cur, setCur] = useState(0);
  const html = marked.parse(md, { gfm: true, headerIds: false, mangle: false });
  const wideScreen = typeof window !== "undefined" && window.matchMedia("(min-width: 981px)").matches;
  useEffect(() => {
    const el = ref.current;
    el.querySelectorAll("table").forEach(t => { if (t.parentNode.classList.contains("tablewrap")) return; const w = document.createElement("div"); w.className = "tablewrap"; t.parentNode.insertBefore(w, t); w.appendChild(t); });
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), hits = [];
    while (walk.nextNode()) if (/[▲●]/.test(walk.currentNode.nodeValue)) hits.push(walk.currentNode);
    const escText = s => s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    hits.forEach(n => { const span = document.createElement("span"); span.innerHTML = escText(n.nodeValue).replace(/▲/g, '<span class="mk trad" title="Traditionally read for career">▲</span>').replace(/●/g, '<span class="mk pers" title="Stands out in this chart">●</span>'); n.replaceWith(span); });
    const key = "ticks:" + (id || "sample"), saved = store.get(key, localStorage) || {};
    el.querySelectorAll('li input[type="checkbox"]').forEach((cb, i) => {
      cb.disabled = false; cb.checked = !!saved[i]; cb.closest("li").classList.add("task");
      cb.setAttribute("aria-label", "Done: " + cb.closest("li").textContent.trim().slice(0, 60));
      cb.onchange = () => { saved[i] = cb.checked; store.set(key, saved, localStorage); };
    });
    const hs = [...el.querySelectorAll("h2")];
    hs.forEach((h, i) => { h.id = "s" + i; });
    setHeads(hs.map(h => h.textContent));
    const io = new IntersectionObserver(es => es.forEach(en => { if (en.isIntersecting) setCur(Number(en.target.id.slice(1))); }), { rootMargin: "0px 0px -75% 0px" });
    hs.forEach(h => io.observe(h));
    return () => io.disconnect();
  }, [md, id]);
  return (
    <div className="reader">
      <nav className="toc" aria-label="Contents"><details open={wideScreen}>
        <summary className="label">Contents</summary>
        {heads.map((h, i) => <a key={i} href={"#s" + i} className={i === cur ? "cur" : ""} onClick={e => { e.preventDefault(); document.getElementById("s" + i).scrollIntoView({ behavior: "smooth" }); }}>{h}</a>)}
      </details>
        <div className="legend"><span><span className="mk trad">▲</span> traditionally read for career</span><span><span className="mk pers">●</span> stands out in this chart</span></div>
      </nav>
      <article className="md">
        {sample && <div className="banner"><span className="label">Sample reading</span><span>Jordan Park is fictional. The charts, the draw and the dates are calculated; the writing tests the format.</span>
          <span><button className="linkbtn inline" type="button" onClick={onStart}>Make your own reading</button></span></div>}
        <div className="tools">
          <button className="btn2" type="button" onClick={() => window.print()}>Download PDF</button>
          {id && <a className="btn2" href={careerReportUrl(id)} download="career-reading.md">Download Markdown</a>}
          <span className="hint">For a PDF, choose "Save as PDF" in the print window.</span>
        </div>
        {id && <div className="noprint"><CopyLink id={id} /></div>}
        <div ref={ref} dangerouslySetInnerHTML={{ __html: html }} />
      </article>
    </div>
  );
}
