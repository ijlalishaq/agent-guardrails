import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type AuditType =
  | "run_started"
  | "model_call"
  | "decision"
  | "approval"
  | "tool_result"
  | "handoff"
  | "run_finished";

export interface AuditEntry {
  seq: number;
  at: string;
  runId: string;
  type: AuditType;
  data: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

const GENESIS = "0".repeat(64);

function hashOf(e: Omit<AuditEntry, "hash">): string {
  const { seq, at, runId, type, data, prevHash } = e;
  return createHash("sha256").update(prevHash).update(JSON.stringify({ seq, at, runId, type, data })).digest("hex");
}

/**
 * Append-only log of everything the guard decided. Each entry carries the hash of the one
 * before it, so deleting or editing a line breaks the chain and `verifyChain` finds it.
 */
export class AuditLog {
  readonly entries: AuditEntry[] = [];

  constructor(
    readonly runId: string,
    private readonly sink?: (line: string) => void,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Writes every entry as a JSON line to `path` as well as keeping it in memory. */
  static toFile(runId: string, path: string): AuditLog {
    mkdirSync(dirname(path), { recursive: true });
    return new AuditLog(runId, (line) => appendFileSync(path, line + "\n"));
  }

  /** Hash of the latest entry. Store it somewhere else to detect lines cut off the end. */
  get head(): string {
    return this.entries.at(-1)?.hash ?? GENESIS;
  }

  append(type: AuditType, data: Record<string, unknown>): AuditEntry {
    const prev = this.entries.at(-1);
    const base = {
      seq: this.entries.length,
      at: this.now().toISOString(),
      runId: this.runId,
      type,
      data,
      prevHash: prev?.hash ?? GENESIS,
    };
    const entry = { ...base, hash: hashOf(base) };
    this.entries.push(entry);
    this.sink?.(JSON.stringify(entry));
    return entry;
  }
}

/**
 * Checks that every entry links to the one before it. On its own this can't tell that entries
 * were removed from the end; compare the last hash with a `head` you kept elsewhere for that.
 */
export function verifyChain(entries: AuditEntry[]): { ok: true } | { ok: false; brokenAt: number } {
  let prevHash = GENESIS;
  for (const [i, e] of entries.entries()) {
    if (e.seq !== i || e.prevHash !== prevHash || hashOf(e) !== e.hash) return { ok: false, brokenAt: i };
    prevHash = e.hash;
  }
  return { ok: true };
}

/** Reads a JSONL audit file and groups its entries by run, in file order. */
export function readAuditFile(path: string): Map<string, AuditEntry[]> {
  const runs = new Map<string, AuditEntry[]>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as AuditEntry;
    runs.set(entry.runId, [...(runs.get(entry.runId) ?? []), entry]);
  }
  return runs;
}
