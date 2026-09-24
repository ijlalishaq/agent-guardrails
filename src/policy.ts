import type { AnyTool, ToolCall } from "./tools.js";

export interface Budgets {
  /** Model calls per run. */
  maxSteps: number;
  /** Tool calls the guard will let through per run (blocked calls don't count). */
  maxToolCalls: number;
  /** Input + output tokens per run. */
  maxTokens?: number;
  /** Only enforced when the model has a known price (see pricing.ts). */
  maxCostUsd?: number;
}

/**
 * A rule about one tool's arguments. Return a reason to block the call, or null to allow it.
 * Rules see the input after schema validation, so they can trust its shape.
 */
export type ArgRule = (input: any) => string | null;

export interface Policy {
  /** What this run is for. Shown to the model and written to the audit log. */
  task: string;
  /** The person a run is handed to when it can't continue on its own. */
  owner: string;
  /** Tools this task may use. Anything else is blocked, even if the agent has it. */
  allowedTools: string[];
  rules?: Record<string, ArgRule[]>;
  /** Which calls need a person to approve them first. Defaults to every write tool. */
  needsApproval?: (call: ToolCall, tool: AnyTool) => boolean;
  budgets: Budgets;
  /** Hand the run to the owner after this many blocked calls. */
  maxBlockedCalls: number;
}

export const writesNeedApproval = (_call: ToolCall, tool: AnyTool) => tool.effect === "write";

export function needsApproval(policy: Policy, call: ToolCall, tool: AnyTool): boolean {
  return (policy.needsApproval ?? writesNeedApproval)(call, tool);
}
