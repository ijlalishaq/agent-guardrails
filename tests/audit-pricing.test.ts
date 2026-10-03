import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLog, costOf, readAuditFile, setPrice, verifyChain } from "../src/index.js";

describe("audit files", () => {
  it("keeps runs that share a file apart", () => {
    const path = join(mkdtempSync(join(tmpdir(), "audit-")), "log.jsonl");
    for (const id of ["a", "b"]) {
      const log = AuditLog.toFile(id, path);
      log.append("run_started", {});
      log.append("run_finished", { status: "completed" });
    }
    const runs = readAuditFile(path);
    expect([...runs.keys()]).toEqual(["a", "b"]);
    for (const entries of runs.values()) expect(verifyChain(entries)).toEqual({ ok: true });
  });

  it("exposes the head hash so a cut-off tail can be caught", () => {
    const log = new AuditLog("r");
    log.append("run_started", {});
    log.append("run_finished", {});
    const storedHead = log.head; // e.g. sent to another system when the run ends
    const truncated = log.entries.slice(0, 1);
    expect(verifyChain(truncated)).toEqual({ ok: true }); // the chain alone can't tell
    expect(truncated.at(-1)!.hash).not.toBe(storedHead);
  });
});

describe("costOf", () => {
  it("prices cache reads and writes separately", () => {
    // Opus 5.5: 4 in, 20 out, 0.2 cache read, 5 cache write (1.25x) per million.
    const cost = costOf("anthropic:claude-opus-5-5", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(4 + 20 + 0.2 + 5);
  });

  it("returns null for unknown models until a price is set", () => {
    expect(costOf("ollama:mystery", { inputTokens: 10, outputTokens: 10 })).toBeNull();
    setPrice("ollama:mystery", { input: 0, output: 0 });
    expect(costOf("ollama:mystery", { inputTokens: 10, outputTokens: 10 })).toBe(0);
  });
});
