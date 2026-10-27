// Career Reading routes, end to end: the real server writes a whole reading
// against a fake Anthropic API that answers every step with schema-shaped JSON.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import { spawn } from "node:child_process";

const sample = JSON.parse(fs.readFileSync(new URL("../docs/career-reading/sample/input.json", import.meta.url)));
const calls = [], mails = [];
let mock, mail, server, base;

// A value that satisfies a JSON schema, tagged so we can find it in the report.
const fill = (schema, tag) => schema.type === "object" ? Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, fill(v, tag + "." + k)]))
  : schema.type === "array" ? Array.from({ length: 7 }, () => fill(schema.items, tag)) : schema.type === "integer" ? 1 : "OUT<" + tag + ">";

before(async () => {
  mock = http.createServer((req, res) => {
    let data = "";
    req.on("data", c => data += c);
    req.on("end", () => {
      const body = JSON.parse(data);
      calls.push(body);
      const schema = body.output_config.format.schema;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: body.model, usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(fill(schema, "s")) }] }));
    });
  });
  mail = http.createServer((req, res) => { let d = ""; req.on("data", c => d += c); req.on("end", () => { mails.push(JSON.parse(d)); res.end("{}"); }); });
  await new Promise(r => mock.listen(0, r));
  await new Promise(r => mail.listen(0, r));
  const port = 23000 + Math.floor(Math.random() * 1000);
  base = "http://localhost:" + port;
  const env = { ...process.env, PORT: String(port), ANTHROPIC_API_KEY: "test", ANTHROPIC_BASE_URL: "http://localhost:" + mock.address().port,
    CAREER_RETRY_MS: "0", PUBLIC_URL: "https://divinatey.test", RESEND_API_KEY: "re_test", MAIL_FROM: "Divinatey <hello@divinatey.test>",
    RESEND_API_BASE: "http://localhost:" + mail.address().port };
  for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY", "STRIPE_SECRET_KEY"]) delete env[k];
  server = spawn(process.execPath, ["server/index.js"], { env, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise(r => server.stdout.on("data", r));
});
after(() => { server.kill(); mock.close(); mail.close(); });

const call = (method, path, body, preview = true) => fetch(base + path, {
  method, headers: { "content-type": "application/json", ...(preview ? { "x-paid-preview": "1" } : {}) }, body: body ? JSON.stringify(body) : undefined,
}).then(async r => ({ status: r.status, body: r.headers.get("content-type").includes("json") ? await r.json() : await r.text(), headers: r.headers }));
const submission = (extra = {}) => ({ person: sample.person, answers: sample.answers, question: sample.question.text, email: "jordan@example.com", ...extra });

test("cast, then submit, then the reading is written in the background and emailed", async () => {
  const cast = await call("POST", "/api/career/cast");
  assert.equal(cast.status, 200);
  assert.match(cast.body.id, /^[0-9a-f-]{36}$/);
  const sealed = await call("GET", "/api/career/readings/" + cast.body.id);
  assert.deepEqual(Object.keys(sealed.body).sort(), ["castAt", "id", "preview", "status"], "nothing about the cards before the question");

  assert.equal((await call("POST", "/api/career/readings/" + cast.body.id, submission({ question: "short" }))).body.error, "question_too_short");
  assert.equal((await call("POST", "/api/career/readings/" + cast.body.id, submission({ email: "nope" }))).body.error, "invalid_email");
  assert.equal((await call("POST", "/api/career/readings/" + cast.body.id, submission({ answers: { ...sample.answers, statements: [1] } }))).status, 400);
  assert.equal((await call("POST", "/api/career/readings/" + cast.body.id, submission(), false)).body.error, "wrong_mode");

  const sub = await call("POST", "/api/career/readings/" + cast.body.id, submission());
  assert.equal(sub.status, 200);
  assert.equal(sub.body.status, "queued");
  assert.equal((await call("POST", "/api/career/readings/" + cast.body.id, submission())).body.error, "already_submitted");

  let st;
  for (let i = 0; i < 120; i++) {
    st = (await call("GET", "/api/career/readings/" + cast.body.id)).body;
    if (st.status === "done" || st.status === "failed") break;
    await new Promise(r => setTimeout(r, 250));
  }
  assert.equal(st.status, "done");
  assert.equal(st.progress.done, st.progress.total);
  assert.ok(st.progress.total > 150);
  assert.match(st.report, /## 14\. Your tailored 4-week plan: Unstick/);
  assert.match(st.report, /OUT<s\.short>/, "the answer step's output is in the report");
  const gaps = st.report.match(/.*(Not generated yet|couldn.t be written).*/g);
  assert.equal(gaps, null, String(gaps));
  assert.ok(!calls.some(c => JSON.stringify(c).includes("Elise")), "the birth name never reaches the API");

  const md = await call("GET", "/api/career/readings/" + cast.body.id + "/report.md");
  assert.equal(md.status, 200);
  assert.match(md.headers.get("content-disposition"), /attachment/);
  assert.equal(md.body, st.report);

  for (let i = 0; i < 20 && !mails.length; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(mails[0].to[0], "jordan@example.com");
  assert.match(mails[0].text, /https:\/\/divinatey\.test\/preview\/career\/r\/[0-9a-f-]{36}/);
});

test("unknown readings, and payment without Stripe", async () => {
  assert.equal((await call("GET", "/api/career/readings/not-an-id")).status, 404);
  assert.equal((await call("GET", "/api/career/readings/00000000-0000-4000-8000-000000000000")).status, 404);
  const cast = await call("POST", "/api/career/cast", null, false);
  const sub = await call("POST", "/api/career/readings/" + cast.body.id, submission(), false);
  assert.equal(sub.status, 503);
  assert.equal(sub.body.error, "billing_off");
  assert.equal((await call("GET", "/api/career/config", null, false)).body.billing, false);
});
