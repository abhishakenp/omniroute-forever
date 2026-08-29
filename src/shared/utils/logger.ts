/**
 * Minimal console-based logger — replaces pino + pino-pretty.
 * Same API surface: logger.info/warn/error/debug/trace + child({ module }).
 * Saves ~9MB (pino-pretty) + pino overhead.
 */

type LogFn = (obj?: unknown, msg?: string, ...args: unknown[]) => void;

interface Logger {
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  debug: LogFn;
  trace: LogFn;
  fatal: LogFn;
  child: (bindings: { module?: string; [k: string]: unknown }) => Logger;
  level: string;
}

const LEVELS: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const currentLevel = LEVELS[process.env.LOG_LEVEL?.toLowerCase() || (process.env.NODE_ENV === "production" ? "info" : "debug")] ?? LEVELS.info;

function formatTime(): string {
  const d = new Date();
  return (
    String(d.getHours()).padStart(2, "0") + ":" +
    String(d.getMinutes()).padStart(2, "0") + ":" +
    String(d.getSeconds()).padStart(2, "0") + "." +
    String(d.getMilliseconds()).padStart(3, "0")
  );
}

const COLORS: Record<string, string> = {
  trace: "\x1b[90m",
  debug: "\x1b[34m",
  info: "\x1b[32m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
  fatal: "\x1b[31m\x1b[1m",
};
const RESET = "\x1b[0m";

function logFn(level: string, moduleTag: string): LogFn {
  const levelNum = LEVELS[level] ?? 30;
  if (levelNum < currentLevel) return () => {};

  const color = COLORS[level] || "";
  const timeStr = () => formatTime();

  return (obj?: unknown, msg?: string, ...args: unknown[]) => {
    let message = "";
    let data: unknown = undefined;

    if (typeof obj === "string") {
      message = obj;
      if (msg) args = [msg, ...args];
    } else if (obj && typeof obj === "object") {
      data = obj;
      message = msg || "";
    } else {
      message = msg || String(obj ?? "");
    }

    const moduleStr = moduleTag ? `[${moduleTag}]` : "";
    const prefix = `${color}${timeStr()} ${level.toUpperCase().padEnd(5)}${RESET} ${moduleStr}`;

    if (data && typeof data === "object") {
      const err = (data as any).err || (data as any).error;
      if (err instanceof Error) {
        console[level === "fatal" || level === "error" ? "error" : level === "warn" ? "warn" : "log"](
          `${prefix} ${message} ${err.message}`,
        );
        return;
      }
      // Print compact JSON for data
      const compact = Object.keys(data as object)
        .filter((k) => k !== "module")
        .map((k) => `${k}=${(data as any)[k]}`)
        .join(" ");
      console[level === "fatal" || level === "error" ? "error" : level === "warn" ? "warn" : "log"](
        `${prefix} ${message}${compact ? " " + compact : ""}`,
      );
    } else {
      console[level === "fatal" || level === "error" ? "error" : level === "warn" ? "warn" : "log"](
        `${prefix} ${message}${args.length ? " " + args.join(" ") : ""}`,
      );
    }
  };
}

function createLoggerImpl(moduleTag: string): Logger {
  return {
    info: logFn("info", moduleTag),
    warn: logFn("warn", moduleTag),
    error: logFn("error", moduleTag),
    debug: logFn("debug", moduleTag),
    trace: logFn("trace", moduleTag),
    fatal: logFn("fatal", moduleTag),
    child: (bindings: { module?: string; [k: string]: unknown }) =>
      createLoggerImpl(bindings.module || moduleTag),
    level: "",
  };
}

export const logger: Logger = createLoggerImpl("");

export function createLogger(module: string): Logger {
  return createLoggerImpl(module);
}
