import { execSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { t } from "../i18n.mjs";
import { emit } from "../output.mjs";

const LABEL = "com.abhi.omniroute";

/**
 * `omniroute reload` — hot reload the OmniRoute daemon without downtime.
 *
 * Sends SIGHUP to the running OmniRoute process. The server's SIGHUP handler:
 *   1. Stops accepting new connections
 *   2. Waits for in-flight requests to drain (max 10s)
 *   3. Persists all state (probe state, combos, DB WAL checkpoint)
 *   4. Exits cleanly
 *   5. launchd/systemd restarts the process immediately
 *   6. New process loads persisted state → 0 runtime errors
 *
 * This is the 0-downtime hot reload path. No requests are lost.
 */
export function registerReload(program) {
  program
    .command("reload")
    .description(
      t("reload.description") || "Hot reload OmniRoute daemon (graceful drain + restart)"
    )
    .option("--pid <pid>", "PID to signal (auto-detected by default)")
    .action(async (opts, c) => {
      const globalOpts = c.optsWithGlobals();
      const result = await runReload(opts);
      emit(result, globalOpts);
      if (!result.ok) process.exit(1);
    });
}

export async function runReload(opts = {}) {
  const pid = await resolvePid(opts.pid);
  if (!pid) {
    return {
      ok: false,
      error: "OmniRoute daemon not running. Use 'omniroute enable' to start it.",
    };
  }

  try {
    process.kill(pid, "SIGHUP");
    return {
      ok: true,
      reloaded: true,
      pid,
      message: `SIGHUP sent to PID ${pid}. Server will drain in-flight requests, persist state, and restart.`,
    };
  } catch (err) {
    return { ok: false, error: `Failed to signal PID ${pid}: ${err.message}` };
  }
}

async function resolvePid(explicit) {
  if (explicit) return parseInt(explicit, 10);

  if (platform() === "darwin") {
    try {
      const out = execSync(`launchctl list | grep ${LABEL} | awk '{print $1}'`, {
        encoding: "utf8",
      }).trim();
      const pid = parseInt(out, 10);
      return pid > 0 ? pid : null;
    } catch {
      return null;
    }
  } else if (platform() === "linux") {
    try {
      const out = execSync(`systemctl --user show omniroute.service --property=MainPID --value`, {
        encoding: "utf8",
      }).trim();
      const pid = parseInt(out, 10);
      return pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }
  return null;
}
