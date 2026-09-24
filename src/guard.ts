import type { z } from "zod";
import type { Approver } from "./approvals.js";
import type { AuditLog } from "./audit.js";
import type { KillSwitch } from "./kill-switch.js";
import { needsApproval, type Policy } from "./policy.js";
import type { AnyTool, ToolCall } from "./tools.js";

export type BlockCode =
  | "killed"
  | "unknown_tool"
  | "out_of_scope"
  | "invalid_args"
  | "rule"
  | "approval_denied"
  | "budget";

export type Decision =
  | { allowed: true; input: unknown; approvedBy?: string }
  | { allowed: false; code: BlockCode; reason: string };

/** Blocks that end the run instead of being reported back to the model. */
export const FATAL: ReadonlySet<BlockCode> = new Set(["killed", "budget"]);

export interface Spend {
  steps: number;
  toolCalls: number;
  tokens: number;
  costUsd: number | null;
}

/**
 * The one place a tool call can be let through. Checks run cheapest first and the first
 * failure wins: kill switch, known tool, task scope, argument schema, policy rules,
 * budget, then human approval. Every decision is written to the audit log.
 */
export class Guard {
  readonly spend: Spend = { steps: 0, toolCalls: 0, tokens: 0, costUsd: 0 };
  private readonly tools: Map<string, AnyTool>;

  constructor(
    readonly policy: Policy,
    tools: AnyTool[],
    private readonly approver: Approver,
    private readonly audit: AuditLog,
    private readonly killSwitch?: KillSwitch,
  ) {
    this.tools = new Map(tools.map((t) => [t.name, t]));
  }

  tool(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  /** Called before each model call. Returns a reason to stop the run, or null. */
  beforeModelCall(): string | null {
    const killed = this.killSwitch?.check();
    if (killed) return `killed: ${killed}`;
    const { maxSteps, maxTokens, maxCostUsd } = this.policy.budgets;
    if (this.spend.steps >= maxSteps) return `budget: ${maxSteps} model calls used`;
    if (maxTokens !== undefined && this.spend.tokens >= maxTokens) return `budget: ${maxTokens} tokens used`;
    if (maxCostUsd !== undefined && this.spend.costUsd !== null && this.spend.costUsd >= maxCostUsd) {
      return `budget: $${maxCostUsd} spent`;
    }
    return null;
  }

  recordModelCall(tokens: number, costUsd: number | null): void {
    this.spend.steps += 1;
    this.spend.tokens += tokens;
    // Once one call has no known price, the run's total cost is unknown too.
    this.spend.costUsd = this.spend.costUsd === null || costUsd === null ? null : this.spend.costUsd + costUsd;
  }

  async check(call: ToolCall): Promise<Decision> {
    const decision = await this.decide(call);
    this.audit.append("decision", {
      callId: call.id,
      tool: call.name,
      input: call.input,
      ...(decision.allowed ? { allowed: true, approvedBy: decision.approvedBy } : decision),
    });
    if (decision.allowed) this.spend.toolCalls += 1;
    return decision;
  }

  private async decide(call: ToolCall): Promise<Decision> {
    const killed = this.killSwitch?.check();
    if (killed) return block("killed", killed);

    const tool = this.tools.get(call.name);
    if (!tool) return block("unknown_tool", `there is no tool called "${call.name}"`);
    if (!this.policy.allowedTools.includes(call.name)) {
      return block("out_of_scope", `${call.name} is not allowed for this task`);
    }

    const parsed = (tool.input as z.ZodType).safeParse(call.input);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`);
      return block("invalid_args", issues.join("; "));
    }

    for (const rule of this.policy.rules?.[call.name] ?? []) {
      const reason = rule(parsed.data);
      if (reason) return block("rule", reason);
    }

    if (this.spend.toolCalls >= this.policy.budgets.maxToolCalls) {
      return block("budget", `${this.policy.budgets.maxToolCalls} tool calls used`);
    }

    if (needsApproval(this.policy, call, tool)) {
      const request = {
        runId: this.audit.runId,
        task: this.policy.task,
        owner: this.policy.owner,
        tool: call.name,
        input: parsed.data,
      };
      const answer = await this.approver.decide(request);
      this.audit.append("approval", { callId: call.id, tool: call.name, ...answer });
      if (!answer.approved) {
        return block("approval_denied", `${answer.by} declined${answer.note ? `: ${answer.note}` : ""}`);
      }
      return { allowed: true, input: parsed.data, approvedBy: answer.by };
    }

    return { allowed: true, input: parsed.data };
  }
}

function block(code: BlockCode, reason: string): Decision {
  return { allowed: false, code, reason };
}
