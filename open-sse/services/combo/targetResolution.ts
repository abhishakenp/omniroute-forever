/**
 * resolveComboTargetPipeline — the target-resolution phase of handleComboChat (combo.ts).
 *
 * Sits between the dispatch prelude (pinned model / fusion / chaos / pipeline / nested
 * execute-mode / round-robin) and the attempt loop. It turns the raw combo definition
 * into the final `orderedTargets` array the attempt loop iterates, in this order:
 *
 *   1. provider-wildcard expansion of the combo + the combos collection (#2562)
 *   2. weighted step-group resolution + sticky-weighted eligibility
 *   3. request-tag routing
 *   4. known-context-overflow early return
 *   5. smart/pipeline-enabled dispatch (auto strategy)
 *   6. auto-strategy candidate build / scoring / ordering, or per-strategy ordering
 *   7. prompt-cache strategy affinity, session stickiness, eval scores,
 *      request compatibility, context requirements
 *   8. task-aware reordering
 *   9. prompt-cache affinity application
 *  10. the parallel pre-screen (priority strategy only)
 *
 * Behaviour is byte-identical to the inline block it replaces — the two early exits
 * (context overflow, pipeline dispatch, auto-strategy `earlyResponse`) become an
 * `{ earlyResponse }` result so the host decides to return them, and the values the
 * attempt loop still consumes (`orderedTargets`, `stickyWeightedLimit`,
 * `getWeightedStepKeyForTarget`, `sticky`, `preScreenMap`) are returned instead of
 * closed over.
 *
 * See _tasks/quality/2026-06-19-DESIGN-godfiles-decomposition.md §4.
 */
import { parseAutoPrefix } from "../autoCombo/autoPrefix.ts";
import { handlePipelineCombo, buildPipelineResponse } from "../autoCombo/pipelineRouter.ts";
import type { resolveComboSetupConfig } from "../comboConfig.ts";
import { errorResponseWithComboDiagnostics } from "../../utils/error.ts";
import type { ResilienceSettings } from "../../../src/lib/resilience/settings";
import { applyStrategyOrdering } from "./applyStrategyOrdering.ts";
import { clampComboDepth } from "./comboPredicates.ts";
import {
  describeCapabilityFilterExhaustion,
  filterTargetsByRequestCompatibility,
  resolveComboTargets,
} from "./comboStructure.ts";
import { applyContextRequirements } from "./contextRequirements.ts";
import { recordComboFailure } from "./failureTracker.ts";
import { getKnownContextOverflow } from "./knownContextOverflow.ts";
import { buildEmptyComboTargetsPayload, buildRecoveryHint } from "./pinRecovery.ts";
import {
  expandProviderWildcardsInCombo,
  expandProviderWildcardsInCollection,
} from "./providerWildcard.ts";
import { preScreenTargets, type PreScreenResult } from "./quotaStrategies.ts";
import { resolveAutoStrategyOrder, type ResolveAutoStrategyDeps } from "./resolveAutoStrategy.ts";
import { applyRequestTagRouting } from "./autoStrategy.ts";
import type {
  ComboCollectionLike,
  ComboLike,
  ComboLogger,
  ComboRelayOptions,
  HandleSingleModel,
  IsModelAvailable,
  HiddenModelsByProvider,
  ResolvedComboTarget,
} from "./types.ts";

/** Minimal stickiness result — session stickiness removed, always no-op. */
interface ApplyStickinessResult {
  targets: ResolvedComboTarget[];
  messageHash: string | null;
  stuck: boolean;
}

export interface ResolveComboTargetPipelineDeps {
  body: Record<string, unknown>;
  combo: ComboLike;
  strategy: string;
  config: ReturnType<typeof resolveComboSetupConfig>;
  settings?: Record<string, unknown> | null;
  allCombos?: ComboCollectionLike;
  relayOptions?: ComboRelayOptions | null;
  signal?: AbortSignal | null;
  apiKeyAllowedConnections: string[] | null;
  log: ComboLogger;
  resilienceSettings: ResilienceSettings;
  isModelAvailable?: IsModelAvailable;
  /** handleSingleModel already wrapped by buildTargetTimeoutRunner. */
  handleSingleModelWithTimeout: HandleSingleModel;
  /**
   * Dependency-injected `buildAutoCandidates` — it lives in `combo.ts` (the host of
   * this leaf), so importing it directly would create an import cycle.
   */
  buildAutoCandidates: ResolveAutoStrategyDeps["buildAutoCandidates"];
  hiddenModelsByProvider?: HiddenModelsByProvider;
}

export interface ResolvedComboTargetPipeline {
  orderedTargets: ResolvedComboTarget[];
  /** Sticky-weighted target limit — always 0 (weighted selection removed). */
  stickyWeightedLimit: number;
  /** Maps an attempted target back to its weighted step key — always returns null (removed). */
  getWeightedStepKeyForTarget: (target: ResolvedComboTarget) => string | null;
  /** Session-stickiness result — always no-op (session stickiness removed). */
  sticky: ApplyStickinessResult;
  preScreenMap: Map<string, PreScreenResult>;
}

export type ResolveComboTargetPipelineResult =
  { earlyResponse: Response } | ResolvedComboTargetPipeline;

/**
 * #2562: Expand provider-wildcard steps (e.g. `fta/*`, `openai/gpt-4*`) into
 * concrete model entries sourced from the live synced-models catalog + registry.
 */
async function expandComboWildcards(
  combo: ComboLike,
  allCombos: ComboCollectionLike
): Promise<{ expandedCombo: ComboLike; expandedAllCombos: ComboCollectionLike }> {
  const expandedCombo = await expandProviderWildcardsInCombo(combo);
  const expandedAllCombos = allCombos
    ? Array.isArray(allCombos)
      ? await expandProviderWildcardsInCollection(allCombos as ComboLike[])
      : {
          ...allCombos,
          combos: await expandProviderWildcardsInCollection(
            ((allCombos as { combos?: ComboLike[] }).combos || []) as ComboLike[]
          ),
        }
    : allCombos;
  return { expandedCombo, expandedAllCombos };
}

// Weighted selection, sticky-weighted, session stickiness, eval routing,
// task-aware routing, and prompt-cache affinity have been removed for thin gateway.
// The weighted strategy now passes through unfiltered targets.

/** 400 rejection for a request no target in the pool can physically accept. */
function buildContextOverflowResponse(
  overflow: { requiredContextTokens: number; maxKnownContextTokens: number },
  orderedTargets: ResolvedComboTarget[],
  log: ComboLogger
): Response {
  const { requiredContextTokens, maxKnownContextTokens } = overflow;
  log.warn(
    "COMBO",
    `Request context exceeds every known target limit (${requiredContextTokens} > ${maxKnownContextTokens} tokens)`
  );
  return errorResponseWithComboDiagnostics(
    400,
    `Request requires approximately ${requiredContextTokens} tokens, but the largest known context limit in this combo is ${maxKnownContextTokens} tokens. Reduce or compact the request context.`,
    {
      poolSize: orderedTargets.length,
      attempted: 0,
      excluded: orderedTargets.map((target) => ({
        provider: target.provider,
        model: target.modelStr,
        reason: "context_window",
      })),
      attemptOrder: [],
      terminalReason: "context_length_exceeded",
    },
    { code: "context_length_exceeded", type: "invalid_request_error" }
  );
}

function logTargetPoolSize(
  strategy: string,
  allCombos: ComboCollectionLike,
  orderedTargets: ResolvedComboTarget[],
  log: ComboLogger
): void {
  if (allCombos) {
    log.info("COMBO", `${strategy} with nested resolution: ${orderedTargets.length} total targets`);
  }
}

/**
 * Pipeline dispatch: route smart/pipeline-enabled combos through the multi-stage
 * pipeline. Returns the finished Response, or null to fall through to standard
 * auto routing (pipeline disabled, below token threshold, or dispatch failure).
 */
async function dispatchSmartPipeline(
  deps: ResolveComboTargetPipelineDeps,
  availableModels: readonly string[]
): Promise<Response | null> {
  const { body, combo, strategy, config, settings, signal, log } = deps;
  if (strategy !== "auto") return null;
  const autoParsed = parseAutoPrefix(combo.name);
  const autoVariant = autoParsed.valid ? autoParsed.variant : undefined;
  if (autoVariant !== "smart" && !config.pipeline_enabled) return null;
  try {
    const pipelineRaw = await handlePipelineCombo({
      body,
      combo,
      availableModels,
      handleChatCore: deps.handleSingleModelWithTimeout,
      log: {
        info: log.info,
        warn: log.warn,
        error: log.error ?? log.warn,
      },
      settings: settings ?? {},
      signal: signal ?? undefined,
    });
    // handlePipelineCombo resolves to a PipelineResult (buffered text) or,
    // in the streaming-final-stage case, a Response. Callers downstream
    // (chat.ts → withSessionHeader) require a Response, so adapt the
    // PipelineResult here instead of leaking the raw object.
    return pipelineRaw instanceof Response ? pipelineRaw : buildPipelineResponse(pipelineRaw, body);
  } catch (pipelineErr) {
    logPipelineFallthrough(pipelineErr, log);
    return null;
  }
}

function logPipelineFallthrough(pipelineErr: unknown, log: ComboLogger): void {
  const pipelineMsg = pipelineErr instanceof Error ? pipelineErr.message : "";
  if (pipelineMsg === "PIPELINE_DISABLED") {
    log.info("COMBO", "Pipeline disabled, falling through to standard auto routing");
  } else if (pipelineMsg === "PIPELINE_TOKEN_THRESHOLD") {
    log.info(
      "COMBO",
      "Pipeline skipped (prompt below token threshold), falling through to standard auto routing"
    );
  } else {
    log.warn("COMBO", "Pipeline dispatch failed, falling through to standard auto routing", {
      err: pipelineErr,
    });
  }
}

/**
 * Strategy ordering: the `auto` router for auto combos, the per-strategy chain for
 * everything else. `autoUsedExplicitRouter` is the #4945 guard — when an explicit
 * router (lkgp/cost/…) pinned orderedTargets[0], task-aware reordering below must
 * refine only the fallback order, never override the router's primary choice.
 */
async function orderByStrategy(
  deps: ResolveComboTargetPipelineDeps,
  initialOrderedTargets: ResolvedComboTarget[]
): Promise<
  | { earlyResponse: Response }
  | { orderedTargets: ResolvedComboTarget[]; autoUsedExplicitRouter: boolean }
> {
  const { strategy, body, combo, settings, config, log } = deps;
  if (strategy === "auto") {
    const autoResult = await resolveAutoStrategyOrder({
      orderedTargets: initialOrderedTargets,
      body,
      combo,
      settings,
      config,
      relayOptions: deps.relayOptions,
      resilienceSettings: deps.resilienceSettings,
      log,
      buildAutoCandidates: deps.buildAutoCandidates,
    });
    if ("earlyResponse" in autoResult) return { earlyResponse: autoResult.earlyResponse };
    return {
      orderedTargets: autoResult.orderedTargets,
      autoUsedExplicitRouter: autoResult.autoUsedExplicitRouter,
    };
  }
  const orderedTargets = await applyStrategyOrdering(strategy, initialOrderedTargets, {
    combo,
    config,
    body,
    log,
    apiKeyAllowedConnections: deps.apiKeyAllowedConnections,
  });
  return { orderedTargets, autoUsedExplicitRouter: false };
}

/**
 * Continuity + eligibility filters: request compatibility and per-combo context
 * requirements. Session stickiness, eval-score ordering, and prompt-cache affinity
 * have been removed for thin gateway.
 *
 * May return `{ earlyResponse }` when hard capability filters (#8488 / #8494) empty
 * the pool — tools / vision / structured_output fail closed as 400 capability_mismatch
 * unless `compatFilterFailOpen` is set on the combo config or settings.
 * Also returns `{ earlyResponse }` for #8786 when context requirements leave no
 * survivors (`context_requirements_exhausted`).
 */
async function applyContinuityFilters(
  deps: ResolveComboTargetPipelineDeps,
  initialOrderedTargets: ResolvedComboTarget[]
): Promise<
  | { orderedTargets: ResolvedComboTarget[]; sticky: ApplyStickinessResult }
  | { earlyResponse: Response }
> {
  const { combo, config, settings, log, relayOptions } = deps;
  // Session stickiness removed — always no-op.
  const sticky: ApplyStickinessResult = {
    targets: initialOrderedTargets,
    messageHash: null,
    stuck: false,
  };
  let orderedTargets = sticky.targets;
  // #8488 / #8494: fail closed when hard capability filters empty the pool.
  // Opt-in escape hatch: combo.config.compatFilterFailOpen OR settings.compatFilterFailOpen.
  const compatFilterFailOpen =
    (config as { compatFilterFailOpen?: unknown }).compatFilterFailOpen === true ||
    (settings as { compatFilterFailOpen?: unknown } | null | undefined)?.compatFilterFailOpen ===
      true;
  const preCompatTargets = orderedTargets;
  orderedTargets = filterTargetsByRequestCompatibility(orderedTargets, deps.body, log, undefined, {
    failOpen: compatFilterFailOpen,
  });
  if (orderedTargets.length === 0 && preCompatTargets.length > 0) {
    const exhaustion = describeCapabilityFilterExhaustion(preCompatTargets, deps.body, combo.name);
    if (exhaustion) {
      // Match handleComboChat: only track failures under context-cache protection pins.
      const effectiveSessionId: string | null = combo.context_cache_protection
        ? (relayOptions?.sessionId ?? null)
        : null;
      recordComboFailure(effectiveSessionId, combo.name);
      return {
        earlyResponse: errorResponseWithComboDiagnostics(
          400,
          exhaustion.message,
          {
            poolSize: preCompatTargets.length,
            attempted: 0,
            excluded: exhaustion.excluded,
            attemptOrder: [],
            terminalReason: exhaustion.terminalReason,
            recovery: buildRecoveryHint("no_executable_targets"),
          },
          { code: "capability_mismatch", type: "invalid_request_error" }
        ),
      };
    }
  }
  // #8786: capture pre-filter pool so a strict/minContextWindow wipe can
  // surface context_requirements_exhausted instead of a generic 404.
  const preContextTargets = orderedTargets;
  orderedTargets = applyContextRequirements(orderedTargets, config.contextRequirements, log);
  if (orderedTargets.length === 0 && preContextTargets.length > 0) {
    const effectiveSessionId: string | null = combo.context_cache_protection
      ? (relayOptions?.sessionId ?? null)
      : null;
    recordComboFailure(effectiveSessionId, combo.name);
    const { message, diagnostics } = buildEmptyComboTargetsPayload(
      preContextTargets,
      config.contextRequirements?.minContextWindow
    );
    return {
      earlyResponse: errorResponseWithComboDiagnostics(404, message, diagnostics, {
        code: "model_not_found",
        type: "invalid_request_error",
      }),
    };
  }
  return { orderedTargets, sticky };
}

// Task-aware reordering removed — pass-through.
function applyTaskAwareOrdering(
  _deps: ResolveComboTargetPipelineDeps,
  orderedTargets: ResolvedComboTarget[],
  _autoUsedExplicitRouter: boolean
): ResolvedComboTarget[] {
  return orderedTargets;
}

// Prompt-cache affinity stage removed — pass-through.
async function applyPromptCacheStage(
  _deps: ResolveComboTargetPipelineDeps,
  orderedTargets: ResolvedComboTarget[],
  _stickyStuck: boolean,
  _autoUsedExplicitRouter: boolean
): Promise<ResolvedComboTarget[]> {
  return orderedTargets;
}

export async function resolveComboTargetPipeline(
  deps: ResolveComboTargetPipelineDeps
): Promise<ResolveComboTargetPipelineResult> {
  const { body, combo, strategy, config, allCombos, log, isModelAvailable } = deps;

  const { expandedCombo, expandedAllCombos } = await expandComboWildcards(combo, allCombos);
  // Weighted selection removed — pass through unfiltered targets for all strategies.
  const stickyWeightedLimit = 0;
  const getWeightedStepKeyForTarget = (_target: ResolvedComboTarget): string | null => null;
  let orderedTargets = resolveComboTargets(
    expandedCombo,
    expandedAllCombos,
    clampComboDepth(config.maxComboDepth),
    deps.hiddenModelsByProvider
  );

  orderedTargets = await applyRequestTagRouting(orderedTargets, body, log);

  const overflow = getKnownContextOverflow(orderedTargets, body);
  if (overflow) {
    return { earlyResponse: buildContextOverflowResponse(overflow, orderedTargets, log) };
  }

  logTargetPoolSize(strategy, allCombos, orderedTargets, log);

  const pipelineResponse = await dispatchSmartPipeline(
    deps,
    orderedTargets.map((target) => target.modelStr)
  );
  if (pipelineResponse) return { earlyResponse: pipelineResponse };

  const ordering = await orderByStrategy(deps, orderedTargets);
  if ("earlyResponse" in ordering) return ordering;
  const { autoUsedExplicitRouter } = ordering;

  const continuity = await applyContinuityFilters(deps, ordering.orderedTargets);
  if ("earlyResponse" in continuity) return continuity;
  orderedTargets = applyTaskAwareOrdering(deps, continuity.orderedTargets, autoUsedExplicitRouter);
  orderedTargets = await applyPromptCacheStage(
    deps,
    orderedTargets,
    continuity.sticky.stuck,
    autoUsedExplicitRouter
  );

  // Parallel pre-screen: check provider profiles and model availability for all targets
  // Only runs for priority strategy where sequential checking causes latency
  const preScreenMap =
    strategy === "priority"
      ? await preScreenTargets(orderedTargets, isModelAvailable).catch(
          () => new Map<string, PreScreenResult>()
        )
      : new Map<string, PreScreenResult>();

  return {
    orderedTargets,
    stickyWeightedLimit,
    getWeightedStepKeyForTarget,
    sticky: continuity.sticky,
    preScreenMap,
  };
}
