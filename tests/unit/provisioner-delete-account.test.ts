/**
 * C1 — the provisioner delete must account for its own failures.
 *
 * The bug: `deleteDeadAccount()` returned `Promise<void>` and only logged when
 * `res.ok`. A provisioner that answered 500, or that was not running at all,
 * produced exactly the same observable result as a successful delete. Its only
 * caller then wrote `.catch(() => {})`, discarding even the throw. So a
 * credential OmniRoute had given up on stayed in the provisioner's store and
 * kept being re-issued, with nothing anywhere saying why.
 *
 * The function was also misleadingly named: it never touched OmniRoute's own
 * `provider_connections` (local retirement belongs to `TargetIterator.markFailed`),
 * yet "deleteDeadAccount" read as though it retired the credential everywhere.
 * It is now `deleteProvisionerAccount`, and it takes the connection id purely so
 * a failure is traceable to a specific credential.
 */

import test from "node:test";
import assert from "node:assert/strict";

const hook = await import("@/sse/services/provisionerHook");

type FetchCall = { url: string; method?: string };

/**
 * Install a fetch stub. `/health` always answers 200 so
 * `ensureProvisionerRunning()` short-circuits without spawning anything;
 * `/accounts/*` is driven by `accountResponses`, consumed one per attempt.
 */
function stubFetch(accountResponses: Array<Response | Error>) {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
    const url = String((input as { url?: string })?.url ?? input);
    calls.push({ url, method: init?.method });
    if (url.includes("/health")) return new Response("ok", { status: 200 });
    const next = accountResponses[Math.min(i, accountResponses.length - 1)];
    i++;
    if (next instanceof Error) throw next;
    // Responses are single-use; clone so a retry sequence can reuse the entry.
    return next.clone();
  }) as typeof globalThis.fetch;
  return {
    calls,
    accountCalls: () => calls.filter((c) => c.url.includes("/accounts/")),
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test("a successful delete reports ok and how many attempts it took", async () => {
  const f = stubFetch([new Response("{}", { status: 200 })]);
  try {
    const outcome = await hook.deleteProvisionerAccount("mistral", "sk-dead", "conn-1");
    assert.equal(outcome.ok, true);
    assert.equal(outcome.attempts, 1);
    assert.equal(outcome.status, 200);
    assert.equal(f.accountCalls().length, 1);
    assert.equal(f.accountCalls()[0].method, "DELETE");
  } finally {
    f.restore();
  }
});

test("REGRESSION: a non-ok response is reported as a failure, not swallowed", async () => {
  // Before the fix this returned undefined and looked exactly like success.
  const f = stubFetch([new Response("nope", { status: 500 })]);
  try {
    const outcome = await hook.deleteProvisionerAccount("mistral", "sk-dead", "conn-2");
    assert.equal(outcome.ok, false);
    assert.equal(outcome.status, 500);
    assert.equal(outcome.reason, "http-server-error");
    assert.ok(outcome.detail?.includes("500"));
  } finally {
    f.restore();
  }
});

test("a 5xx is retried on a BOUNDED schedule, then gives up", async () => {
  const f = stubFetch([new Response("nope", { status: 503 })]);
  try {
    const outcome = await hook.deleteProvisionerAccount("mistral", "sk-dead", "conn-3");
    assert.equal(outcome.ok, false);
    // Bounded: it must retry, and it must stop.
    assert.equal(outcome.attempts, 3);
    assert.equal(f.accountCalls().length, 3);
  } finally {
    f.restore();
  }
});

test("a 4xx that is not retriable is NOT retried", async () => {
  // Retrying a 403 just wastes the provisioner's time; the answer will not change.
  const f = stubFetch([new Response("forbidden", { status: 403 })]);
  try {
    const outcome = await hook.deleteProvisionerAccount("mistral", "sk-dead", "conn-4");
    assert.equal(outcome.ok, false);
    assert.equal(outcome.attempts, 1);
    assert.equal(outcome.reason, "http-client-error");
    assert.equal(f.accountCalls().length, 1);
  } finally {
    f.restore();
  }
});

test("a 429 IS retried — the provisioner is busy, not refusing", async () => {
  const f = stubFetch([new Response("slow down", { status: 429 })]);
  try {
    const outcome = await hook.deleteProvisionerAccount("mistral", "sk-dead", "conn-5");
    assert.equal(outcome.attempts, 3);
  } finally {
    f.restore();
  }
});

test("a 404 counts as success — delete is idempotent", async () => {
  // The post-condition we want is "the store does not hold this key". A 404
  // means it already does not. Retrying would be pure waste.
  const f = stubFetch([new Response("not found", { status: 404 })]);
  try {
    const outcome = await hook.deleteProvisionerAccount("mistral", "sk-dead", "conn-6");
    assert.equal(outcome.ok, true);
    assert.equal(outcome.status, 404);
    assert.equal(f.accountCalls().length, 1);
  } finally {
    f.restore();
  }
});

test("REGRESSION: 200 {deleted:false} is 'already gone' and does not replenish", async () => {
  // The provisioner answers 200 {deleted:false} for a key it no longer holds.
  // The same dead conn is reported up to AUTH_DEAD_AFTER_LEVEL times, and each
  // repeat used to log "removed" and launch a fresh provisioning run.
  const f = stubFetch([Response.json({ deleted: false, message: "account not found" })]);
  try {
    const outcome = await hook.deleteProvisionerAccount("p-gone", "sk-dead", "conn-9");
    assert.equal(outcome.ok, true);
    assert.equal(outcome.alreadyGone, true);
    // No replenish fired, so p-gone is not in cooldown: a fresh trigger starts.
    assert.equal(hook.triggerProviderProvisioning("p-gone"), "started");
  } finally {
    f.restore();
  }
});

test("a delete that really removed the key triggers replenish", async () => {
  const f = stubFetch([Response.json({ deleted: true, provider: "p-real", email: "x@y" })]);
  try {
    const outcome = await hook.deleteProvisionerAccount("p-real", "sk-dead", "conn-10");
    assert.equal(outcome.ok, true);
    assert.equal(outcome.alreadyGone, undefined);
    // Replenish fired, so an immediate second trigger is suppressed by cooldown.
    assert.equal(hook.triggerProviderProvisioning("p-real"), "cooldown");
  } finally {
    f.restore();
  }
});

test("REGRESSION: a rejected fetch is reported, not discarded", async () => {
  const f = stubFetch([new Error("ECONNREFUSED")]);
  try {
    const outcome = await hook.deleteProvisionerAccount("mistral", "sk-dead", "conn-7");
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, "network");
    assert.equal(outcome.detail, "ECONNREFUSED");
    assert.equal(outcome.attempts, 3, "a transport fault must be retried, boundedly");
  } finally {
    f.restore();
  }
});

test("a transient failure that recovers is reported as success", async () => {
  const f = stubFetch([
    new Response("nope", { status: 500 }),
    new Response("{}", { status: 200 }),
  ]);
  try {
    const outcome = await hook.deleteProvisionerAccount("mistral", "sk-dead", "conn-8");
    assert.equal(outcome.ok, true);
    assert.equal(outcome.attempts, 2);
  } finally {
    f.restore();
  }
});

test("the old misleading name is gone", () => {
  // It claimed to delete a "dead account" outright; it only ever told the
  // external provisioner. Local retirement lives in TargetIterator.markFailed.
  assert.equal(
    (hook as Record<string, unknown>).deleteDeadAccount,
    undefined,
    "deleteDeadAccount must no longer be exported under its misleading name"
  );
  assert.equal(typeof hook.deleteProvisionerAccount, "function");
});
