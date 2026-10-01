import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  approveAll,
  approveWhen,
  AuditLog,
  defineTool,
  denyAll,
  Guard,
  KillSwitch,
  toolSpec,
  type Policy,
} from "../src/index.js";

const ledger: { to: string; amount: number }[] = [];

const tools = [
  defineTool({
    name: "get_balance",
    description: "Read the balance",
    effect: "read",
    input: z.object({}),
    run: () => 100,
  }),
  defineTool({
    name: "pay",
    description: "Send money",
    effect: "write",
    input: z.object({ to: z.string(), amount: z.number().positive() }),
    run: (i) => ledger.push(i),
  }),
  defineTool({
    name: "delete_account",
    description: "Delete the account",
    effect: "write",
    input: z.object({}),
    run: () => "deleted",
  }),
];

const policy = (over: Partial<Policy> = {}): Policy => ({
  task: "pay the invoice",
  owner: "ops@example.com",
  allowedTools: ["get_balance", "pay"],
  rules: { pay: [(i) => (i.amount > 50 ? `amount ${i.amount} is over the 50 limit` : null)] },
  budgets: { maxSteps: 10, maxToolCalls: 3 },
  maxBlockedCalls: 3,
  ...over,
});

const guard = (over: Partial<Policy> = {}, approver = approveAll, kill?: KillSwitch) =>
  new Guard(policy(over), tools, approver, new AuditLog("run-1"), kill);

describe("Guard", () => {
  it("lets a read call through without asking anyone", async () => {
    const d = await guard({}, denyAll).check({ id: "1", name: "get_balance", input: {} });
    expect(d).toMatchObject({ allowed: true });
  });

  it("blocks tools the agent doesn't have and tools outside the task", async () => {
    const g = guard();
    expect(await g.check({ id: "1", name: "rm_rf", input: {} })).toMatchObject({ allowed: false, code: "unknown_tool" });
    expect(await g.check({ id: "2", name: "delete_account", input: {} })).toMatchObject({
      allowed: false,
      code: "out_of_scope",
    });
  });

  it("rejects arguments that don't match the schema", async () => {
    const d = await guard().check({ id: "1", name: "pay", input: { to: "acme", amount: -5 } });
    expect(d).toMatchObject({ allowed: false, code: "invalid_args" });
  });

  it("applies argument rules before asking for approval", async () => {
    let asked = 0;
    const counting = { decide: async () => (asked++, { approved: true, by: "test" }) };
    const d = await guard({}, counting).check({ id: "1", name: "pay", input: { to: "acme", amount: 500 } });
    expect(d).toMatchObject({ allowed: false, code: "rule" });
    expect(asked).toBe(0);
  });

  it("asks before write calls and blocks a denied one", async () => {
    const g = guard({}, approveWhen((r) => (r.input as { to: string }).to === "acme"));
    expect(await g.check({ id: "1", name: "pay", input: { to: "acme", amount: 20 } })).toMatchObject({
      allowed: true,
      approvedBy: "rule",
    });
    expect(await g.check({ id: "2", name: "pay", input: { to: "mallory", amount: 20 } })).toMatchObject({
      allowed: false,
      code: "approval_denied",
    });
  });

  it("only counts calls it let through against the tool budget", async () => {
    const g = guard({ budgets: { maxSteps: 10, maxToolCalls: 2 } });
    await g.check({ id: "x", name: "delete_account", input: {} }); // blocked, not counted
    await g.check({ id: "1", name: "get_balance", input: {} });
    await g.check({ id: "2", name: "get_balance", input: {} });
    expect(await g.check({ id: "3", name: "get_balance", input: {} })).toMatchObject({ allowed: false, code: "budget" });
  });

  it("stops on step, token and cost budgets", () => {
    const g = guard({ budgets: { maxSteps: 2, maxToolCalls: 5, maxTokens: 1000, maxCostUsd: 0.01 } });
    expect(g.beforeModelCall()).toBeNull();
    g.recordModelCall(600, 0.004);
    g.recordModelCall(600, 0.004);
    expect(g.beforeModelCall()).toMatch(/budget: 2 model calls/);

    const tokens = guard({ budgets: { maxSteps: 9, maxToolCalls: 5, maxTokens: 1000 } });
    tokens.recordModelCall(1200, null);
    expect(tokens.beforeModelCall()).toMatch(/1000 tokens/);

    const cost = guard({ budgets: { maxSteps: 9, maxToolCalls: 5, maxCostUsd: 0.01 } });
    cost.recordModelCall(10, 0.02);
    expect(cost.beforeModelCall()).toMatch(/\$0.01/);
  });

  it("stops everything once the kill switch is tripped", async () => {
    const kill = new KillSwitch();
    const g = guard({}, approveAll, kill);
    kill.trip("incident #42");
    expect(g.beforeModelCall()).toMatch(/incident #42/);
    expect(await g.check({ id: "1", name: "get_balance", input: {} })).toMatchObject({ allowed: false, code: "killed" });
  });

  it("blocks the call when a rule or the approver throws", async () => {
    const badRule = guard({ rules: { pay: [() => { throw new Error("rates service down"); }] } });
    expect(await badRule.check({ id: "1", name: "pay", input: { to: "acme", amount: 10 } })).toMatchObject({
      allowed: false,
      code: "rule",
      reason: "rule failed: rates service down",
    });

    const flaky = { decide: async () => { throw new Error("slack timeout"); } };
    expect(await guard({}, flaky).check({ id: "2", name: "pay", input: { to: "acme", amount: 10 } })).toMatchObject({
      allowed: false,
      code: "approval_denied",
      reason: expect.stringMatching(/slack timeout/),
    });
  });

  it("asks for approval when needsApproval throws, and gives it the validated input", async () => {
    let asked = 0;
    const counting = { decide: async () => (asked++, { approved: true, by: "test" }) };
    const seen: unknown[] = [];
    const g = guard(
      {
        needsApproval: (call) => {
          seen.push(call.input);
          if (call.name === "get_balance") throw new Error("bug");
          return false;
        },
      },
      counting,
    );
    await g.check({ id: "1", name: "pay", input: { to: "acme", amount: 10, extra: "dropped by zod" } });
    expect(asked).toBe(0);
    await g.check({ id: "2", name: "get_balance", input: {} });
    expect(asked).toBe(1);
    expect(seen[0]).toEqual({ to: "acme", amount: 10 });
  });

  it("writes every decision to the audit log", async () => {
    const audit = new AuditLog("run-1");
    const g = new Guard(policy(), tools, denyAll, audit);
    await g.check({ id: "1", name: "pay", input: { to: "acme", amount: 10 } });
    expect(audit.entries.map((e) => e.type)).toEqual(["approval", "decision"]);
    expect(audit.entries[1]!.data).toMatchObject({ allowed: false, code: "approval_denied" });
  });
});

describe("toolSpec", () => {
  it("turns the zod schema into JSON Schema for the model", () => {
    const spec = toolSpec(tools[1]!);
    expect(spec.inputSchema).toMatchObject({ type: "object", required: ["to", "amount"] });
    expect(spec.inputSchema).not.toHaveProperty("$schema");
  });
});
