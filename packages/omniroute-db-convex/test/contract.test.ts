/**
 * Verify the Convex adapter satisfies the DbAdapter contract.
 *
 * The seam's `audit()` method checks that the adapter has every method in
 * `DB_ADAPTER_METHODS`. This test constructs the adapter without connecting
 * to a real Convex deployment (we mock the client) and verifies the
 * interface is complete.
 */
import { describe, it, expect } from "vitest";

// A mock context that satisfies the Cordis Service constructor.
// The Service constructor calls `ctx.reflect.provide(name, self, check)`.
function mockCtx() {
  const reflect = {
    provide: () => {},
  };
  return {
    get: () => null,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: () => () => {},
    reflect,
  };
}

describe("Convex adapter contract", () => {
  it("implements all DbAdapter methods", async () => {
    const { DB_ADAPTER_METHODS } = await import("../../omniroute-db/src/index.ts");
    const { ConvexAdapterService } = await import("../src/index.ts");

    const svc = new ConvexAdapterService(mockCtx() as any, {
      deploymentUrl: "https://test.convex.cloud",
      apiKey: "",
      closeOnUnload: false,
    } as any);

    // Check every method in the contract.
    const missing = DB_ADAPTER_METHODS.filter((m) => typeof (svc as any)[m] !== "function");
    expect(missing).toEqual([]);
  });

  it("kind() returns 'convex'", async () => {
    const { ConvexAdapterService } = await import("../src/index.ts");
    const svc = new ConvexAdapterService(mockCtx() as any, {
      deploymentUrl: "https://test.convex.cloud",
      apiKey: "",
      closeOnUnload: false,
    } as any);
    expect(svc.kind()).toBe("convex");
  });

  it("createTargetCursor returns a cursor with the right interface", async () => {
    const { ConvexAdapterService } = await import("../src/index.ts");
    const svc = new ConvexAdapterService(mockCtx() as any, {
      deploymentUrl: "https://test.convex.cloud",
      apiKey: "",
      closeOnUnload: false,
    } as any);
    const cursor = svc.createTargetCursor();
    expect(typeof cursor.nextTarget).toBe("function");
    expect(typeof cursor.markFailed).toBe("function");
    expect(typeof cursor.markSucceeded).toBe("function");
    expect(cursor.triedProviders).toBeInstanceOf(Set);
  });

  it("seam audit passes for the Convex adapter", async () => {
    const { DbSeamService } = await import("../../omniroute-db/src/index.ts");
    const { ConvexAdapterService } = await import("../src/index.ts");

    const seam = new DbSeamService(mockCtx() as any, { strict: true } as any);
    const svc = new ConvexAdapterService(mockCtx() as any, {
      deploymentUrl: "https://test.convex.cloud",
      apiKey: "",
      closeOnUnload: false,
    } as any);

    const missing = seam.missing(svc);
    expect(missing).toEqual([]);
  });
});
