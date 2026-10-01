// pnpm demo            offline: a scripted agent that tries to refund too much
// pnpm demo --claude   the same task with Claude (needs ANTHROPIC_API_KEY or `ant auth login`)
//
// Refunds over 20 are approved on the terminal; the audit log is appended to demo-audit.jsonl.
import { z } from "zod";
import {
  AnthropicModel,
  AuditLog,
  defineTool,
  HANDOFF_TOOL,
  KillSwitch,
  runAgent,
  ScriptedModel,
  terminalApprover,
  verifyChain,
  type Policy,
} from "../src/index.js";

const orders = new Map([
  ["A-1001", { customer: "Dana", total: 30, status: "delivered, damaged" }],
  ["A-1002", { customer: "Sam", total: 240, status: "delivered" }],
]);
const refunds: { order: string; amount: number }[] = [];

const tools = [
  defineTool({
    name: "get_order",
    description: "Look up an order by id.",
    effect: "read",
    input: z.object({ orderId: z.string() }),
    run: ({ orderId }) => orders.get(orderId) ?? `no order ${orderId}`,
  }),
  defineTool({
    name: "refund",
    description: "Refund part or all of an order.",
    effect: "write",
    input: z.object({ orderId: z.string(), amount: z.number().positive() }),
    run: ({ orderId, amount }) => (refunds.push({ order: orderId, amount }), `refunded ${amount}`),
  }),
];

const policy: Policy = {
  task: "Handle refund requests for damaged or missing orders",
  owner: "support-lead",
  allowedTools: ["get_order", "refund"],
  rules: {
    refund: [
      ({ amount }) => (amount > 100 ? "refunds over 100 go to the support lead" : null),
      ({ orderId, amount }) => (amount > (orders.get(orderId)?.total ?? 0) ? "more than the order total" : null),
    ],
  },
  needsApproval: (call) => call.name === "refund" && call.input.amount > 20,
  budgets: { maxSteps: 8, maxToolCalls: 6, maxCostUsd: 0.25 },
  maxBlockedCalls: 2,
};

const useClaude = process.argv.includes("--claude");
const model = useClaude
  ? new AnthropicModel()
  : new ScriptedModel([
      { call: [{ name: "get_order", input: { orderId: "A-1002" } }] },
      { call: [{ name: "refund", input: { orderId: "A-1002", amount: 240 } }] },
      { call: [{ name: HANDOFF_TOOL, input: { reason: "A-1002 wants 240 back, over my limit." } }] },
    ]);

// Runs append to the same file; each gets its own id so `pnpm audit:verify demo-audit.jsonl` checks them separately.
const audit = AuditLog.toFile(`demo-${new Date().toISOString()}`, "demo-audit.jsonl");
const result = await runAgent("Sam says order A-1002 never arrived and wants the full 240 back. Sort it out.", {
  model,
  tools,
  policy,
  approver: terminalApprover(),
  audit,
  killSwitch: new KillSwitch("STOP"), // `touch STOP` in another terminal to halt the run
});

console.log(`\nstatus:   ${result.status}${result.reason ? ` (${result.reason})` : ""}`);
console.log(`executed: ${result.executed.map((e) => e.tool).join(", ") || "nothing"}`);
console.log(`blocked:  ${result.blocked.map((b) => `${b.tool} (${b.code}: ${b.reason})`).join("; ") || "nothing"}`);
console.log(`refunds:  ${JSON.stringify(refunds)}`);
console.log(`spend:    ${result.spend.steps} model calls, ${result.spend.tokens} tokens, $${result.spend.costUsd?.toFixed(4) ?? "?"}`);
console.log(`audit:    ${audit.entries.length} entries, chain ${verifyChain(audit.entries).ok ? "intact" : "BROKEN"}`);
if (result.finalText) console.log(`\n${result.finalText}`);
