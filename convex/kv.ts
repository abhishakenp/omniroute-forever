/**
 * Key-value store and model fitness learning functions for OmniRoute's Convex backend.
 */
import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

// ── Key-Value ──────────────────────────────────────────────────────────────────

export const kvGet = query({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("key_value")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .first();
    return row?.value ?? null;
  },
});

export const kvSet = mutation({
  args: { key: v.string(), value: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("key_value")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { value: args.value });
    } else {
      await ctx.db.insert("key_value", { key: args.key, value: args.value });
    }
  },
});

// ── Model Fitness ──────────────────────────────────────────────────────────────

export const recordTokenRefusal = mutation({
  args: { modelStr: v.string(), promptTokens: v.number() },
  handler: async (ctx, args) => {
    await ctx.db.insert("token_refusals", {
      modelStr: args.modelStr,
      promptTokens: args.promptTokens,
      createdAt: Date.now(),
    });
  },
});

export const recordModelIncapable = mutation({
  args: { modelStr: v.string(), reason: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.insert("model_incapable", {
      modelStr: args.modelStr,
      reason: args.reason,
      createdAt: Date.now(),
    });
  },
});
