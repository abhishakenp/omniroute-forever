/**
 * Boot-time registration for local-CLI passthrough providers.
 *
 * Providers such as Augment (`auggie`) are "no-auth": OmniRoute stores no
 * credential and simply spawns the user's locally authenticated CLI. Because
 * nothing ever creates a credential for them, no `provider_connections` row is
 * ever inserted — the provisioner explicitly skips no-auth providers, and the
 * only INSERT path is the user-driven `POST /api/providers`.
 *
 * A missing row has three consequences, all of them bad:
 *
 *   1. The provider is invisible in `GET /providers` and `GET /v1/models`
 *      (both enumerate `SELECT DISTINCT provider FROM provider_connections`).
 *   2. `TargetIterator` can only reach it through the registry no-auth
 *      fallback, which runs *after* every real connection is exhausted.
 *   3. `TargetIterator.markFailed()` has no row to write to, so an exhausted
 *      or logged-out CLI can never be quarantined — the router keeps paying
 *      the subprocess-spawn cost on every request.
 *
 * Seeding an inert row (no api_key, auth_type "none") fixes all three: the
 * provider becomes a normal connection that health-marking, quarantine and
 * failover already understand.
 *
 * Idempotent. An existing row is never overwritten — in particular a row the
 * router has quarantined (`credits_exhausted` / `error`) stays quarantined.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDbInstance } from "./core.ts";
import { resolveAuggieBin } from "@omniroute/open-sse/executors/auggie";

interface LocalCliProvider {
  provider: string;
  name: string;
  /** Resolve the CLI binary — may return a bare command to look up on PATH. */
  resolveBin: () => string;
  /**
   * Sorted after ordinary credentialed connections (`ORDER BY priority DESC`).
   * A local CLI is a slow last resort, not a first choice.
   */
  priority: number;
}

const LOCAL_CLI_PROVIDERS: LocalCliProvider[] = [
  {
    provider: "auggie",
    name: "Augment (Auggie CLI — local passthrough)",
    resolveBin: resolveAuggieBin,
    priority: 0,
  },
];

/** True when `bin` is an existing file, or a bare command found on PATH. */
function isBinaryPresent(bin: string): boolean {
  if (!bin) return false;
  if (bin.includes(path.sep)) {
    try {
      return fs.existsSync(bin);
    } catch {
      return false;
    }
  }
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    try {
      if (fs.existsSync(path.join(dir, bin))) return true;
    } catch {
      /* unreadable PATH entry — keep looking */
    }
  }
  return false;
}

export function seedLocalCliConnections(): void {
  let db: ReturnType<typeof getDbInstance>;
  try {
    db = getDbInstance();
  } catch (err) {
    console.warn("[seed-local-cli] DB unavailable — skipping:", err);
    return;
  }

  for (const spec of LOCAL_CLI_PROVIDERS) {
    try {
      let installed = false;
      try {
        installed = isBinaryPresent(spec.resolveBin());
      } catch {
        installed = false;
      }

      const existing = db
        .prepare(`SELECT id, is_active FROM provider_connections WHERE provider = ? LIMIT 1`)
        .get(spec.provider) as { id: string; is_active: number } | undefined;

      if (!existing) {
        if (!installed) {
          console.log(
            `[seed-local-cli] ${spec.provider}: CLI not installed — no connection registered`
          );
          continue;
        }
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO provider_connections
             (id, provider, auth_type, name, priority, is_active,
              proxy_enabled, per_key_proxy_enabled, quota_visible,
              created_at, updated_at)
           VALUES (?, ?, 'none', ?, ?, 1, 0, 0, 1, ?, ?)`
        ).run(randomUUID(), spec.provider, spec.name, spec.priority, now, now);
        console.log(`[seed-local-cli] ${spec.provider}: registered local-CLI connection`);
        continue;
      }

      // Row exists — only reconcile the installed/uninstalled flag. Never touch
      // test_status: a quarantine written by the router must survive a restart.
      const shouldBeActive = installed ? 1 : 0;
      if (existing.is_active !== shouldBeActive) {
        db.prepare(
          `UPDATE provider_connections SET is_active = ?, updated_at = ? WHERE id = ?`
        ).run(shouldBeActive, new Date().toISOString(), existing.id);
        console.log(
          `[seed-local-cli] ${spec.provider}: is_active → ${shouldBeActive} (CLI ${
            installed ? "found" : "missing"
          })`
        );
      }
    } catch (err) {
      console.warn(`[seed-local-cli] ${spec.provider}: seeding failed:`, err);
    }
  }
}
