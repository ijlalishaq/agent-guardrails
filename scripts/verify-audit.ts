// pnpm audit:verify <file.jsonl>...
// Checks the hash chain of every run in each file. Exits 1 if any run's chain is broken.
import { readAuditFile, verifyChain } from "../src/index.js";

const files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: pnpm audit:verify <file.jsonl>...");
  process.exit(2);
}

let broken = 0;
for (const file of files) {
  for (const [runId, entries] of readAuditFile(file)) {
    const result = verifyChain(entries);
    const last = entries.at(-1);
    const finished = last?.type === "run_finished" ? String(last.data.status) : "not finished";
    if (result.ok) {
      console.log(`ok      ${file} ${runId}: ${entries.length} entries, ${finished}, head ${last?.hash.slice(0, 12)}`);
    } else {
      broken++;
      console.log(`BROKEN  ${file} ${runId}: chain breaks at entry ${result.brokenAt} of ${entries.length}`);
    }
  }
}
process.exit(broken ? 1 : 0);
