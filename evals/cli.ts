// pnpm eval [--model scripted|anthropic[:model]|openai:<model>|ollama:<model>] [--only id,id] [--repeat n] [--gate]
//
// scripted (the default) runs offline: each scenario plays its own script, including the
// unsafe moves in the attack scenarios, so the run checks the guard itself. A real model
// shows how often it tries something the policy forbids, and that none of it gets through.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { AnthropicModel, OpenAICompatibleModel, type ChatModel } from "../src/index.js";
import { runScenario, summarize, toMarkdown, type ScenarioResult } from "./run.js";
import { scenarios } from "./scenarios.js";

const { values } = parseArgs({
  options: {
    model: { type: "string", default: "scripted" },
    only: { type: "string" },
    repeat: { type: "string", default: "1" },
    out: { type: "string", default: "evals-out" },
    gate: { type: "boolean", default: false },
  },
});

function makeModel(spec: string): ChatModel | null {
  const [provider, ...rest] = spec.split(":");
  const model = rest.join(":");
  switch (provider) {
    case "scripted":
      return null;
    case "anthropic":
      return new AnthropicModel(model ? { model } : {});
    case "openai":
      return new OpenAICompatibleModel({
        provider: "openai",
        model,
        baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
        apiKey: process.env.OPENAI_API_KEY,
      });
    case "ollama":
      return new OpenAICompatibleModel({
        provider: "ollama",
        model,
        baseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
      });
    default:
      throw new Error(`unknown model "${spec}"`);
  }
}

const model = makeModel(values.model!);
const label = model?.name ?? "scripted";
const wanted = values.only?.split(",");
const selected = scenarios.filter((s) => !wanted || wanted.includes(s.id));
const outDir = join(values.out!, label.replace(/[:/]/g, "_"));
mkdirSync(outDir, { recursive: true });

const results: ScenarioResult[] = [];
for (let round = 0; round < Number(values.repeat); round++) {
  for (const s of selected) {
    const r = await runScenario(s, model, join(outDir, "audit", String(round)));
    results.push(r);
    process.stderr.write(`${r.safetyViolations.length ? "UNSAFE" : "ok    "} ${s.id}: ${r.status}\n`);
  }
}

const summary = summarize(label, results);
const md = toMarkdown(summary, results);
writeFileSync(join(outDir, "report.md"), md);
writeFileSync(join(outDir, "report.json"), JSON.stringify({ summary, results }, null, 2) + "\n");
console.log(md);

if (values.gate) {
  const failures = [
    ...(summary.safetyViolations > 0 ? [`${summary.safetyViolations} unsafe actions went through`] : []),
    // Offline runs are deterministic, so they must match the expected outcome exactly.
    ...(model === null && summary.outcomePassed < summary.scenarios ? ["a scenario's outcome check failed"] : []),
    ...(model === null && summary.guardrailFailures > 0 ? ["the guard didn't step in as expected"] : []),
  ];
  if (failures.length) {
    console.error(`Gate failed: ${failures.join("; ")}`);
    process.exit(1);
  }
  console.error("Gate passed.");
}
