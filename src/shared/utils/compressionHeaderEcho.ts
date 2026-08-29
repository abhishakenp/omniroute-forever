/**
 * Compression header echo — no-op stub.
 * Compression pipeline removed. These functions kept as no-ops for route compatibility.
 */
export function readCompressionRequestHeader(_request: {
  headers: { get(name: string): string | null };
}): string | null {
  return null;
}

export function withCompressionHeaderEcho(
  response: Response,
  _requestHeaderValue: string | null
): Response {
  return response;
}
