// Stub — access token auth removed with dashboard authz pipeline.
export type AccessTokenVerdict =
  | { kind: "absent" }
  | { kind: "ok" }
  | { kind: "invalid" }
  | { kind: "insufficient"; have: string; need: string }
  | { kind: "error" };

export function evaluateAccessTokenAuth(_request: Request): AccessTokenVerdict {
  return { kind: "absent" };
}
