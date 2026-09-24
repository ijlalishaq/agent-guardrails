import { createInterface } from "node:readline/promises";

export interface ApprovalRequest {
  runId: string;
  task: string;
  owner: string;
  tool: string;
  input: unknown;
}

export interface ApprovalDecision {
  approved: boolean;
  by: string;
  note?: string;
}

export interface Approver {
  decide(request: ApprovalRequest): Promise<ApprovalDecision>;
}

export const denyAll: Approver = {
  async decide() {
    return { approved: false, by: "deny-all", note: "no approver configured" };
  },
};

export const approveAll: Approver = {
  async decide() {
    return { approved: true, by: "approve-all" };
  },
};

/** Approves the calls `allow` accepts and denies the rest. Useful in tests and evals. */
export function approveWhen(allow: (r: ApprovalRequest) => boolean, by = "rule"): Approver {
  return {
    async decide(r) {
      return allow(r) ? { approved: true, by } : { approved: false, by, note: "rule declined" };
    },
  };
}

/** Asks on the terminal. The default answer is no. */
export function terminalApprover(by = process.env.USER ?? "operator"): Approver {
  return {
    async decide(r) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await rl.question(
          `\n[approval] ${r.tool} ${JSON.stringify(r.input)}\n  for: ${r.task}\n  approve? [y/N] `,
        );
        const approved = /^y(es)?$/i.test(answer.trim());
        return { approved, by };
      } finally {
        rl.close();
      }
    },
  };
}
