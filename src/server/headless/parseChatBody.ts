/**
 * Read a /v1/chat/completions body without letting a bad one become a 500.
 *
 * `request.json()` throws `SyntaxError: Unexpected end of JSON input` on an
 * empty or truncated body, which the gateway's catch-all reported as a 500
 * "Gateway error" and logged with a stack. That is the client's mistake, so
 * it gets a 400 in the OpenAI error shape and nothing is logged as a fault.
 */
export type ParsedChatBody =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: Response };

const invalid = (message: string): ParsedChatBody => ({
  ok: false,
  response: Response.json(
    { error: { message, type: "invalid_request_error", param: null, code: "invalid_json" } },
    { status: 400 },
  ),
});

export const parseChatBody = async (request: Request): Promise<ParsedChatBody> => {
  let text: string;
  try {
    text = await request.text();
  } catch (err) {
    return invalid(`Could not read the request body: ${(err as Error)?.message ?? String(err)}`);
  }
  if (!text.trim()) return invalid("The request body is empty; expected a JSON object.");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (err) {
    return invalid(`The request body is not valid JSON: ${(err as Error)?.message ?? String(err)}`);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return invalid("The request body must be a JSON object.");
  }
  return { ok: true, body: body as Record<string, unknown> };
};
