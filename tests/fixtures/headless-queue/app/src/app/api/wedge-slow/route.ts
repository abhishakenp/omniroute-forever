/**
 * Stub route simulating a chat handler stuck walking exhausted upstream
 * accounts (slow upstream cascade). Honors request.signal so we can observe
 * whether the server propagates client disconnects / deadlines into handlers.
 */
export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const ms = Number(url.searchParams.get("ms") ?? "60000");
  const started = Date.now();
  let aborted = false;
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => resolve(), ms);
      request.signal?.addEventListener(
        "abort",
        () => {
          aborted = true;
          clearTimeout(t);
          reject(new Error("aborted"));
        },
        { once: true }
      );
    });
    return Response.json({ ok: true, waitedMs: Date.now() - started });
  } catch {
    return Response.json({ ok: false, aborted: true, waitedMs: Date.now() - started });
  }
}
