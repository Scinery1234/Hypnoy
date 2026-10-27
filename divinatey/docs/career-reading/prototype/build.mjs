// Builds the Career Reading prototype page (index.html) from template.html:
// inlines the real quiz scoring, casting and New Page content from the
// server code, the sample report, and the sample's real step counts.
//   node docs/career-reading/prototype/build.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepare, buildSteps, SYSTEM_ORDER } from "../../../server/career/pipeline.js";

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.join(here, "../../..");
const src = f => fs.readFileSync(path.join(root, f), "utf8").replace(/^export /gm, "").replace(/^import .*$/gm, "");
const engine = ["shared/oracle.js", "shared/safety.js", "server/career/quiz.js", "server/career/content.js"].map(src).join("\n");

const sample = path.join(here, "../sample");
const ctx = prepare(JSON.parse(fs.readFileSync(path.join(sample, "input.json"), "utf8")));
const steps = buildSteps(ctx);
const count = f => steps.filter(f).length;
const counts = {
  A: count(s => s.stage === "A"), B: count(s => s.stage === "B"), D: count(s => s.stage === "D"),
  sys: Object.fromEntries(SYSTEM_ORDER.map(k => [k, count(s => s.system === k)])),
  items: Object.fromEntries(SYSTEM_ORDER.map(k => [k, ctx.systems[k].tabs.reduce((a, t) => a + t.items.length, 0)])),
  overviews: Object.fromEntries(SYSTEM_ORDER.map(k => [k, ctx.systems[k].tabs.filter(t => t.overviewPrompt).length])),
  labels: Object.fromEntries(SYSTEM_ORDER.map(k => [k, ctx.systems[k].label])),
};
const safe = s => JSON.stringify(s).replace(/</g, "\\u003c");
const html = fs.readFileSync(path.join(here, "template.html"), "utf8")
  .replace("/*__ENGINE__*/", () => engine.replace(/<\/script/gi, "<\\/script"))
  .replace('/*__REPORT__*/""', () => safe(fs.readFileSync(path.join(sample, "report.md"), "utf8")))
  .replace("/*__STEPS__*/{}", () => safe(counts));
fs.writeFileSync(path.join(here, "index.html"), html);
console.log("index.html", (html.length / 1024).toFixed(0) + " KB", counts);
