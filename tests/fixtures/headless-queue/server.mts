/**
 * Child-process runner for headless-server queue tests.
 * Starts the REAL headless server against the fixture app dir (so route
 * discovery sees only the stub route) and prints the bound port.
 *
 * Env:
 *   HEADLESS_SERVER_TS  absolute path to server.ts under test
 *   TEST_PORT           port to bind (0 = ephemeral)
 *   + any OMNIROUTE_* tunables under test
 */
import http from "node:http";

const appDir = new URL("./app/", import.meta.url).pathname;
process.chdir(appDir);

function waitListen(port: number, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), timeoutMs);
    const tryOnce = () => {
      const r = http.request({ host: "127.0.0.1", port, path: "/health" }, (res) => {
        res.resume();
        clearTimeout(t);
        resolve(port);
      });
      r.on("error", () => setTimeout(tryOnce, 100));
      r.end();
    };
    tryOnce();
  });
}

const mod = await import(process.env.HEADLESS_SERVER_TS!);
const server = await mod.startHeadlessServer({
  port: Number(process.env.TEST_PORT || 0),
  hostname: "127.0.0.1",
});
const addr = server.address();
if (!addr || typeof addr === "string") throw new Error("no tcp address");
const port = await waitListen(addr.port, 15_000);
console.log(`READY PORT=${port}`);
