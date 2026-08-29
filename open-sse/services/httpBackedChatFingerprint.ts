/**
 * Header fingerprint resolution for `httpBackedChat()`.
 *
 * claude.ai MUST reuse the exact fingerprint the Turnstile solver used to
 * mint `cf_clearance` — otherwise Cloudflare rejects the replayed cookie and
 * every request 429s (#7548). Other `httpBackedChat` callers keep their
 * own independent fingerprint, which never needs to match a solved cookie.
 *
 * claudeWebFingerprint.ts was removed for thin API gateway; the constant is
 * inlined here to preserve the interface.
 */
export interface HttpBackedChatFingerprint {
  userAgent: string;
  secChUa: string;
  secChUaPlatform: string;
}

const CLAUDE_WEB_FINGERPRINT: HttpBackedChatFingerprint = {
  userAgent:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  secChUa: '"Chromium";v="149", "Not-A.Brand";v="24", "Google Chrome";v="149"',
  secChUaPlatform: '"Linux"',
};

const DUCKDUCKGO_FALLBACK_FINGERPRINT: HttpBackedChatFingerprint = {
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  secChUa: '"Chromium";v="149", "Google Chrome";v="149", "Not-A.Brand";v="99"',
  secChUaPlatform: '"macOS"',
};

export function resolveHttpBackedChatFingerprint(
  chatUrlMatchDomain: string
): HttpBackedChatFingerprint {
  return chatUrlMatchDomain === "claude.ai" ? CLAUDE_WEB_FINGERPRINT : DUCKDUCKGO_FALLBACK_FINGERPRINT;
}
