// Runs the Career Reading pipeline from the command line.
//
//   node scripts/career-reading.mjs <input.json> [--out report.md] [--dossier dossier.md]
//        [--answers answers.json] [--save outputs.json] [--full-items]
//
// With ANTHROPIC_API_KEY set (and no --answers), every step calls Claude.
// With --answers, step outputs come from that file instead (missing ones are
// marked as pending in the report). --dossier writes every step's exact
// prompt, so you can check what each one was and wasn't given.
import fs from "node:fs";
import { prepare, buildSteps, runSteps, answersRunner, apiRunner } from "../server/career/pipeline.js";
import { renderMarkdown } from "../server/career/render.js";

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const inputFile = args.find(a => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--"));
if (!inputFile) { console.error("usage: node scripts/career-reading.mjs <input.json> [--out report.md] [--dossier dossier.md] [--answers answers.json] [--save outputs.json]"); process.exit(1); }

const ctx = prepare(JSON.parse(fs.readFileSync(inputFile, "utf8")));
const steps = buildSteps(ctx, { fullItems: args.includes("--full-items") });
const by = steps.reduce((a, s) => (a[s.stage] = (a[s.stage] || 0) + 1, a), {});
console.log(`${steps.length} steps (A ${by.A || 0} · B ${by.B || 0} · C ${by.C || 0} · D ${by.D || 0}); ${steps.filter(s => s.model === "quick").length} on the fast model`);

const dossier = flag("--dossier");
if (dossier) {
  fs.writeFileSync(dossier, `# Step dossier\n\nEvery AI step, with exactly what it is given. ${steps.length} steps.\n\n` + steps.map(s =>
    `## \`${s.id}\` · stage ${s.stage} · ${s.model} model\n\n**System:** ${s.system}\n\n**Returns:** ${Object.keys(s.schema.properties).join(", ")}\n\n\`\`\`text\n${s.user}\n\`\`\`\n`).join("\n"));
  console.log("dossier →", dossier);
}

let runner;
if (flag("--answers")) runner = answersRunner(JSON.parse(fs.readFileSync(flag("--answers"), "utf8")));
else if (process.env.ANTHROPIC_API_KEY) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  runner = apiRunner(new Anthropic(), {
    model: process.env.ANTHROPIC_MODEL || "claude-opus-5-5",
    quickModel: process.env.ANTHROPIC_QUICK_MODEL || "claude-haiku-5-5",
    effort: process.env.ORACLE_EFFORT || "low",
  });
} else { console.log("No ANTHROPIC_API_KEY and no --answers: rendering the calculated parts only."); runner = answersRunner({}); }

const t0 = Date.now();
const out = await runSteps(steps, runner, { onProgress: ({ done, total }) => { if (done % 20 === 0 || done === total) process.stdout.write(`  ${done}/${total}\r`); } });
console.log(`\nran in ${((Date.now() - t0) / 1000).toFixed(1)} s; ${Object.values(out).filter(o => o.error).length} errors, ${Object.values(out).filter(o => o.pending).length} pending`);
if (flag("--save")) fs.writeFileSync(flag("--save"), JSON.stringify(out, null, 2));
const md = renderMarkdown(ctx, out);
fs.writeFileSync(flag("--out") || "career-reading.md", md);
console.log("report →", flag("--out") || "career-reading.md", `(${md.split(/\s+/).length} words)`);
