import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  approveAll,
  AuditLog,
  defineTool,
  HANDOFF_TOOL,
  KillSwitch,
  runAgent,
  ScriptedModel,
  verifyChain,
  type Policy,
} from "../src/index.js";

function setup() {
  const sent: string[] = [];
  const tools = [
    defineTool({
      name: "lookup",
      description: "Look up an order",
      effect: "read",
      input: z.object({ id: z.string() }),
      run: (i) => ({ id: i.id, total: 30 }),
    }),
    defineTool({
      name: "email",
      description: "Email the customer",
      effect: "write",
      input: z.object({ text: z.string() }),
      run: (i) => {
        sent.push(i.text);
        return "sent";
      },
    }),
  ];
  const policy: Policy = {
    task: "answer order questions",
    owner: "support-lead",
    allowedTools: ["lookup", "email"],
    budgets: { maxSteps: 5, maxToolCalls: 5 },
    maxBlockedCalls: 2,
  };
  return { sent, tools, policy };
}

describe("runAgent", () => {
  it("runs tool calls the guard allows and finishes", async () => {
    const { sent, tools, policy } = setup();
    const model = new ScriptedModel([
      { call: [{ name: "lookup", input: { id: "A1" } }] },
      (results) => ({ call: [{ name: "email", input: { text: `Your total is ${JSON.parse(results[0]!.content).total}` } }] }),
      { say: "Replied to the customer." },
    ]);
    const r = await runAgent("Where is order A1?", { model, tools, policy, approver: approveAll });
    expect(r.status).toBe("completed");
    expect(r.finalText).toBe("Replied to the customer.");
    expect(sent).toEqual(["Your total is 30"]);
    expect(r.executed.map((e) => e.tool)).toEqual(["lookup", "email"]);
    expect(r.spend.steps).toBe(3);
  });

  it("never runs a denied write and reports the block to the model", async () => {
    const { sent, tools, policy } = setup();
    const model = new ScriptedModel([{ call: [{ name: "email", input: { text: "hi" } }] }, { say: "Couldn't email." }]);
    const r = await runAgent("Email them", { model, tools, policy }); // default approver denies
    expect(sent).toEqual([]);
    expect(r.blocked).toEqual([{ tool: "email", code: "approval_denied", reason: expect.any(String) }]);
    expect(r.status).toBe("completed");
  });

  it("hands off after too many blocked calls", async () => {
    const { tools, policy } = setup();
    const model = new ScriptedModel([{ call: [{ name: "refund", input: {} }] }], { loopLast: true });
    const r = await runAgent("Refund them", { model, tools, policy });
    expect(r.status).toBe("handed_off");
    expect(r.blocked).toHaveLength(2);
    expect(r.reason).toMatch(/2 tool calls were blocked/);
  });

  it("hands off when the agent asks to", async () => {
    const { tools, policy } = setup();
    const model = new ScriptedModel([
      { call: [{ name: HANDOFF_TOOL, input: { reason: "customer wants a manager" } }, { name: "lookup", input: { id: "B" } }] },
    ]);
    const r = await runAgent("Help", { model, tools, policy });
    expect(r).toMatchObject({ status: "handed_off", reason: "customer wants a manager" });
    expect(r.executed).toEqual([]); // calls after the handoff in the same turn are skipped
  });

  it("stops a runaway loop at the step budget", async () => {
    const { tools, policy } = setup();
    const model = new ScriptedModel([{ call: [{ name: "lookup", input: { id: "A1" } }] }], { loopLast: true });
    const r = await runAgent("Loop", { model, tools, policy: { ...policy, budgets: { maxSteps: 3, maxToolCalls: 99 } } });
    expect(r).toMatchObject({ status: "stopped", reason: "budget: 3 model calls used" });
  });

  it("stops between calls when a stop file appears", async () => {
    const { tools, policy } = setup();
    const stopFile = join(mkdtempSync(join(tmpdir(), "guard-")), "STOP");
    const model = new ScriptedModel([
      () => {
        writeFileSync(stopFile, ""); // someone hits the switch while the model is thinking
        return { call: [{ name: "lookup", input: { id: "A1" } }] };
      },
    ]);
    const r = await runAgent("Go", { model, tools, policy, killSwitch: new KillSwitch(stopFile) });
    expect(r.status).toBe("stopped");
    expect(r.executed).toEqual([]);
    expect(r.blocked[0]?.code).toBe("killed");
  });

  it("leaves an audit trail whose hash chain detects edits", async () => {
    const { tools, policy } = setup();
    const audit = new AuditLog("r1");
    const model = new ScriptedModel([{ call: [{ name: "lookup", input: { id: "A1" } }] }, { say: "ok" }]);
    await runAgent("Check A1", { model, tools, policy, audit });
    expect(audit.entries.map((e) => e.type)).toEqual(["run_started", "model_call", "decision", "tool_result", "model_call", "run_finished"]);
    expect(verifyChain(audit.entries)).toEqual({ ok: true });

    const tampered = audit.entries.map((e) => ({ ...e, data: { ...e.data } }));
    tampered[2]!.data.tool = "something_else";
    expect(verifyChain(tampered)).toEqual({ ok: false, brokenAt: 2 });
    expect(verifyChain(audit.entries.filter((_, i) => i !== 3))).toEqual({ ok: false, brokenAt: 3 });
  });

  it("stops cleanly when the model call fails", async () => {
    const { tools, policy } = setup();
    const audit = new AuditLog("r2");
    const model = { name: "broken", complete: async () => { throw new Error("overloaded"); } };
    const r = await runAgent("Go", { model, tools, policy, audit });
    expect(r).toMatchObject({ status: "stopped", reason: "model error: overloaded" });
    expect(audit.entries.at(-1)?.type).toBe("run_finished");
  });

  it("doesn't run tool calls from a turn cut off by the output limit", async () => {
    const { sent, tools, policy } = setup();
    const model = {
      name: "scripted",
      complete: async () => ({
        text: "",
        toolCalls: [{ id: "c1", name: "email", input: { text: "Dear cust" } }],
        usage: { inputTokens: 10, outputTokens: 10 },
        stop: "max_tokens" as const,
      }),
    };
    const r = await runAgent("Email them", { model, tools, policy, approver: approveAll });
    expect(r).toMatchObject({ status: "stopped", reason: "the model hit its output limit" });
    expect(sent).toEqual([]);
  });

  it("cuts long tool output before the model sees it", async () => {
    const { policy } = setup();
    const big = defineTool({ name: "lookup", description: "", effect: "read", input: z.object({}), run: () => "x".repeat(500) });
    let seen = "";
    const model = new ScriptedModel([
      { call: [{ name: "lookup", input: {} }] },
      (results) => ((seen = results[0]!.content), { say: "done" }),
    ]);
    await runAgent("Go", { model, tools: [big], policy, maxResultChars: 100 });
    expect(seen).toBe(`${"x".repeat(100)}\n[cut: 400 more characters]`);
  });
});
