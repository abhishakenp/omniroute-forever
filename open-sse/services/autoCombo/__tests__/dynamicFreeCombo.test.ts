import { describe, it, expect, vi } from "vitest";
import {
  buildFreeCandidates,
  probeAllCandidates,
  generateDynamicFreeCombo,
  getLastProbeResults,
  getProbeStateMap,
  getCycleCount,
  _resetProbeState,
  startDynamicFreeComboGenerator,
  stopDynamicFreeComboGenerator,
} from "../dynamicFreeCombo.ts";

// Mock fetch for API-driven candidate building
const mockFetch = vi.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;

// Mock the lazy imports
vi.mock("@/lib/db/combos", () => ({
  getComboById: async (id: string) => ({
    id,
    name: "auto/best-free",
    strategy: "round-robin",
    models: [],
  }),
  updateCombo: async (id: string, data: Record<string, unknown>) => ({ ...data, id }),
}));

vi.mock("@/lib/db/models", () => ({
  getSyncedAvailableModelsByConnection: async (providerId: string) => {
    if (providerId === "groq")
      return {
        c1: [
          { id: "llama-3.3-70b-versatile" },
          { id: "llama-3.1-8b-instant" },
          { id: "m1" },
          { id: "m2" },
        ],
      };
    if (providerId === "mistral")
      return { c2: [{ id: "codestral-latest" }, { id: "mistral-tiny" }] };
    return {};
  },
}));

// GAP 1 test: Mock DB for probe state persistence — use vi.hoisted so the mock
// function exists before vi.mock factory runs (vi.mock is hoisted above imports)
const { mockDbPrepare } = vi.hoisted(() => ({
  mockDbPrepare: vi.fn(),
}));
vi.mock("@/lib/db/core", () => ({
  getDbInstance: () => ({
    prepare: mockDbPrepare,
  }),
}));

vi.mock("@omniroute/open-sse/utils/logger", () => ({
  defaultLogger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

function setupApiMocks() {
  mockFetch.mockImplementation(async (url: string) => {
    const u = url.toString();
    if (u.includes("/api/free-tier/summary")) {
      return {
        ok: true,
        json: async () => ({
          perModel: [
            { provider: "groq", modelId: "llama-3.3-70b-versatile" },
            { provider: "mistral", modelId: "codestral-latest" },
            { provider: "devin-cli", modelId: "claude-sonnet" },
          ],
        }),
      } as unknown as Response;
    }
    if (u.includes("/api/providers")) {
      return {
        ok: true,
        json: async () => ({
          connections: [
            { provider: "groq", isActive: true },
            { provider: "mistral", isActive: true },
            { provider: "devin-cli", isActive: true },
          ],
        }),
      } as unknown as Response;
    }
    if (u.includes("/v1/models")) {
      return {
        ok: true,
        json: async () => ({
          data: [
            {
              id: "groq/llama-3.3-70b-versatile",
              owned_by: "groq",
              root: "llama-3.3-70b-versatile",
              capabilities: { tool_calling: true },
            },
            {
              id: "groq/llama-3.1-8b-instant",
              owned_by: "groq",
              root: "llama-3.1-8b-instant",
              capabilities: { tool_calling: true },
            },
            {
              id: "mistral/codestral-latest",
              owned_by: "mistral",
              root: "codestral-latest",
              capabilities: { tool_calling: true },
            },
            {
              id: "mistral/mistral-tiny",
              owned_by: "mistral",
              root: "mistral-tiny",
              capabilities: { tool_calling: false },
            },
            {
              id: "auto/best-coding",
              owned_by: "combo",
              root: "best-coding",
              capabilities: { tool_calling: true },
            },
          ],
        }),
      } as unknown as Response;
    }
    if (u.includes("/v1/chat/completions")) {
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { tool_calls: [{ function: { name: "get_weather" } }] } }],
        }),
      } as unknown as Response;
    }
    return {
      ok: false,
      json: async () => ({ error: { message: "not found" } }),
    } as unknown as Response;
  });
}

describe("dynamicFreeCombo", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    setupApiMocks();
    _resetProbeState();
    // GAP 1: mock DB prepare to return empty by default (no persisted state)
    mockDbPrepare.mockReturnValue({ get: () => undefined, run: () => {} });
  });

  describe("buildFreeCandidates — API-driven", () => {
    it("fetches free providers from /api/free-tier/summary", async () => {
      const candidates = await buildFreeCandidates(
        "http://localhost:20128",
        new Set(["devin-cli"])
      );
      const fetchUrls = mockFetch.mock.calls.map((c) => c[0].toString());
      expect(fetchUrls.some((u) => u.includes("/api/free-tier/summary"))).toBe(true);
    });

    it("fetches active providers from /api/providers", async () => {
      await buildFreeCandidates("http://localhost:20128", new Set(["devin-cli"]));
      const fetchUrls = mockFetch.mock.calls.map((c) => c[0].toString());
      expect(fetchUrls.some((u) => u.includes("/api/providers"))).toBe(true);
    });

    it("fetches models from /v1/models", async () => {
      await buildFreeCandidates("http://localhost:20128", new Set(["devin-cli"]));
      const fetchUrls = mockFetch.mock.calls.map((c) => c[0].toString());
      expect(fetchUrls.some((u) => u.includes("/v1/models"))).toBe(true);
    });

    it("excludes providers in the excluded set", async () => {
      const candidates = await buildFreeCandidates(
        "http://localhost:20128",
        new Set(["devin-cli"])
      );
      const providers = new Set(candidates.map((c) => c.provider));
      expect(providers.has("devin-cli")).toBe(false);
    });

    it("only includes models with tool_calling=true from /v1/models", async () => {
      const candidates = await buildFreeCandidates(
        "http://localhost:20128",
        new Set(["devin-cli"])
      );
      const tiny = candidates.find((c) => c.modelId === "mistral-tiny");
      expect(tiny).toBeUndefined();
      const codestral = candidates.find((c) => c.modelId === "codestral-latest");
      expect(codestral).toBeDefined();
    });

    it("skips combo/auto routes", async () => {
      const candidates = await buildFreeCandidates(
        "http://localhost:20128",
        new Set(["devin-cli"])
      );
      const autoModels = candidates.filter(
        (c) => c.modelId.startsWith("auto/") || c.modelId.startsWith("combo/")
      );
      expect(autoModels.length).toBe(0);
    });

    it("includes all tool-calling models per provider (not just one)", async () => {
      const candidates = await buildFreeCandidates(
        "http://localhost:20128",
        new Set(["devin-cli"])
      );
      const groqModels = candidates.filter((c) => c.provider === "groq");
      expect(groqModels.length).toBe(2);
    });

    it("respects maxModelsPerProvider cap", async () => {
      const candidates = await buildFreeCandidates(
        "http://localhost:20128",
        new Set(["devin-cli"]),
        1
      );
      const groqModels = candidates.filter((c) => c.provider === "groq");
      expect(groqModels.length).toBe(1);
    });
  });

  describe("probeAllCandidates — tool-calling verification", () => {
    it("probes WITH a tool definition", async () => {
      const candidates = [
        {
          provider: "groq",
          modelId: "llama-3.3-70b-versatile",
          fullModel: "groq/llama-3.3-70b-versatile",
        },
      ];
      const results = await probeAllCandidates(candidates, "key", "http://localhost:20128", 5000);

      const probeCall = mockFetch.mock.calls.find((c) =>
        c[0].toString().includes("/v1/chat/completions")
      );
      expect(probeCall).toBeDefined();
      const body = JSON.parse(probeCall![1].body);
      expect(body.tools).toBeDefined();
      expect(body.tools[0].function.name).toBe("get_weather");
    });

    it("reports hasToolCalls=true when model emits tool_calls", async () => {
      const candidates = [{ provider: "groq", modelId: "m1", fullModel: "groq/m1" }];
      const results = await probeAllCandidates(candidates, "key", "http://localhost:20128", 5000);
      expect(results[0].hasToolCalls).toBe(true);
    });

    it("reports hasToolCalls=false for text-only models", async () => {
      mockFetch.mockReset();
      mockFetch.mockImplementation(async (url: string) => {
        if (url.toString().includes("/v1/chat/completions")) {
          return {
            ok: true,
            json: async () => ({ choices: [{ message: { content: "text only" } }] }),
          } as unknown as Response;
        }
        return { ok: false, json: async () => ({}) } as unknown as Response;
      });

      const candidates = [{ provider: "test", modelId: "m1", fullModel: "test/m1" }];
      const results = await probeAllCandidates(candidates, "key", "http://localhost:20128", 5000);
      expect(results[0].hasToolCalls).toBe(false);
    });

    it("uses adaptive batch size = min(candidates, max_batch)", async () => {
      // 3 candidates with max_batch=10 → should probe all 3 in one batch (1 fetch call group)
      const candidates = [
        { provider: "a", modelId: "m1", fullModel: "a/m1" },
        { provider: "b", modelId: "m2", fullModel: "b/m2" },
        { provider: "c", modelId: "m3", fullModel: "c/m3" },
      ];
      await probeAllCandidates(candidates, "key", "http://localhost:20128", 5000, 10);
      // All 3 should be probed (3 chat/completions calls)
      const probeCalls = mockFetch.mock.calls.filter((c) =>
        c[0].toString().includes("/v1/chat/completions")
      );
      expect(probeCalls.length).toBe(3);
    });
  });

  describe("generateDynamicFreeCombo — adaptive probing", () => {
    it("cold start probes all candidates", async () => {
      mockFetch.mockReset();
      let probeCount = 0;
      mockFetch.mockImplementation(async (url: string) => {
        const u = url.toString();
        if (u.includes("/api/free-tier/summary")) {
          return {
            ok: true,
            json: async () => ({ perModel: [{ provider: "groq", modelId: "m1" }] }),
          } as unknown as Response;
        }
        if (u.includes("/api/providers")) {
          return {
            ok: true,
            json: async () => ({ connections: [{ provider: "groq", isActive: true }] }),
          } as unknown as Response;
        }
        if (u.includes("/v1/models")) {
          return {
            ok: true,
            json: async () => ({
              data: [
                {
                  id: "groq/m1",
                  owned_by: "groq",
                  root: "m1",
                  capabilities: { tool_calling: true },
                },
                {
                  id: "groq/m2",
                  owned_by: "groq",
                  root: "m2",
                  capabilities: { tool_calling: true },
                },
              ],
            }),
          } as unknown as Response;
        }
        if (u.includes("/v1/chat/completions")) {
          probeCount++;
          return {
            ok: true,
            json: async () => ({
              choices: [{ message: { tool_calls: [{ function: { name: "get_weather" } }] } }],
            }),
          } as unknown as Response;
        }
        return { ok: false, json: async () => ({}) } as unknown as Response;
      });

      const result = await generateDynamicFreeCombo(
        "test-id",
        "key",
        "http://localhost:20128",
        new Set(["devin-cli"]),
        2000
      );
      expect(result).toBeGreaterThan(0);
      expect(probeCount).toBe(2); // Both models probed on cold start
    });

    it("warm cycle skips fresh successes (adaptive)", async () => {
      mockFetch.mockReset();
      let probeCount = 0;
      mockFetch.mockImplementation(async (url: string) => {
        const u = url.toString();
        if (u.includes("/api/free-tier/summary")) {
          return {
            ok: true,
            json: async () => ({ perModel: [{ provider: "groq", modelId: "m1" }] }),
          } as unknown as Response;
        }
        if (u.includes("/api/providers")) {
          return {
            ok: true,
            json: async () => ({ connections: [{ provider: "groq", isActive: true }] }),
          } as unknown as Response;
        }
        if (u.includes("/v1/models")) {
          return {
            ok: true,
            json: async () => ({
              data: [
                {
                  id: "groq/m1",
                  owned_by: "groq",
                  root: "m1",
                  capabilities: { tool_calling: true },
                },
              ],
            }),
          } as unknown as Response;
        }
        if (u.includes("/v1/chat/completions")) {
          probeCount++;
          return {
            ok: true,
            json: async () => ({
              choices: [{ message: { tool_calls: [{ function: { name: "get_weather" } }] } }],
            }),
          } as unknown as Response;
        }
        return { ok: false, json: async () => ({}) } as unknown as Response;
      });

      // Cycle 1 (cold start) — probes m1
      await generateDynamicFreeCombo(
        "test-id",
        "key",
        "http://localhost:20128",
        new Set(["devin-cli"]),
        2000
      );
      expect(probeCount).toBe(1);

      // Cycle 2 (warm) — m1 is fresh success, should NOT be re-probed
      await generateDynamicFreeCombo(
        "test-id",
        "key",
        "http://localhost:20128",
        new Set(["devin-cli"]),
        2000
      );
      expect(probeCount).toBe(1); // Still 1 — no re-probe
    });

    it("warm cycle re-probes failures with backoff", async () => {
      mockFetch.mockReset();
      let probeCount = 0;
      let shouldFail = true;
      mockFetch.mockImplementation(async (url: string) => {
        const u = url.toString();
        if (u.includes("/api/free-tier/summary")) {
          return {
            ok: true,
            json: async () => ({ perModel: [{ provider: "groq", modelId: "m1" }] }),
          } as unknown as Response;
        }
        if (u.includes("/api/providers")) {
          return {
            ok: true,
            json: async () => ({ connections: [{ provider: "groq", isActive: true }] }),
          } as unknown as Response;
        }
        if (u.includes("/v1/models")) {
          return {
            ok: true,
            json: async () => ({
              data: [
                {
                  id: "groq/m1",
                  owned_by: "groq",
                  root: "m1",
                  capabilities: { tool_calling: true },
                },
              ],
            }),
          } as unknown as Response;
        }
        if (u.includes("/v1/chat/completions")) {
          probeCount++;
          if (shouldFail) {
            return {
              ok: false,
              json: async () => ({ error: { message: "timeout" } }),
            } as unknown as Response;
          }
          return {
            ok: true,
            json: async () => ({
              choices: [{ message: { tool_calls: [{ function: { name: "get_weather" } }] } }],
            }),
          } as unknown as Response;
        }
        return { ok: false, json: async () => ({}) } as unknown as Response;
      });

      // Cycle 1 — fails
      await generateDynamicFreeCombo(
        "test-id",
        "key",
        "http://localhost:20128",
        new Set(["devin-cli"]),
        2000
      );
      expect(probeCount).toBe(1);

      // Cycle 2 — 1st failure, backoff skip=0 (2^1-1=1, but consecutiveFailures=1, skip=min(1,15)=1)
      // Wait: consecutiveFailures=1 after cycle 1. skip = min(2^1-1, 15) = min(1, 15) = 1
      // So cycle 2 should skip (cyclesSinceProbe=1, skip=1, 1 > 1 is false → skip)
      await generateDynamicFreeCombo(
        "test-id",
        "key",
        "http://localhost:20128",
        new Set(["devin-cli"]),
        2000
      );
      expect(probeCount).toBe(1); // Skipped — backoff

      // Cycle 3 — cyclesSinceProbe=2, skip=1, 2 > 1 → probe
      shouldFail = false; // Now it works
      await generateDynamicFreeCombo(
        "test-id",
        "key",
        "http://localhost:20128",
        new Set(["devin-cli"]),
        2000
      );
      expect(probeCount).toBe(2); // Re-probed after backoff expired
    });

    it("rejects text-only models and keeps only tool-calling", async () => {
      mockFetch.mockReset();
      let callCount = 0;
      mockFetch.mockImplementation(async (url: string) => {
        const u = url.toString();
        if (u.includes("/api/free-tier/summary")) {
          return {
            ok: true,
            json: async () => ({ perModel: [{ provider: "groq", modelId: "m1" }] }),
          } as unknown as Response;
        }
        if (u.includes("/api/providers")) {
          return {
            ok: true,
            json: async () => ({ connections: [{ provider: "groq", isActive: true }] }),
          } as unknown as Response;
        }
        if (u.includes("/v1/models")) {
          return {
            ok: true,
            json: async () => ({
              data: [
                {
                  id: "groq/m1",
                  owned_by: "groq",
                  root: "m1",
                  capabilities: { tool_calling: true },
                },
                {
                  id: "groq/m2",
                  owned_by: "groq",
                  root: "m2",
                  capabilities: { tool_calling: true },
                },
              ],
            }),
          } as unknown as Response;
        }
        if (u.includes("/v1/chat/completions")) {
          callCount++;
          const hasToolCalls = callCount % 2 === 1;
          return {
            ok: true,
            json: async () => ({
              choices: hasToolCalls
                ? [{ message: { tool_calls: [{ function: { name: "get_weather" } }] } }]
                : [{ message: { content: "text only" } }],
            }),
          } as unknown as Response;
        }
        return { ok: false, json: async () => ({}) } as unknown as Response;
      });

      const result = await generateDynamicFreeCombo(
        "test-id",
        "key",
        "http://localhost:20128",
        new Set(["devin-cli"]),
        2000
      );
      expect(result).toBeGreaterThan(0);
      const probeResults = getLastProbeResults();
      const toolCalling = probeResults.filter((r) => r.hasToolCalls);
      const textOnly = probeResults.filter((r) => r.ok && !r.hasToolCalls);
      expect(toolCalling.length).toBeGreaterThan(0);
      expect(textOnly.length).toBeGreaterThan(0);
    });

    it("returns 0 when no tool-calling models found", async () => {
      mockFetch.mockReset();
      mockFetch.mockImplementation(async (url: string) => {
        const u = url.toString();
        if (u.includes("/api/free-tier/summary")) {
          return {
            ok: true,
            json: async () => ({ perModel: [{ provider: "groq", modelId: "m1" }] }),
          } as unknown as Response;
        }
        if (u.includes("/api/providers")) {
          return {
            ok: true,
            json: async () => ({ connections: [{ provider: "groq", isActive: true }] }),
          } as unknown as Response;
        }
        if (u.includes("/v1/models")) {
          return {
            ok: true,
            json: async () => ({
              data: [
                {
                  id: "groq/m1",
                  owned_by: "groq",
                  root: "m1",
                  capabilities: { tool_calling: true },
                },
              ],
            }),
          } as unknown as Response;
        }
        if (u.includes("/v1/chat/completions")) {
          return {
            ok: true,
            json: async () => ({ choices: [{ message: { content: "text only" } }] }),
          } as unknown as Response;
        }
        return { ok: false, json: async () => ({}) } as unknown as Response;
      });

      const result = await generateDynamicFreeCombo(
        "test-id",
        "key",
        "http://localhost:20128",
        new Set(["devin-cli"]),
        1000
      );
      expect(result).toBe(0);
    });
  });

  describe("adaptive probing state", () => {
    it("getProbeStateMap returns Map with per-model state", async () => {
      const state = getProbeStateMap();
      expect(state).toBeInstanceOf(Map);
    });

    it("getCycleCount returns current cycle number", () => {
      const count = getCycleCount();
      expect(typeof count).toBe("number");
    });
  });

  describe("start/stop generator", () => {
    it("startDynamicFreeComboGenerator is idempotent", () => {
      expect(() => {
        startDynamicFreeComboGenerator(
          "test-id",
          "key",
          "http://localhost:20128",
          60000,
          new Set()
        );
      }).not.toThrow();
      stopDynamicFreeComboGenerator();
    });

    it("stopDynamicFreeComboGenerator cleans up", () => {
      stopDynamicFreeComboGenerator();
      expect(() => stopDynamicFreeComboGenerator()).not.toThrow();
    });
  });

  describe("getLastProbeResults", () => {
    it("returns an array with hasToolCalls field", () => {
      const results = getLastProbeResults();
      expect(Array.isArray(results)).toBe(true);
      for (const r of results) {
        expect(typeof r.hasToolCalls).toBe("boolean");
      }
    });
  });

  // GAP 1: Probe state persistence
  describe("probe state persistence (GAP 1)", () => {
    it("persists probe state to DB after generation", async () => {
      mockFetch.mockReset();
      mockFetch.mockImplementation(async (url: string) => {
        const u = url.toString();
        if (u.includes("/api/free-tier/summary"))
          return {
            ok: true,
            json: async () => ({ perModel: [{ provider: "groq", modelId: "m1" }] }),
          } as unknown as Response;
        if (u.includes("/api/providers"))
          return {
            ok: true,
            json: async () => ({ connections: [{ provider: "groq", isActive: true }] }),
          } as unknown as Response;
        if (u.includes("/v1/models"))
          return {
            ok: true,
            json: async () => ({
              data: [
                {
                  id: "groq/m1",
                  owned_by: "groq",
                  root: "m1",
                  capabilities: { tool_calling: true },
                },
              ],
            }),
          } as unknown as Response;
        if (u.includes("/v1/chat/completions"))
          return {
            ok: true,
            json: async () => ({
              choices: [{ message: { tool_calls: [{ function: { name: "get_weather" } }] } }],
            }),
          } as unknown as Response;
        return { ok: false, json: async () => ({}) } as unknown as Response;
      });

      const runFn = vi.fn();
      // prepare() is called with different SQL — return object with both get and run
      mockDbPrepare.mockImplementation((sql: string) => ({
        get: () => undefined,
        run: runFn,
      }));

      await generateDynamicFreeCombo(
        "test-id",
        "key",
        "http://localhost:20128",
        new Set(["devin-cli"]),
        2000
      );
      // persistProbeState is fire-and-forget (void) in finally block — wait briefly
      await new Promise((r) => setTimeout(r, 100));
      // persistProbeState should have called db.prepare().run()
      expect(runFn).toHaveBeenCalled();
    });

    it("loads probe state from DB on first generation", async () => {
      // Simulate persisted state: 1 tool-calling model
      const persistedState = JSON.stringify([
        { k: "groq/m1", p: "groq", m: "m1", f: "groq/m1", s: "tool-calling", e: 500, c: 0, cf: 0 },
      ]);
      // The SQL uses parameterized queries — key is passed as bind param, not in SQL string
      // So we need to check the bind params. mockDbPrepare is called with (sql) and then .get(ns, key)
      mockDbPrepare.mockImplementation((sql: string) => ({
        get: (...bindParams: unknown[]) => {
          // bindParams = [namespace, key] for SELECT queries
          const key = bindParams[1];
          if (key === "probe_state") return { value: persistedState };
          if (key === "cycle_count") return { value: "5" };
          return undefined;
        },
        run: vi.fn(),
      }));

      mockFetch.mockReset();
      mockFetch.mockImplementation(async (url: string) => {
        const u = url.toString();
        if (u.includes("/api/free-tier/summary"))
          return {
            ok: true,
            json: async () => ({ perModel: [{ provider: "groq", modelId: "m1" }] }),
          } as unknown as Response;
        if (u.includes("/api/providers"))
          return {
            ok: true,
            json: async () => ({ connections: [{ provider: "groq", isActive: true }] }),
          } as unknown as Response;
        if (u.includes("/v1/models"))
          return {
            ok: true,
            json: async () => ({
              data: [
                {
                  id: "groq/m1",
                  owned_by: "groq",
                  root: "m1",
                  capabilities: { tool_calling: true },
                },
              ],
            }),
          } as unknown as Response;
        if (u.includes("/v1/chat/completions"))
          return {
            ok: true,
            json: async () => ({
              choices: [{ message: { tool_calls: [{ function: { name: "get_weather" } }] } }],
            }),
          } as unknown as Response;
        return { ok: false, json: async () => ({}) } as unknown as Response;
      });

      // After loading, cycleCount should be 5+1=6 and probeStateMap should have 1 entry
      await generateDynamicFreeCombo(
        "test-id",
        "key",
        "http://localhost:20128",
        new Set(["devin-cli"]),
        2000
      );
      expect(getCycleCount()).toBe(6);
      expect(getProbeStateMap().size).toBeGreaterThanOrEqual(1);
    });
  });
});
