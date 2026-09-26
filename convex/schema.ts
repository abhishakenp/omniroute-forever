/**
 * Convex schema for OmniRoute.
 *
 * Mirrors the SQLite tables the router needs:
 * - `provider_connections` — the credential pool the router iterates
 * - `key_value` — the simple KV store for settings/flags
 * - `token_refusals` — model fitness learning (prompt too big)
 * - `model_incapable` — model fitness learning (not a chat model)
 *
 * Column names use camelCase (Convex convention) but map 1:1 to the
 * SQLite snake_case columns via the adapter's case mapping.
 */
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  provider_connections: defineTable({
    provider: v.string(),
    model: v.optional(v.string()),
    apiKey: v.optional(v.string()),
    authType: v.optional(v.string()),
    defaultModel: v.optional(v.string()),
    priority: v.optional(v.number()),
    isActive: v.optional(v.boolean()),
    reservedFor: v.optional(v.string()),
    rateLimitedUntil: v.optional(v.number()),
    lastUsedAt: v.optional(v.number()),
    lastStatus: v.optional(v.number()),
    failCount: v.optional(v.number()),
    createdAt: v.optional(v.number()),
    updatedAt: v.optional(v.number()),
    // Open index for any additional columns the provisioner writes.
    metadata: v.optional(v.any()),
  }).index("by_provider", ["provider"])
    .index("by_reserved", ["reservedFor"])
    .index("by_active", ["isActive"]),

  key_value: defineTable({
    key: v.string(),
    value: v.string(),
  }).index("by_key", ["key"]),

  token_refusals: defineTable({
    modelStr: v.string(),
    promptTokens: v.number(),
    createdAt: v.number(),
  }).index("by_model", ["modelStr"]),

  model_incapable: defineTable({
    modelStr: v.string(),
    reason: v.string(),
    createdAt: v.number(),
  }).index("by_model", ["modelStr"]),
});
