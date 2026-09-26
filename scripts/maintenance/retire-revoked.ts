/**
 * Retire credentials that have failed authentication past the point where
 * "temporarily broken" remains a possible explanation.
 *
 * `markFailed` does this at the moment it happens for everything from now on.
 * This exists for the backlog that was already past the line when the rule
 * landed, and to give an operator a way to inspect and reverse it.
 *
 *   bun scripts/maintenance/retire-revoked.ts            # dry run
 *   bun scripts/maintenance/retire-revoked.ts --apply
 *   bun scripts/maintenance/retire-revoked.ts --revive [provider]
 *
 * Idempotent: a second --apply retires nothing, because the rows it retired no
 * longer match the candidate predicate.
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";
import { candidates, retire, revive, type RetireDb } from "../../src/lib/db/retireRevoked.ts";

const dbPath = process.env.OMNIROUTE_DB ?? join(process.env.DATA_DIR ?? join(homedir(), ".omniroute"), "storage.sqlite");
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const reviveAt = args.indexOf("--revive");

const db = new Database(dbPath, { readwrite: true }) as unknown as RetireDb;

if (reviveAt !== -1) {
  const provider = args[reviveAt + 1] && !args[reviveAt + 1].startsWith("--") ? args[reviveAt + 1] : undefined;
  const n = revive(db, provider);
  console.log(`revived ${n} connection(s)${provider ? ` for ${provider}` : ""}`);
} else {
  const found = candidates(db);
  const byProvider = new Map<string, number>();
  for (const c of found) byProvider.set(c.provider, (byProvider.get(c.provider) ?? 0) + 1);
  console.log(`${found.length} connection(s) are past the retirement threshold:`);
  for (const [provider, n] of [...byProvider].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${provider.padEnd(16)} ${n}`);
  }
  if (apply) {
    const n = retire(db);
    console.log(`\nretired ${n}`);
  } else {
    console.log(`\ndry run — pass --apply to write`);
  }
}
