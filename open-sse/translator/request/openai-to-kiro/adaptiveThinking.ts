/**
 * Stub for the Kiro adaptive-thinking capability check.
 *
 * The full translator module was never created, but kiroModels.ts imports
 * `supportsKiroAdaptiveThinking` from here. Without this file, the module
 * fails to load 155 times per session and every Kiro model request fails.
 *
 * Returns false until the real implementation lands — Kiro's adaptive
 * thinking is an opt-in feature that is not needed for basic routing.
 */

// Models known to support Kiro's adaptive thinking mode. Empty until the
// real capability detection is implemented.
const KIRO_ADAPTIVE_THINKING_MODELS = new Set<string>([]);

export function supportsKiroAdaptiveThinking(upstream: string): boolean {
  return KIRO_ADAPTIVE_THINKING_MODELS.has(upstream);
}
