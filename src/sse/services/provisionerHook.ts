/**
 * Provisioner Hook — reactive auto-scaling integration.
 *
 * When OmniRoute detects rate-limiting or quota exhaustion, this module
 * triggers the external provisioner service to create new accounts.
 *
 * Design:
 * - Non-blocking: provisioning runs in background, doesn't stall the request
 * - Per-provider: only the exhausted provider gets provisioned
 * - Deduplicated: won't re-trigger provisioning for the same provider if
 *   one is already in-flight
 * - Streaming: new keys are added to OmniRoute as they arrive via the API
 *
 * Flow:
 *   Provider A 429 → fire provisionProvider("groq") in background
 *   → fallback to Provider B (continues serving request)
 *   → by the time Provider B also 429s, Provider A's new key may be ready
 *   → if ALL providers 429, provisionAll() fires in parallel
 *   → first key to arrive gets added, request retries with it
 */

import { logger as log } from "@/shared/utils/logger";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const PROVISIONER_URL =
  (process.env.PROVISIONER_URL as string | undefined) ?? "http://localhost:20129";

// Track in-flight provisioning per provider to avoid duplicate triggers
const inFlightProviders = new Map<string, Promise<void>>();
// Track all providers that have been triggered (persists after fetch resolves)
const triggeredProviderSet = new Set<string>();
let allProvisioningInFlight: Promise<void> | null = null;

// Cooldown: don't re-trigger provisioning for the same provider within this window
const PER_PROVIDER_COOLDOWN_MS = 30_000; // 30s
const ALL_PROVIDERS_COOLDOWN_MS = 60_000; // 60s
const lastTriggerTime = new Map<string, number>();
let lastAllTrigger = 0;

// Auto-start: ensure provisioner is running before triggering provisioning
let provisionerStartPromise: Promise<void> | null = null;
const PROVISIONER_SCRIPT = resolve(process.cwd(), "../account-provisioner/start-provisioner.sh");
const PROVISIONER_SCRIPT_ALT = resolve(
  process.env.HOME || "/Users/abhi",
  "proj/account-provisioner/start-provisioner.sh"
);

/**
 * Check if the provisioner service is available.
 */
export async function isProvisionerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${PROVISIONER_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Auto-start the provisioner server if it's not running.
 * Uses the start-provisioner.sh script in the account-provisioner project.
 * Deduplicated — only one start attempt at a time.
 */
export async function ensureProvisionerRunning(): Promise<boolean> {
  // Already alive — no-op
  if (await isProvisionerAlive()) return true;

  // Already trying to start — wait for it
  if (provisionerStartPromise) {
    try {
      await provisionerStartPromise;
    } catch {
      // start failed — fall through to retry
    }
    return isProvisionerAlive();
  }

  provisionerStartPromise = (async () => {
    const script = existsSync(PROVISIONER_SCRIPT)
      ? PROVISIONER_SCRIPT
      : existsSync(PROVISIONER_SCRIPT_ALT)
        ? PROVISIONER_SCRIPT_ALT
        : null;

    if (!script) {
      log.warn(
        "PROVISIONER_HOOK",
        `Cannot auto-start provisioner — start-provisioner.sh not found at ${PROVISIONER_SCRIPT} or ${PROVISIONER_SCRIPT_ALT}`
      );
      return;
    }

    log.info("PROVISIONER_HOOK", `🔧 Provisioner not running — auto-starting from ${script}`);

    try {
      const child = spawn("bash", [script, "--bg"], {
        detached: true,
        stdio: "ignore",
        cwd: resolve(script, ".."),
      });
      child.unref();

      // Wait for health check to pass (up to 15s)
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (await isProvisionerAlive()) {
          log.info("PROVISIONER_HOOK", `✅ Provisioner auto-started successfully`);
          return;
        }
      }
      log.warn("PROVISIONER_HOOK", `Provisioner auto-start timed out — health check never passed`);
    } catch (err: any) {
      log.warn("PROVISIONER_HOOK", `Provisioner auto-start failed: ${err?.message || "unknown"}`);
    }
  })();

  try {
    await provisionerStartPromise;
  } finally {
    provisionerStartPromise = null;
  }
  return isProvisionerAlive();
}

/**
 * Trigger provisioning for a single provider in the background.
 * Non-blocking — returns immediately. The provisioner streams new keys
 * directly into OmniRoute via its own API client.
 *
 * Deduplicated: if provisioning for this provider is already in-flight
 * or within cooldown, this is a no-op.
 *
 * Non-provisionable providers (no-auth, browser, CLI) are skipped — the
 * provisioner has no module for them, so firing a fetch would just 404.
 */

// Providers that the provisioner has modules for. Fetched once from
// /status and cached. Non-provisionable providers (no-auth like opencode,
// g4f-*, hackclub, auggie, etc.) are skipped to avoid wasted 404s.
let provisionableProvidersCache: Set<string> | null = null;
let provisionableProvidersFetchTime = 0;
const PROVISIONABLE_CACHE_TTL_MS = 60_000; // refresh every 60s

async function getProvisionableProviders(): Promise<Set<string>> {
  const now = Date.now();
  if (
    provisionableProvidersCache &&
    now - provisionableProvidersFetchTime < PROVISIONABLE_CACHE_TTL_MS
  ) {
    return provisionableProvidersCache;
  }
  try {
    await ensureProvisionerRunning();
    const res = await fetch(`${PROVISIONER_URL}/status`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return provisionableProvidersCache ?? new Set();
    const data = (await res.json()) as { providers?: string[] };
    provisionableProvidersCache = new Set(data.providers ?? []);
    provisionableProvidersFetchTime = now;
  } catch {
    // keep stale cache or empty set
  }
  return provisionableProvidersCache ?? new Set();
}

export function triggerProviderProvisioning(provider: string): void {
  const now = Date.now();
  const lastTime = lastTriggerTime.get(provider) ?? 0;
  const cooldownRemaining = PER_PROVIDER_COOLDOWN_MS - (now - lastTime);
  log.info(
    "PROVISIONER_HOOK",
    `triggerProviderProvisioning called for ${provider} — lastTime=${lastTime}, now=${now}, cooldownRemaining=${cooldownRemaining}ms, inFlight=${inFlightProviders.has(provider)}`
  );
  if (now - lastTime < PER_PROVIDER_COOLDOWN_MS) {
    return; // cooldown active
  }
  if (inFlightProviders.has(provider)) {
    return; // already provisioning
  }

  lastTriggerTime.set(provider, now);
  triggeredProviderSet.add(provider);

  const promise = (async () => {
    try {
      // Check if this provider is provisionable (has a provisioner module)
      const provisionable = await getProvisionableProviders();
      if (!provisionable.has(provider)) {
        log.info(
          "PROVISIONER_HOOK",
          `${provider} has no provisioner module — skipping (non-provisionable provider)`
        );
        return;
      }
      // Auto-start provisioner if it's not running (reactive, no polling)
      await ensureProvisionerRunning();
      const res = await fetch(`${PROVISIONER_URL}/provision/${provider}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skipOmniRoute: false, async: true }),
        signal: AbortSignal.timeout(10_000), // 10s — async mode returns immediately
      });
      const data = await res.json();
      if (data.triggered) {
        log.info(
          "PROVISIONER_HOOK",
          `✅ ${provider} provisioning triggered in background (job: ${data.jobId})`
        );
      } else if (data.success) {
        log.info(
          "PROVISIONER_HOOK",
          `✅ ${provider} provisioned: ${data.apiKey?.slice(0, 12)}... (added to OmniRoute)`
        );
      } else {
        log.warn("PROVISIONER_HOOK", `❌ ${provider} provisioning failed: ${data.error}`);
      }
    } catch (err: any) {
      log.warn("PROVISIONER_HOOK", `${provider} provisioning error: ${err?.message || "unknown"}`);
    } finally {
      inFlightProviders.delete(provider);
    }
  })();

  inFlightProviders.set(provider, promise);
}

/**
 * Trigger provisioning for ALL providers in parallel.
 * Used when the entire fallback chain is exhausted.
 *
 * Non-blocking — returns immediately. Keys stream in as they're provisioned.
 */
export function triggerAllProvidersProvisioning(providers?: string[]): void {
  const now = Date.now();
  if (now - lastAllTrigger < ALL_PROVIDERS_COOLDOWN_MS) {
    return; // global cooldown active
  }
  if (allProvisioningInFlight) {
    return; // already provisioning all
  }

  lastAllTrigger = now;
  log.info(
    "PROVISIONER_HOOK",
    `🚨 All providers exhausted — triggering parallel provisioning${providers ? ` for: ${providers.join(", ")}` : ""}`
  );

  allProvisioningInFlight = (async () => {
    try {
      // Auto-start provisioner if it's not running (reactive, no polling)
      await ensureProvisionerRunning();
      const res = await fetch(`${PROVISIONER_URL}/provision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers, skipOmniRoute: false }),
        signal: AbortSignal.timeout(300_000), // 5 min max for all
      });
      const data = await res.json();
      log.info(
        "PROVISIONER_HOOK",
        `Provisioning round triggered: ${data.triggered ? "started" : "failed"}`
      );
    } catch (err: any) {
      log.warn(
        "PROVISIONER_HOOK",
        `All-providers provisioning error: ${err?.message || "unknown"}`
      );
    } finally {
      allProvisioningInFlight = null;
    }
  })();
}

/**
 * Wait for a specific provider's provisioning to complete.
 * Uses SSE stream from the provisioner's /stream endpoint — no polling.
 * The provisioner streams events as new keys are added to OmniRoute.
 *
 * Returns true if a new key was detected, false if timed out.
 */
export async function waitForProviderProvisioning(
  provider: string,
  timeoutMs = 60_000
): Promise<boolean> {
  const promise = inFlightProviders.get(provider);
  if (!promise) return false;

  // Wait for the fetch itself to complete (fast — async mode returns quickly)
  try {
    await promise;
  } catch {
    // fetch error — provisioning may still be running in SDK server
  }

  // Subscribe to provisioner SSE stream — reactive, no polling
  return waitForProvisioningStream(provider, timeoutMs);
}

/**
 * Wait for ANY provisioning round to produce at least one new key.
 * Uses SSE stream from the provisioner's /stream endpoint — no polling.
 *
 * Returns true if at least one provisioning completed, false if timed out.
 */
export async function waitForAnyProvisioning(timeoutMs = 120_000): Promise<boolean> {
  const triggeredProviders = Array.from(triggeredProviderSet);
  if (triggeredProviders.length === 0 && !allProvisioningInFlight) return false;

  // Subscribe to provisioner SSE stream — reactive, no polling
  return waitForProvisioningStream(null, timeoutMs);
}

/**
 * Subscribe to the provisioner's SSE stream and wait for a new key event.
 * The provisioner streams JSON events: {"type":"key-added","provider":"cohere","key":"..."}
 * If provider is null, waits for ANY provider's key. Otherwise waits for the specific provider.
 * No polling — purely event-driven via SSE.
 */
async function waitForProvisioningStream(
  provider: string | null,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  try {
    // Ensure provisioner is running before subscribing to stream
    await ensureProvisionerRunning();
    const res = await fetch(`${PROVISIONER_URL}/stream`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "text/event-stream" },
    });
    if (!res.ok || !res.body) {
      // SSE not available — fall back to a single check
      log.warn("PROVISIONER_HOOK", `SSE stream unavailable (${res.status}) — doing single check`);
      return checkForNewKeys(provider);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent = "";

    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim();
          continue;
        }
        if (!line.startsWith("data: ")) continue;
        try {
          const data = JSON.parse(line.slice(6));
          // Match on SSE event type OR data.type field
          const eventType = data.type || currentEvent;
          if (eventType === "key-added" || eventType === "provisioned" || eventType === "key") {
            if (data.success !== false && (!provider || data.provider === provider)) {
              log.info("PROVISIONER_HOOK", `SSE: new ${data.provider || provider} key detected`);
              reader.cancel();
              return true;
            }
          }
        } catch {
          // malformed SSE line — skip
        }
        currentEvent = "";
      }
    }
    reader.cancel();
  } catch (err: any) {
    // SSE stream failed — fall back to single check (not polling)
    log.warn("PROVISIONER_HOOK", `SSE stream error: ${err?.message} — single check fallback`);
    return checkForNewKeys(provider);
  }
  return false;
}

/**
 * Single non-polling check: query OmniRoute connections once for new keys.
 * Used as a fallback when SSE is unavailable. Does NOT loop.
 */
async function checkForNewKeys(provider: string | null): Promise<boolean> {
  try {
    const res = await fetch("http://localhost:20128/api/providers", {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const data = await res.json();
    const conns = data.connections || [];
    const now = Date.now();
    const recent = conns.find((c: any) => {
      const created = new Date(c.createdAt).getTime();
      return now - created < 120_000 && (!provider || c.provider === provider);
    });
    return !!recent;
  } catch {
    return false;
  }
}

/**
 * Get the list of providers currently being provisioned.
 */
export function getInFlightProviders(): string[] {
  return Array.from(inFlightProviders.keys());
}

/**
 * Delete a dead account from the provisioner's account store.
 * Called when OmniRoute detects a permanent 401/402 failure — the account is
 * confidently invalid (not rate-limited) and should be removed, not marked depleted.
 * Rate-limited accounts (429) must NOT be deleted — they're temporarily unavailable.
 *
 * After deleting, automatically triggers re-provisioning for that provider
 * to replenish the lost account. This ensures terminal failures (banned,
 * credits_exhausted, expired) don't reduce long-term capacity.
 */
export async function deleteDeadAccount(provider: string, apiKey: string): Promise<void> {
  try {
    await ensureProvisionerRunning();
    const res = await fetch(`${PROVISIONER_URL}/accounts/${provider}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      log.info(
        "PROVISIONER_HOOK",
        `Dead ${provider} account deleted from store (401/402) — triggering replenish`
      );
      // Auto-replenish: trigger provisioning for this provider to replace the dead account
      triggerProviderProvisioning(provider);
    }
  } catch (err: any) {
    log.warn(
      "PROVISIONER_HOOK",
      `Failed to delete dead ${provider} account: ${err?.message || "unknown"}`
    );
  }
}
