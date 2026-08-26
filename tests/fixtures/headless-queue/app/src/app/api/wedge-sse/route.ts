/**
 * Stub SSE route: streams large chunks continuously while honoring
 * request.signal, so the server-side response stream is always faster than a
 * paused/parked client. Used to prove the backpressure drain-wait cannot pin
 * a slot after client disconnect.
 */
export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  // mode=slow: sub-highWaterMark chunks delivered slowly — the server spends
  // its time inside reader.read(), exercising the disconnect-during-read path.
  const chunk = new TextEncoder().encode(
    url.searchParams.get("mode") === "slow" ? "x".repeat(8 * 1024) : "x".repeat(64 * 1024)
  );
  const delay = url.searchParams.get("mode") === "slow" ? 250 : 5;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let i = 0;
      const pump = () => {
        if (i >= 100000 || request.signal?.aborted) {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
          return;
        }
        i++;
        try {
          controller.enqueue(chunk);
        } catch {
          return; // cancelled mid-stream; stop the pump chain
        }
        setTimeout(pump, delay);
      };
      pump();
    },
    cancel() {
      /* upstream cancelled via signal */
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}
