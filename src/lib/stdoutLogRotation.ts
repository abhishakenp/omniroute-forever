/**
 * Rotation for the daemon's own stdout/stderr log.
 *
 * ## Why the existing rotation could never work
 *
 * `~/.omniroute/logs/omniroute.log` is **not written by this process through any
 * logger**. The launchd job (`com.abhi.omniroute`) sets
 *
 *     StandardOutPath  = ~/.omniroute/logs/omniroute.log
 *     StandardErrorPath = ~/.omniroute/logs/omniroute.log
 *
 * and `src/shared/utils/logger.ts` is a plain `console.*` shim, so every log line
 * reaches the file through a file descriptor **launchd** opened, not one this
 * process controls. Three consequences, all of which held in production:
 *
 *  1. `initLogRotation()` (src/lib/logRotation.ts) has had zero production
 *     callers since the pino logger was replaced; it also targets a different
 *     file entirely (`logs/application/app.log`).
 *  2. The `.1`–`.5` rotation in `scripts/dev/run-headless.mjs` runs once at
 *     startup, and only on the **Node** entrypoint — the live daemon execs
 *     `bun src/server/headless/server-elysia.ts`, so it never runs at all.
 *  3. Both existing implementations rotate with `renameSync`. **That cannot work
 *     here.** launchd holds an open `O_APPEND` descriptor on the original inode
 *     and does not reopen on rename, so renaming the file just moves the inode
 *     launchd keeps writing into: the archive would keep growing and
 *     `omniroute.log` would not exist at all until the job restarted.
 *
 * Observed end state: a 54 MB `omniroute.log` beside five 0-byte siblings, all
 * stamped with the same minute — the residue of one startup rotation that
 * cascaded five empty files and then never ran again.
 *
 * ## What this does instead: copy-truncate
 *
 * The archive is **copied** out and the live file is **truncated in place**, so
 * the inode — and therefore launchd's descriptor — survives. Because the
 * descriptor was opened `O_APPEND`, the next write lands at offset 0 of the
 * now-empty file rather than re-creating a 54 MB sparse hole, which is exactly
 * why `O_APPEND` matters here and why this is the standard `logrotate
 * copytruncate` strategy for logs owned by a supervisor.
 *
 * The narrow, accepted cost of copy-truncate: lines written between the copy and
 * the truncate are lost. At these volumes that is a handful of lines once per
 * rotation, and the alternative — losing rotation entirely — is what produced the
 * 54 MB file.
 */

import {
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  openSync,
  renameSync,
  statSync,
  truncateSync,
  unlinkSync,
} from "node:fs";

/** Rotate once the live log reaches this size. */
export const DEFAULT_STDOUT_LOG_MAX_BYTES = 10 * 1024 * 1024;
/** How many archives to keep (`.1` … `.N`). */
export const DEFAULT_STDOUT_LOG_MAX_FILES = 5;
/** How often to check the size. */
export const DEFAULT_STDOUT_LOG_CHECK_INTERVAL_MS = 60_000;

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function getStdoutLogMaxBytes(): number {
  return positiveIntFromEnv("OMNIROUTE_STDOUT_LOG_MAX_BYTES", DEFAULT_STDOUT_LOG_MAX_BYTES);
}

export function getStdoutLogMaxFiles(): number {
  return positiveIntFromEnv("OMNIROUTE_STDOUT_LOG_MAX_FILES", DEFAULT_STDOUT_LOG_MAX_FILES);
}

export function getStdoutLogCheckIntervalMs(): number {
  return positiveIntFromEnv(
    "OMNIROUTE_STDOUT_LOG_CHECK_INTERVAL_MS",
    DEFAULT_STDOUT_LOG_CHECK_INTERVAL_MS
  );
}

export interface RotateResult {
  rotated: boolean;
  /** Bytes archived, when a rotation happened. */
  bytes?: number;
  /** Why no rotation happened. */
  reason?: "missing" | "under-threshold" | "error";
  error?: string;
}

/**
 * Rotate `logPath` if it has reached `maxBytes`.
 *
 * Shifts `.N-1` → `.N` (plain renames — nobody holds those open), copies the
 * live file to `.1`, then truncates the live file **in place** so the writer's
 * descriptor keeps working.
 */
export function rotateStdoutLog(
  logPath: string,
  maxBytes: number = getStdoutLogMaxBytes(),
  maxFiles: number = getStdoutLogMaxFiles()
): RotateResult {
  try {
    if (!existsSync(logPath)) return { rotated: false, reason: "missing" };
    const size = statSync(logPath).size;
    if (size < maxBytes) return { rotated: false, reason: "under-threshold" };

    // Drop the oldest, then shift the rest up. These are inert archives, so a
    // rename is correct and cheap here — it is only the LIVE file that must not
    // be renamed.
    const oldest = `${logPath}.${maxFiles}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let i = maxFiles - 1; i >= 1; i--) {
      const from = `${logPath}.${i}`;
      if (existsSync(from)) renameSync(from, `${logPath}.${i + 1}`);
    }

    // Copy out, then truncate in place. Order matters: truncating first would
    // discard the log we are trying to keep.
    copyFileSync(logPath, `${logPath}.1`);
    truncateSync(logPath, 0);

    return { rotated: true, bytes: size };
  } catch (err) {
    return {
      rotated: false,
      reason: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

let rotationTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start periodic rotation of the daemon's stdout log.
 *
 * Periodic, not startup-only: this daemon runs under `KeepAlive` for weeks, so a
 * check that only happens at boot is a check that effectively never happens.
 * Returns false when there is nothing to watch.
 */
export function startStdoutLogRotation(
  logPath: string,
  intervalMs: number = getStdoutLogCheckIntervalMs()
): boolean {
  if (rotationTimer) return true;
  if (!logPath) return false;

  const tick = () => {
    const result = rotateStdoutLog(logPath);
    if (result.rotated) {
      console.log(
        `[log-rotation] rotated ${logPath} (${(result.bytes ?? 0) / 1024 / 1024} MB archived to .1)`
      );
    } else if (result.reason === "error") {
      console.warn(`[log-rotation] failed for ${logPath}: ${result.error}`);
    }
  };

  tick(); // Catch a file that is already oversized at boot.
  rotationTimer = setInterval(tick, intervalMs);
  (rotationTimer as { unref?: () => void }).unref?.();
  return true;
}

export function stopStdoutLogRotation(): void {
  if (!rotationTimer) return;
  clearInterval(rotationTimer);
  rotationTimer = null;
}

/**
 * Where this process's stdout is actually going, or null when it is not a file.
 *
 * `OMNIROUTE_STDOUT_LOG` wins when set (the launchd plist can state it
 * explicitly). Otherwise fall back to the conventional path under the data dir,
 * and only accept it if it exists — writing rotation logic against a guessed
 * path that nothing writes to is how the previous implementation ended up
 * rotating a file nobody used.
 */
export function resolveStdoutLogPath(dataDir: string): string | null {
  const explicit = process.env.OMNIROUTE_STDOUT_LOG;
  if (explicit) return explicit;
  const conventional = `${dataDir}/logs/omniroute.log`;
  return existsSync(conventional) ? conventional : null;
}

/**
 * True when `fd` refers to the same file as `path`.
 *
 * Used by the tests to prove the inode survives rotation — the whole point of
 * copy-truncate. Exported because that property is the specification, not an
 * implementation detail.
 */
export function fdPointsAtSameFile(fd: number, path: string): boolean {
  try {
    const a = fstatSync(fd);
    const b = statSync(path);
    return a.ino === b.ino && a.dev === b.dev;
  } catch {
    return false;
  }
}

/** Open a file the way a supervisor would, for tests and for callers that need it. */
export function openAppendFd(path: string): number {
  return openSync(path, "a");
}

export function closeFd(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Best effort.
  }
}
