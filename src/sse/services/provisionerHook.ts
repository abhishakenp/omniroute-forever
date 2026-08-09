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

const PROVISIONER_URL =
  (process.env.PROVISIONER_URL as string | undefined) ?? "http://localhost:20129";

// Track in-flight provisioning per provider to avoid duplicate triggers
const inFlightProviders = new Map<string, Promise<void>>();
let allProvisioningInFlight: Promise<void> | null = null;

// Cooldown: don't re-trigger provisioning for the same provider within this window
const PER_PROVIDER_COOLDOWN_MS = 30_000; // 30s
const ALL_PROVIDERS_COOLDOWN_MS = 60_000; // 60s
const lastTriggerTime = new Map<string, number>();
let lastAllTrigger = 0;

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
 * Trigger provisioning for a single provider in the background.
 * Non-blocking — returns immediately. The provisioner streams new keys
 * directly into OmniRoute via its own API client.
 *
 * Deduplicated: if provisioning for this provider is already in-flight
 * or within cooldown, this is a no-op.
 */
export function triggerProviderProvisioning(provider: string): void {
  const now = Date.now();
  const lastTime = lastTriggerTime.get(provider) ?? 0;
  if (now - lastTime < PER_PROVIDER_COOLDOWN_MS) {
    return; // cooldown active
  }
  if (inFlightProviders.has(provider)) {
    return; // already provisioning
  }

  lastTriggerTime.set(provider, now);
  log.info(
    "PROVISIONER_HOOK",
    `Triggering background provisioning for provider: ${provider}`
  );

  const promise = (async () => {
    try {
      const res = await fetch(`${PROVISIONER_URL}/provision/${provider}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skipOmniRoute: false }),
        signal: AbortSignal.timeout(180_000), // 3 min max per provider
      });
      const data = await res.json();
      if (data.success) {
        log.info(
          "PROVISIONER_HOOK",
          `✅ ${provider} provisioned: ${data.apiKey?.slice(0, 12)}... (added to OmniRoute)`
        );
      } else {
        log.warn(
          "PROVISIONER_HOOK",
          `❌ ${provider} provisioning failed: ${data.error}`
        );
      }
    } catch (err: any) {
      log.warn(
        "PROVISIONER_HOOK",
        `${provider} provisioning error: ${err?.message || "unknown"}`
      );
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
 * Wait for a specific provider's provisioning to complete,
 * then return immediately so the caller can retry with the new key.
 *
 * Returns true if provisioning completed (key may now be available),
 * false if timed out or no provisioning was in-flight.
 */
export async function waitForProviderProvisioning(
  provider: string,
  timeoutMs = 60_000
): Promise<boolean> {
  const promise = inFlightProviders.get(provider);
  if (!promise) return false;

  try {
    await Promise.race([
      promise,
      new Promise<boolean>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), timeoutMs)
      ),
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait for ANY provisioning round to produce at least one new key.
 * Used when all providers are exhausted and we need the first key
 * to arrive before retrying.
 *
 * Returns true if at least one provisioning completed, false if timed out.
 */
export async function waitForAnyProvisioning(
  timeoutMs = 90_000
): Promise<boolean> {
  const allPromises = Array.from(inFlightProviders.values());
  if (allPromises.length === 0 && !allProvisioningInFlight) return false;

  const promises = [...allPromises];
  if (allProvisioningInFlight) promises.push(allProvisioningInFlight);

  try {
    // Wait for the FIRST one to complete
    await Promise.race([
      Promise.any(promises),
      new Promise<boolean>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), timeoutMs)
      ),
    ]);
    return true;
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
