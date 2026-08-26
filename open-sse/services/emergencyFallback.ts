/**
 * Emergency Fallback — Budget Exhaustion Redirect
 *
 * When a request fails due to budget exhaustion (HTTP 402 or budget keywords
 * in the error body), optionally redirect to a free-tier model
 * (default provider/model: nvidia + openai/gpt-oss-120b at $0.00/M tokens).
 *
 * Inspired by ClawRouter: "gpt-oss-120b costs nothing and serves as
 * automatic fallback when wallet is empty."
 *
 * Operators can disable the redirect entirely with
 * `OMNIROUTE_EMERGENCY_FALLBACK=false` (or `0`). Default remains enabled.
 */

import { isFeatureFlagEnabled } from "@/shared/utils/featureFlags";

const EMERGENCY_FALLBACK_FLAG_KEY = "OMNIROUTE_EMERGENCY_FALLBACK";
const EMERGENCY_FALLBACK_FLAG_CACHE_MS = 500;

type FeatureFlagResolver = (key: string) => boolean;

let emergencyFallbackFlagCache: { value: boolean; expiresAt: number } | null = null;
let emergencyFallbackFeatureFlagResolver: FeatureFlagResolver = isFeatureFlagEnabled;

export interface EmergencyFallbackConfig {
  enabled: boolean;
  provider: string;
  model: string;
  triggerOn402: boolean;
  triggerOnBudgetKeywords: boolean;
  budgetKeywords: string[];
  /** Skip fallback for tool requests (gpt-oss-120b may not support structured tool calling) */
  skipForToolRequests: boolean;
  maxOutputTokens: number;
  /** GAP 5 FIX: Tool-capable fallback for when skipForToolRequests=true blocks tool requests.
   *  Uses groq/llama-3.3-70b-versatile — free, verified tool-calling, fast.
   *  When the primary fallback skips tool requests, this secondary fallback catches them. */
  toolCapableProvider?: string;
  toolCapableModel?: string;
  toolCapableMaxOutputTokens?: number;
}

export const EMERGENCY_FALLBACK_CONFIG: EmergencyFallbackConfig = {
  enabled: true,
  provider: "nvidia",
  model: "openai/gpt-oss-120b",
  triggerOn402: true,
  triggerOnBudgetKeywords: true,
  budgetKeywords: [
    "insufficient funds",
    "insufficient_funds",
    "budget exceeded",
    "budget_exceeded",
    "quota exceeded",
    "quota_exceeded",
    "billing",
    "payment required",
    "out of credits",
    "no credits",
    "credit limit",
    "spending limit",
    "saldo insuficiente",
    "limite de gastos",
    "cota excedida",
  ],
  skipForToolRequests: true,
  maxOutputTokens: 4096,
  // GAP 5: Tool-capable fallback — groq/llama-3.3-70b-versatile is free + supports tools
  toolCapableProvider: "groq",
  toolCapableModel: "llama-3.3-70b-versatile",
  toolCapableMaxOutputTokens: 8192,
};

export interface FallbackDecision {
  shouldFallback: true;
  reason: string;
  provider: string;
  model: string;
  maxOutputTokens: number;
}

export interface NoFallbackDecision {
  shouldFallback: false;
  reason: string;
}

export type FallbackResult = FallbackDecision | NoFallbackDecision;

function isEmergencyFallbackRawEnvEnabled(): boolean {
  const raw = process.env.OMNIROUTE_EMERGENCY_FALLBACK;
  return raw !== "false" && raw !== "0";
}

export function resetEmergencyFallbackEnvCache(): void {
  emergencyFallbackFlagCache = null;
}

export function setEmergencyFallbackFeatureFlagResolverForTest(
  resolver: FeatureFlagResolver | null
): void {
  emergencyFallbackFeatureFlagResolver = resolver ?? isFeatureFlagEnabled;
  resetEmergencyFallbackEnvCache();
}

export function isEmergencyFallbackEnvEnabled(): boolean {
  const now = Date.now();
  if (emergencyFallbackFlagCache && emergencyFallbackFlagCache.expiresAt > now) {
    return emergencyFallbackFlagCache.value;
  }

  let value: boolean;
  try {
    value = emergencyFallbackFeatureFlagResolver(EMERGENCY_FALLBACK_FLAG_KEY);
  } catch (error) {
    console.warn(
      "[emergencyFallback] Feature flag resolution failed; falling back to raw env:",
      error instanceof Error ? error.message : error
    );
    value = isEmergencyFallbackRawEnvEnabled();
  }

  emergencyFallbackFlagCache = {
    value,
    expiresAt: now + EMERGENCY_FALLBACK_FLAG_CACHE_MS,
  };
  return value;
}

export function shouldUseFallback(
  status: number,
  errorBody: string,
  requestHasTools: boolean,
  config: EmergencyFallbackConfig = EMERGENCY_FALLBACK_CONFIG
): FallbackResult {
  if (!config.enabled) return { shouldFallback: false, reason: "emergency fallback disabled" };
  if (!isEmergencyFallbackEnvEnabled()) {
    return {
      shouldFallback: false,
      reason: "emergency fallback disabled via OMNIROUTE_EMERGENCY_FALLBACK",
    };
  }

  // Check if this is a budget/quota error
  const is402 = config.triggerOn402 && status === 402;
  let matchedKeyword: string | null = null;
  if (config.triggerOnBudgetKeywords && errorBody) {
    const lowerBody = errorBody.toLowerCase();
    matchedKeyword =
      config.budgetKeywords.find((kw) => lowerBody.includes(kw.toLowerCase())) ?? null;
  }
  const isBudgetError = is402 || matchedKeyword !== null;

  if (!isBudgetError) {
    return { shouldFallback: false, reason: "no budget error detected" };
  }

  // GAP 5: If request has tools and primary fallback skips tools, use tool-capable fallback
  if (config.skipForToolRequests && requestHasTools) {
    if (config.toolCapableProvider && config.toolCapableModel) {
      return {
        shouldFallback: true,
        reason: `Budget error (${is402 ? "HTTP 402" : `'${matchedKeyword}'`}) → tool-capable fallback to ${config.toolCapableProvider}/${config.toolCapableModel}`,
        provider: config.toolCapableProvider,
        model: config.toolCapableModel,
        maxOutputTokens: config.toolCapableMaxOutputTokens ?? 4096,
      };
    }
    return {
      shouldFallback: false,
      reason: "skipped: request has tools and no tool-capable fallback configured",
    };
  }

  // Standard fallback (no tools, or skipForToolRequests=false)
  return {
    shouldFallback: true,
    reason: `Budget error (${is402 ? "HTTP 402" : `'${matchedKeyword}'`}) → emergency fallback to ${config.provider}/${config.model}`,
    provider: config.provider,
    model: config.model,
    maxOutputTokens: config.maxOutputTokens,
  };
}

export function isFallbackDecision(result: FallbackResult): result is FallbackDecision {
  return result.shouldFallback === true;
}
