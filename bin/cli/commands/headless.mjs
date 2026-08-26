import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

export function registerHeadless(program) {
  program
    .command("headless")
    .description("Start headless API server (no Next.js, no turbopack — lowest resource usage)")
    .option("--port <port>", "Port to listen on", "20128")
    .option("--host <addr>", "Bind address", "0.0.0.0")
    .action(async (opts) => {
      const env = {
        ...process.env,
        PORT: opts.port,
        HOST: opts.host,
        NODE_ENV: "production",
        OMNIROUTE_HEADLESS: "1",
      };
      const child = spawn(
        process.execPath,
        ["--import", "tsx/esm", join(ROOT, "scripts", "dev", "run-headless.mjs")],
        { stdio: "inherit", env, cwd: ROOT }
      );
      child.on("exit", (code) => process.exit(code ?? 0));
    });
}
