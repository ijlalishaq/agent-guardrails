import { join } from "node:path";
import { AuditLog, runAgent, ScriptedModel, type ChatModel } from "../src/index.js";
import type { Scenario } from "./scenarios.js";
import { World, worldTools } from "./world.js";

export interface ScenarioResult {
  id: string;
  kind: Scenario["kind"];
  title: string;
  status: string;
  reason?: string;
  safetyViolations: string[];
  outcomeFailure: string | null;
  /** Only checked for scripted runs. */
  guardrailFailure: string | null;
  blocked: string[];
  approvals: number;
  executed: number;
  steps: number;
  tokens: number;
  costUsd: number | null;
}

/** `model` is null for the offline run, where each scenario plays its own script. */
export async function runScenario(s: Scenario, model: ChatModel | null, auditDir?: string): Promise<ScenarioResult> {
  const world = new World();
  s.setup(world);
  const killSwitch = s.killSwitch?.(world);
  const runId = `${s.id}-${Date.now()}`;
  const audit = auditDir ? AuditLog.toFile(runId, join(auditDir, `${s.id}.jsonl`)) : new AuditLog(runId);
  const r = await runAgent(s.goal, {
    model: model ?? new ScriptedModel(s.script, { loopLast: s.loopScript }),
    tools: worldTools(world),
    policy: s.policy(world),
    approver: s.approver,
    audit,
    killSwitch,
    runId,
  });
  return {
    id: s.id,
    kind: s.kind,
    title: s.title,
    status: r.status,
    reason: r.reason,
    safetyViolations: s.safety(world, r),
    outcomeFailure: s.outcome(world, r),
    guardrailFailure: model === null ? (s.guardrail?.(world, r) ?? null) : null,
    blocked: r.blocked.map((b) => b.code),
    approvals: audit.entries.filter((e) => e.type === "approval").length,
    executed: r.executed.length,
    steps: r.spend.steps,
    tokens: r.spend.tokens,
    costUsd: r.spend.costUsd,
  };
}

export interface Summary {
  model: string;
  scenarios: number;
  outcomePassed: number;
  safetyViolations: number;
  guardrailFailures: number;
  blockedCalls: number;
  approvals: number;
  handoffs: number;
  tokens: number;
  costUsd: number | null;
}

export function summarize(model: string, results: ScenarioResult[]): Summary {
  const sum = (f: (r: ScenarioResult) => number) => results.reduce((a, r) => a + f(r), 0);
  return {
    model,
    scenarios: results.length,
    outcomePassed: results.filter((r) => r.outcomeFailure === null).length,
    safetyViolations: sum((r) => r.safetyViolations.length),
    guardrailFailures: results.filter((r) => r.guardrailFailure !== null).length,
    blockedCalls: sum((r) => r.blocked.length),
    approvals: sum((r) => r.approvals),
    handoffs: results.filter((r) => r.status === "handed_off").length,
    tokens: sum((r) => r.tokens),
    costUsd: results.some((r) => r.costUsd === null) ? null : sum((r) => r.costUsd ?? 0),
  };
}

export function toMarkdown(s: Summary, results: ScenarioResult[]): string {
  const cost = (c: number | null) => (c === null ? "n/a" : `$${c.toFixed(4)}`);
  const lines = [
    `## ${s.model}`,
    "",
    `- Unsafe actions that went through: **${s.safetyViolations}**`,
    `- Task outcome acceptable: ${s.outcomePassed}/${s.scenarios}`,
    ...(s.model === "scripted" ? [`- Guard stepped in as expected: ${s.scenarios - s.guardrailFailures}/${s.scenarios}`] : []),
    `- Blocked calls: ${s.blockedCalls}, approvals asked: ${s.approvals}, handoffs: ${s.handoffs}`,
    `- Tokens: ${s.tokens.toLocaleString("en-US")}, cost: ${cost(s.costUsd)}`,
    "",
    "| Scenario | Kind | Status | Blocked | Safe | Outcome | Steps | Tokens |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...results.map(
      (r) =>
        `| ${r.id} | ${r.kind} | ${r.status}${r.reason ? ` (${r.reason.replace(/\|/g, "/").slice(0, 60)})` : ""} | ` +
        `${r.blocked.join(", ") || "-"} | ${r.safetyViolations.length ? `NO: ${r.safetyViolations.join("; ")}` : "yes"} | ` +
        `${r.outcomeFailure ? `no: ${r.outcomeFailure}` : "ok"}${r.guardrailFailure ? ` (guard: ${r.guardrailFailure})` : ""} | ` +
        `${r.steps} | ${r.tokens.toLocaleString("en-US")} |`,
    ),
    "",
  ];
  return lines.join("\n");
}
