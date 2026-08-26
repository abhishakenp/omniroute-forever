import {
  existsSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
  readFileSync,
  statSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";
import { spawn, execSync } from "node:child_process";
import { t } from "../i18n.mjs";
import { emit } from "../output.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const LABEL = "com.abhi.omniroute";
const LAUNCH_AGENTS_DIR = join(homedir(), "Library", "LaunchAgents");
const PLIST_PATH = join(LAUNCH_AGENTS_DIR, `${LABEL}.plist`);

const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_LOG_FILES = 5; // keep 5 rotated logs + current

/**
 * Rotate logs if they exceed MAX_LOG_SIZE.
 * Keeps only MAX_LOG_FILES rotated copies.
 * Runs on every enable/reload — prevents unbounded growth.
 */
function rotateLogs(logDir) {
  try {
    const logFile = join(logDir, "omniroute.log");
    if (!existsSync(logFile)) return;

    const stat = statSync(logFile);
    if (stat.size < MAX_LOG_SIZE) return;

    // Rotate: omniroute.log → omniroute.log.1 → omniroute.log.2 → ... (delete oldest)
    for (let i = MAX_LOG_FILES; i >= 1; i--) {
      const src = join(logDir, `omniroute.log.${i}`);
      const dst = join(logDir, `omniroute.log.${i + 1}`);
      if (existsSync(src)) {
        if (i + 1 > MAX_LOG_FILES) {
          unlinkSync(src); // delete oldest
        } else {
          try {
            renameSync(src, dst);
          } catch {}
        }
      }
    }
    // Current → .1
    try {
      renameSync(logFile, join(logDir, "omniroute.log.1"));
    } catch {}
  } catch {
    // best-effort — don't fail enable on rotation error
  }
}

/**
 * Evict old logs beyond retention. Called on every enable.
 * Also evicts provisioner logs.
 */
function evictOldLogs(logDir) {
  try {
    const files = readdirSync(logDir).filter((f) => f.endsWith(".log") || f.includes(".log."));
    const logFiles = files
      .map((f) => ({ name: f, path: join(logDir, f), mtime: statSync(join(logDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    // Keep only MAX_LOG_FILES + current + provisioner log
    const keep = new Set();
    let kept = 0;
    for (const f of logFiles) {
      if (f.name === "provisioner.log") {
        keep.add(f.name);
        continue;
      }
      if (kept < MAX_LOG_FILES + 1) {
        keep.add(f.name);
        kept++;
      } else {
        try {
          unlinkSync(f.path);
        } catch {}
      }
    }
  } catch {}
}

/**
 * `omniroute enable` — set up OmniRoute as a system daemon with auto-restart.
 *
 * Flags:
 *   --logs    Forward stdout/stderr to a log file (default: /tmp/omniroute.log)
 *   --dev     Run in dev mode (hot reload via Next.js turbopack + SIGHUP)
 *   --port    Port to listen on (default: 20128)
 *   --log-file <path>  Custom log file path
 *
 * What it does:
 *   - macOS: writes a launchd plist with KeepAlive (auto-restart on crash)
 *   - Linux: writes a systemd user unit with Restart=always
 *   - Starts the daemon immediately via launchctl load / systemctl --user start
 *
 * The daemon survives:
 *   - Process crash (launchd/systemd restarts it)
 *   - System reboot (RunAtLoad=true)
 *   - SIGHUP (graceful hot reload — drain → persist → exit → restart)
 */
export function registerEnable(program) {
  program
    .command("enable")
    .description(t("enable.description") || "Enable OmniRoute as a system daemon with auto-restart")
    .option("--logs", "Forward logs to file (default: /tmp/omniroute.log)")
    .option("--dev", "Run in dev mode with hot reload")
    .option(
      "--headless",
      "Run in headless mode (API only, no Next.js/turbopack — lowest resource usage)"
    )
    .option("--port <port>", "Port to listen on", "20128")
    .option("--log-file <path>", "Custom log file path")
    .action(async (opts, c) => {
      const globalOpts = c.optsWithGlobals();
      const result = await runEnable(opts);
      emit(result, globalOpts);
      if (!result.ok) process.exit(1);
    });
}

export async function runEnable(opts = {}) {
  const port = opts.port || "20128";
  const dev = opts.dev === true;
  const headless = opts.headless === true;
  const logs = opts.logs === true || !!opts.logFile;
  const logFile = opts.logFile || join(homedir(), ".omniroute", "logs", "omniroute.log");
  const nodeBin = process.execPath || "node";

  // Build the server start command — headless mode uses the lightweight
  // API-only server (no Next.js, no turbopack, ~300 MB vs ~4 GB).
  let serverScript, serverArgs;
  if (headless) {
    serverScript = join(ROOT, "scripts", "dev", "run-headless.mjs");
    // 2048 MB heap — large enough to avoid GC death spirals under load,
    // but small enough to prevent 100ms+ stop-the-world pauses.
    // The concurrency semaphore in server.ts (max 8 concurrent) keeps
    // the working set small, so GC runs infrequently and briefly.
    serverArgs = [
      "--expose-gc",
      "--max-old-space-size=2048",
      "--max-semi-space-size=32",
      serverScript,
    ];
  } else if (dev) {
    serverScript = join(ROOT, "scripts", "dev", "run-next.mjs");
    serverArgs = ["--max-old-space-size=8192", serverScript, "dev"];
  } else {
    serverScript = join(ROOT, "dist", "server.js");
    serverArgs = [serverScript];
  }

  if (!existsSync(serverScript)) {
    return { ok: false, error: `Server script not found at ${serverScript}` };
  }

  if (platform() === "darwin") {
    return enableMacos(nodeBin, serverArgs, port, logs, logFile, dev);
  } else if (platform() === "linux") {
    return enableLinux(nodeBin, serverArgs, port, logs, logFile, dev);
  } else {
    return {
      ok: false,
      error: `Platform ${platform()} not supported for daemon mode. Use 'omniroute serve --daemon' instead.`,
    };
  }
}

function enableMacos(nodeBin, serverArgs, port, logs, logFile, dev) {
  try {
    // Ensure LaunchAgents dir exists
    if (!existsSync(LAUNCH_AGENTS_DIR)) mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });

    // Ensure log directory exists + rotate old logs
    const logDir = join(homedir(), ".omniroute", "logs");
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    rotateLogs(logDir);

    // Build plist
    const plist = buildPlist({
      label: LABEL,
      nodeBin,
      serverArgs,
      cwd: ROOT,
      port,
      logs,
      logFile,
      dev,
    });

    // Unload if already loaded
    try {
      execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null`);
    } catch {}

    // Write plist
    writeFileSync(PLIST_PATH, plist);

    // Load it
    execSync(`launchctl load "${PLIST_PATH}"`);

    // Verify it's running
    const pid = getPid();
    const mode = dev ? "dev (hot reload)" : "production";

    return {
      ok: true,
      enabled: true,
      platform: "macOS",
      label: LABEL,
      plistPath: PLIST_PATH,
      pid,
      port: parseInt(port),
      mode,
      logs: logs ? logFile : "stdout (system journal)",
      hotReload: "Send SIGHUP to PID or run: omniroute reload",
      autoRestart: true,
      startsAtBoot: true,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function enableLinux(nodeBin, serverArgs, port, logs, logFile, dev) {
  const systemdDir = join(homedir(), ".config", "systemd", "user");
  const unitPath = join(systemdDir, "omniroute.service");

  try {
    if (!existsSync(systemdDir)) mkdirSync(systemdDir, { recursive: true });

    const execStart = `${nodeBin} ${serverArgs.join(" ")}`;
    const unit = `[Unit]
Description=OmniRoute Daemon
After=network.target

[Service]
Type=simple
ExecStart=${execStart}
WorkingDirectory=${ROOT}
Restart=always
RestartSec=10
Environment=PORT=${port}
Environment=NODE_ENV=${dev ? "development" : "production"}
${logs ? `StandardOutput=append:${logFile}\nStandardError=append:${logFile}` : ""}

[Install]
WantedBy=default.target
`;
    try {
      execSync(`systemctl --user stop omniroute.service 2>/dev/null`);
    } catch {}
    writeFileSync(unitPath, unit);
    execSync(`systemctl --user daemon-reload`);
    execSync(`systemctl --user enable omniroute.service`);
    execSync(`systemctl --user start omniroute.service`);

    return {
      ok: true,
      enabled: true,
      platform: "Linux",
      unitPath,
      port: parseInt(port),
      mode: dev ? "dev (hot reload)" : "production",
      logs: logs ? logFile : "journalctl --user -u omniroute",
      autoRestart: true,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function buildPlist({ label, nodeBin, serverArgs, cwd, port, logs, logFile, dev }) {
  const envVars = `
    <key>EnvironmentVariables</key>
    <dict>
      <key>PORT</key><string>${port}</string>
      <key>NODE_ENV</key><string>${dev ? "development" : "production"}</string>
      <key>DATA_DIR</key><string>${join(homedir(), ".omniroute")}</string>
    </dict>`;

  const logSection = logs
    ? `
    <key>StandardOutPath</key><string>${logFile}</string>
    <key>StandardErrorPath</key><string>${logFile}</string>`
    : `
    <key>StandardOutPath</key><string>${join(homedir(), ".omniroute", "logs", "omniroute.log")}</string>
    <key>StandardErrorPath</key><string>${join(homedir(), ".omniroute", "logs", "omniroute.log")}</string>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodeBin}</string>
        ${serverArgs.map((a) => `<string>${a}</string>`).join("\n        ")}
    </array>
    <key>WorkingDirectory</key><string>${cwd}</string>
    ${envVars}
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>10</integer>
    <key>ProcessType</key><string>Background</string>${logSection}
</dict>
</plist>
`;
}

function getPid() {
  try {
    const out = execSync(`launchctl list | grep ${LABEL} | awk '{print $1}'`, {
      encoding: "utf8",
    }).trim();
    const pid = parseInt(out, 10);
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
