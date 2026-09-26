/**
 * Provider connection CRUD + query functions for OmniRoute's Convex backend.
 *
 * These run on the Convex server. The adapter package calls them via the
 * Convex client. Each function maps to a DbAdapter method.
 */
import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

// ── Queries ──────────────────────────────────────────────────────────────────

/**
 * List provider connections, optionally filtered.
 *
 * Mirrors `queryProviderConnections(opts)` from the DbAdapter interface.
 * Returns rows in the TargetRow shape the router expects.
 */
export const queryConnections = query({
  args: {
    provider: v.optional(v.string()),
    reservedFor: v.optional(v.string()),
    freeOnly: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    let q = ctx.db.query("provider_connections");
    if (args.provider) {
      q = q.withIndex("by_provider", (q) => q.eq("provider", args.provider!));
    }
    const rows = await q.collect();
    // Filter by reservedFor: null = general pool only; specific = pool + general
    let filtered = rows;
    if (args.reservedFor) {
      filtered = rows.filter((r) => r.reservedFor == null || r.reservedFor === args.reservedFor);
    } else {
      filtered = rows.filter((r) => r.reservedFor == null);
    }
    if (args.freeOnly) {
      // Free providers are those without an apiKey or with a known free flag.
      // The adapter handles this filtering; Convex just returns all.
    }
    return filtered.map((r) => ({
      id: r._id,
      provider: r.provider,
      model: r.model ?? null,
      reserved_for: r.reservedFor ?? null,
      is_active: r.isActive ?? true,
      api_key: r.apiKey ?? null,
      auth_type: r.authType ?? null,
      default_model: r.defaultModel ?? null,
      priority: r.priority ?? 0,
      rate_limited_until: r.rateLimitedUntil ?? null,
      last_used_at: r.lastUsedAt ?? null,
      last_status: r.lastStatus ?? null,
      fail_count: r.failCount ?? 0,
      created_at: r.createdAt ?? null,
      updated_at: r.updatedAt ?? null,
    }));
  },
});

/**
 * Providers holding at least one active-but-rate-limited credential.
 *
 * Mirrors `rateLimitedProviders()` from the DbAdapter interface.
 */
export const rateLimitedProviders = query({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const rows = await ctx.db.query("provider_connections").collect();
    const active = rows.filter((r) => (r.isActive ?? true) && r.rateLimitedUntil != null && r.rateLimitedUntil > now);
    const providers = new Set(active.map((r) => r.provider));
    return [...providers];
  },
});

// ── Mutations ─────────────────────────────────────────────────────────────────

/**
 * Create a provider connection. Returns the new document ID.
 */
export const createConnection = mutation({
  args: {
    provider: v.optional(v.string()),
    apiKey: v.optional(v.string()),
    reservedFor: v.optional(v.string()),
    isActive: v.optional(v.boolean()),
    model: v.optional(v.string()),
    authType: v.optional(v.string()),
    defaultModel: v.optional(v.string()),
    priority: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const id = await ctx.db.insert("provider_connections", {
      provider: args.provider ?? "",
      apiKey: args.apiKey,
      reservedFor: args.reservedFor,
      isActive: args.isActive ?? true,
      model: args.model,
      authType: args.authType,
      defaultModel: args.defaultModel,
      priority: args.priority ?? 0,
      rateLimitedUntil: undefined,
      lastUsedAt: undefined,
      lastStatus: undefined,
      failCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  },
});

/**
 * Update a provider connection by ID.
 */
export const updateConnection = mutation({
  args: {
    id: v.id("provider_connections"),
    provider: v.optional(v.string()),
    apiKey: v.optional(v.string()),
    reservedFor: v.optional(v.string()),
    isActive: v.optional(v.boolean()),
    model: v.optional(v.string()),
    authType: v.optional(v.string()),
    defaultModel: v.optional(v.string()),
    priority: v.optional(v.number()),
    rateLimitedUntil: v.optional(v.number()),
    lastUsedAt: v.optional(v.number()),
    lastStatus: v.optional(v.number()),
    failCount: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { id, ...updates } = args;
    const patch: Record<string, any> = { updatedAt: Date.now() };
    for (const [k, v] of Object.entries(updates)) {
      if (v !== undefined) patch[k] = v;
    }
    await ctx.db.patch(id, patch);
  },
});

/**
 * Delete a provider connection by ID. Returns true if deleted.
 */
export const deleteConnection = mutation({
  args: { id: v.id("provider_connections") },
  handler: async (ctx, args) => {
    try {
      await ctx.db.delete(args.id);
      return true;
    } catch {
      return false;
    }
  },
});

/**
 * Mark a connection as failed — set rate limit and increment fail count.
 */
export const markFailed = mutation({
  args: {
    connectionId: v.id("provider_connections"),
    status: v.number(),
    cooldownMs: v.number(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const doc = await ctx.db.get(args.connectionId);
    if (!doc) return;
    await ctx.db.patch(args.connectionId, {
      lastStatus: args.status,
      failCount: (doc.failCount ?? 0) + 1,
      rateLimitedUntil: now + args.cooldownMs,
      updatedAt: now,
    });
  },
});

/**
 * Mark a connection as succeeded — clear rate limit, update last used.
 */
export const markSucceeded = mutation({
  args: { connectionId: v.id("provider_connections") },
  handler: async (ctx, args) => {
    const now = Date.now();
    const doc = await ctx.db.get(args.connectionId);
    if (!doc) return;
    await ctx.db.patch(args.connectionId, {
      rateLimitedUntil: undefined,
      lastUsedAt: now,
      failCount: 0,
      updatedAt: now,
    });
  },
});
