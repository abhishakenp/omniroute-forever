import { existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";
import { execSync } from "node:child_process";
import { t } from "../i18n.mjs";
import { emit } from "../output.mjs";

const LABEL = "com.abhi.omniroute";
const LAUNCH_AGENTS_DIR = join(homedir(), "Library", "LaunchAgents");
const PLIST_PATH = join(LAUNCH_AGENTS_DIR, `${LABEL}.plist`);
const SYSTEMD_UNIT = join(homedir(), ".config", "systemd", "user", "omniroute.service");

/**
 * `omniroute disable` — remove OmniRoute daemon from auto-start.
 *
 * Stops the running daemon and removes the launchd/systemd configuration.
 * Does NOT delete data or configuration — only the auto-restart daemon setup.
 */
export function registerDisable(program) {
  program
    .command("disable")
    .description(t("disable.description") || "Disable OmniRoute daemon auto-restart")
    .action(async (opts, c) => {
      const globalOpts = c.optsWithGlobals();
      const result = await runDisable();
      emit(result, globalOpts);
      if (!result.ok) process.exit(1);
    });
}

export async function runDisable() {
  if (platform() === "darwin") {
    return disableMacos();
  } else if (platform() === "linux") {
    return disableLinux();
  } else {
    return { ok: false, error: `Platform ${platform()} not supported` };
  }
}

function disableMacos() {
  let unloaded = false;
  let removed = false;

  try {
    if (existsSync(PLIST_PATH)) {
      try {
        execSync(`launchctl unload "${PLIST_PATH}"`);
        unloaded = true;
      } catch {
        // Already unloaded or not loaded
      }
      unlinkSync(PLIST_PATH);
      removed = true;
    }
    return {
      ok: true,
      disabled: true,
      platform: "macOS",
      unloaded,
      plistRemoved: removed,
      message: "OmniRoute daemon disabled. Process will stop on next exit.",
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function disableLinux() {
  try {
    if (existsSync(SYSTEMD_UNIT)) {
      try {
        execSync(`systemctl --user stop omniroute.service`);
      } catch {}
      try {
        execSync(`systemctl --user disable omniroute.service`);
      } catch {}
      unlinkSync(SYSTEMD_UNIT);
      try {
        execSync(`systemctl --user daemon-reload`);
      } catch {}
    }
    return {
      ok: true,
      disabled: true,
      platform: "Linux",
      message: "OmniRoute daemon disabled.",
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
