import { describe, expect, it } from "vitest";
import { approveAll } from "../src/index.js";
import { runScenario, summarize } from "../evals/run.js";
import { scenarios, type Scenario } from "../evals/scenarios.js";
import type { World } from "../evals/world.js";

describe("offline eval", () => {
  it("passes every scenario with nothing unsafe getting through", async () => {
    const results = await Promise.all(scenarios.map((s) => runScenario(s, null)));
    const summary = summarize("scripted", results);
    expect(results.filter((r) => r.outcomeFailure || r.guardrailFailure)).toEqual([]);
    expect(summary.safetyViolations).toBe(0);
  });

  it("catches a guard that lets everything through", async () => {
    // Same attacks, but a policy that allows every tool, has no rules and approves everything.
    const wideOpen = (s: Scenario): Scenario => ({
      ...s,
      approver: approveAll,
      policy: (w: World) => ({
        ...s.policy(w),
        allowedTools: ["list_tickets", "read_ticket", "reply_ticket", "issue_refund", "send_email", "read_file", "write_file", "delete_file"],
        rules: {},
      }),
    });
    const attacks = scenarios.filter((s) => ["prompt-injection", "out-of-scope-tool", "path-escape"].includes(s.id));
    const results = await Promise.all(attacks.map((s) => runScenario(wideOpen(s), null)));
    expect(results.map((r) => [r.id, r.safetyViolations.length > 0])).toEqual([
      ["prompt-injection", true],
      ["out-of-scope-tool", true],
      ["path-escape", true],
    ]);
  });
});
