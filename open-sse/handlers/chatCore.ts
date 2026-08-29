import { createRequire } from "node:module";
import { resolveChatCoreRequestSetup } from "./chatCore/requestSetup.ts";
import {
  shouldDefaultAllowClassifier,
  buildDefaultAllowClaudeMessage,
} from "./chatCore/claudeClassifierCompat.ts";
import { buildNonStreamingResponseHeaders } from "./chatCore/nonStreamingResponseHeaders.ts";
import { buildNonStreamingJsonResponse } from "./chatCore/nonStreamingJsonResponse.ts";
import { assembleStreamingResponseHeaders } from "./chatCore/streamingResponseHeaders.ts";
import { assembleStreamingPipeline } from "./chatCore/streamingPipeline.ts";
import { sanitizeChatRequestBody } from "./chatCore/sanitization.ts";
import {
  getHeaderValueCaseInsensitive,
  isStripReasoningRequested,
} from "./chatCore/headers.ts";
import {
  shouldUseNativeCodexPassthrough,
  shouldUseNativeXaiResponsesPassthrough,
  stampNativeResponsesPassthroughBody,
  redactPassthroughThinkingSignatures,
  isClaudeCodeSemanticPassthroughRequest,
} from "./chatCore/passthroughHelpers.ts";
import {
  buildStreamingResponseHeaders,
  materializeDeduplicatedExecutionResult,
  stripNextMiddlewareControlHeaders,
  stripStaleForwardingHeaders,
} from "./chatCore/responseHeaders.ts";
// Telemetry helpers removed (thin gateway) — maybeSyncClaudeExtraUsageState and
// forwardDashboardEventToLiveWs were only telemetry/analytics; stubbed to no-ops.
const maybeSyncClaudeExtraUsageState = async (_args: unknown) => {};
// Re-export the previously inline-defined helpers so existing importers of these
// symbols from chatCore.ts (tests, sibling modules) keep resolving after the split.
export {
  shouldUseNativeCodexPassthrough,
  shouldUseNativeXaiResponsesPassthrough,
  redactPassthroughThinkingSignatures,
  isClaudeCodeSemanticPassthroughRequest,
  buildStreamingResponseHeaders,
  stripStaleForwardingHeaders,
};
import { normalizeHeaders } from "../utils/headers.ts";
import { resolveChatCoreRequestFormat } from "./chatCore/requestFormat.ts";
import { resolveChatCoreTargetFormat } from "./chatCore/targetFormat.ts";
import { translateRequest, needsTranslation } from "../translator/index.ts";
import { FORMATS } from "../translator/formats.ts";

const require_ = createRequire(import.meta.url);
let _claudeHelper: typeof import("../translator/helpers/claudeHelper.ts") | null = null;
function getClaudeHelper() { if (!_claudeHelper) _claudeHelper = require_("../translator/helpers/claudeHelper.ts"); return _claudeHelper; }

// ── Lazy imports — loaded on first use to reduce module-eval-time memory ──
// Modules below are not needed for a simple direct provider request (e.g.
// mistral/mistral-small-latest) and are deferred until first call. Each getter
// caches its module after the first require so subsequent calls are zero-cost.

let _accountFallback: any = null;
function getAccountFallback() { if (!_accountFallback) _accountFallback = require_("../services/accountFallback.ts"); return _accountFallback; }

let _reasoningCache: any = null;
function getReasoningCache() { if (!_reasoningCache) _reasoningCache = require_("../services/reasoningCache.ts"); return _reasoningCache; }

let _requestDedup: any = null;
function getRequestDedup() { if (!_requestDedup) _requestDedup = require_("../services/requestDedup.ts"); return _requestDedup; }

let _streamRecovery: any = null;
function getStreamRecovery() { if (!_streamRecovery) _streamRecovery = require_("../services/streamRecovery.ts"); return _streamRecovery; }

let _webFetchInterception: any = null;
function getWebFetchInterception() { if (!_webFetchInterception) _webFetchInterception = require_("../services/webFetchInterception.ts"); return _webFetchInterception; }

let _webSearchFallback: any = null;
function getWebSearchFallback() { if (!_webSearchFallback) _webSearchFallback = require_("../services/webSearchFallback.ts"); return _webSearchFallback; }

let _modelDeprecation: any = null;
function getModelDeprecation() { if (!_modelDeprecation) _modelDeprecation = require_("../services/modelDeprecation.ts"); return _modelDeprecation; }

let _mimoThinking: any = null;
function getMimoThinking() { if (!_mimoThinking) _mimoThinking = require_("../services/mimoThinking.ts"); return _mimoThinking; }

let _claudeHaikuConstraints: any = null;
function getClaudeHaikuConstraints() { if (!_claudeHaikuConstraints) _claudeHaikuConstraints = require_("../services/claudeHaikuConstraints.ts"); return _claudeHaikuConstraints; }

let _antigravityQuotaFamily: any = null;
function getAntigravityQuotaFamily() { if (!_antigravityQuotaFamily) _antigravityQuotaFamily = require_("../services/antigravityQuotaFamily.ts"); return _antigravityQuotaFamily; }

let _codexQuotaFetcher: any = null;
function getCodexQuotaFetcher() { if (!_codexQuotaFetcher) _codexQuotaFetcher = require_("../services/codexQuotaFetcher.ts"); return _codexQuotaFetcher; }

let _defaultReasoningEffort: any = null;
function getDefaultReasoningEffort() { if (!_defaultReasoningEffort) _defaultReasoningEffort = require_("../services/defaultReasoningEffort.ts"); return _defaultReasoningEffort; }

let _apiKeyRotator: any = null;
function getApiKeyRotator() { if (!_apiKeyRotator) _apiKeyRotator = require_("../services/apiKeyRotator.ts"); return _apiKeyRotator; }

let _responseModelEcho: any = null;
function getResponseModelEcho() { if (!_responseModelEcho) _responseModelEcho = require_("../services/responseModelEcho.ts"); return _responseModelEcho; }

let _codexExecutor: any = null;
function getCodexExecutor() { if (!_codexExecutor) _codexExecutor = require_("../executors/codex.ts"); return _codexExecutor; }

let _resourcePressure: any = null;
function getResourcePressure() { if (!_resourcePressure) _resourcePressure = require_("../utils/resourcePressure.ts"); return _resourcePressure; }

let _requestLogger: any = null;
function getRequestLogger() { if (!_requestLogger) _requestLogger = require_("../utils/requestLogger.ts"); return _requestLogger; }

let _providerRequestLogging: any = null;
function getProviderRequestLogging() { if (!_providerRequestLogging) _providerRequestLogging = require_("../utils/providerRequestLogging.ts"); return _providerRequestLogging; }

let _streamReadiness: any = null;
function getStreamReadiness() { if (!_streamReadiness) _streamReadiness = require_("../utils/streamReadiness.ts"); return _streamReadiness; }

let _streamReadinessPolicy: any = null;
function getStreamReadinessPolicy() { if (!_streamReadinessPolicy) _streamReadinessPolicy = require_("../utils/streamReadinessPolicy.ts"); return _streamReadinessPolicy; }

let _thinkCloseMarker: any = null;
function getThinkCloseMarker() { if (!_thinkCloseMarker) _thinkCloseMarker = require_("../utils/thinkCloseMarker.ts"); return _thinkCloseMarker; }

let _agentGoalPolicy: any = null;
function getAgentGoalPolicy() { if (!_agentGoalPolicy) _agentGoalPolicy = require_("../utils/agentGoalPolicy.ts"); return _agentGoalPolicy; }

let _responsesStatePolicy: any = null;
function getResponsesStatePolicy() { if (!_responsesStatePolicy) _responsesStatePolicy = require_("../utils/responsesStatePolicy.ts"); return _responsesStatePolicy; }

let _toolSources: any = null;
function getToolSources() { if (!_toolSources) _toolSources = require_("../utils/toolSources.ts"); return _toolSources; }

let _clinepassEnvelope: any = null;
function getClinepassEnvelope() { if (!_clinepassEnvelope) _clinepassEnvelope = require_("../utils/clinepassEnvelope.ts"); return _clinepassEnvelope; }

let _bypassHandler: any = null;
function getBypassHandler() { if (!_bypassHandler) _bypassHandler = require_("../utils/bypassHandler.ts"); return _bypassHandler; }

let _backgroundRedirect: any = null;
function getBackgroundRedirect() { if (!_backgroundRedirect) _backgroundRedirect = require_("./chatCore/backgroundRedirect.ts"); return _backgroundRedirect; }

let _cacheUsageMeta: any = null;
function getCacheUsageMeta() { if (!_cacheUsageMeta) _cacheUsageMeta = require_("./chatCore/cacheUsageMeta.ts"); return _cacheUsageMeta; }

let _claudeEffortVariant: any = null;
function getClaudeEffortVariant() { if (!_claudeEffortVariant) _claudeEffortVariant = require_("./chatCore/claudeEffortVariant.ts"); return _claudeEffortVariant; }

let _claudeUpstreamMessages: any = null;
function getClaudeUpstreamMessages() { if (!_claudeUpstreamMessages) _claudeUpstreamMessages = require_("./chatCore/claudeUpstreamMessages.ts"); return _claudeUpstreamMessages; }

let _clineResponseEnvelope: any = null;
function getClineResponseEnvelope() { if (!_clineResponseEnvelope) _clineResponseEnvelope = require_("./chatCore/clineResponseEnvelope.ts"); return _clineResponseEnvelope; }

let _codexQuota: any = null;
function getCodexQuota() { if (!_codexQuota) _codexQuota = require_("./chatCore/codexQuota.ts"); return _codexQuota; }

let _comboContextCache: any = null;
function getComboContextCache() { if (!_comboContextCache) _comboContextCache = require_("./chatCore/comboContextCache.ts"); return _comboContextCache; }

let _executorHelpers: any = null;
function getExecutorHelpers() { if (!_executorHelpers) _executorHelpers = require_("./chatCore/executorHelpers.ts"); return _executorHelpers; }

let _keyHealth: any = null;
function getKeyHealth() { if (!_keyHealth) _keyHealth = require_("./chatCore/keyHealth.ts"); return _keyHealth; }

let _pluginOnRequest: any = null;
function getPluginOnRequest() { if (!_pluginOnRequest) _pluginOnRequest = require_("./chatCore/pluginOnRequest.ts"); return _pluginOnRequest; }

let _serviceTier: any = null;
function getServiceTier() { if (!_serviceTier) _serviceTier = require_("./chatCore/serviceTier.ts"); return _serviceTier; }

let _stageTrace: any = null;
function getStageTrace() { if (!_stageTrace) _stageTrace = require_("./chatCore/stageTrace.ts"); return _stageTrace; }

let _eventBus: any = null;
function getEventBus() { if (!_eventBus) _eventBus = require_("@/lib/events/eventBus"); return _eventBus; }

let _compliance: any = null;
function getCompliance() { if (!_compliance) _compliance = require_("@/lib/compliance"); return _compliance; }

// ── Additional lazy imports — heavy modules not needed for simple direct requests ──

let _modelFamilyFallback: any = null;
function getModelFamilyFallback() { if (!_modelFamilyFallback) _modelFamilyFallback = require_("../services/modelFamilyFallback.ts"); return _modelFamilyFallback; }

let _errorClassifier: any = null;
function getErrorClassifier() { if (!_errorClassifier) _errorClassifier = require_("../services/errorClassifier.ts"); return _errorClassifier; }

let _modelscopePolicy: any = null;
function getModelscopePolicy() { if (!_modelscopePolicy) _modelscopePolicy = require_("../services/modelscopePolicy.ts"); return _modelscopePolicy; }

let _geminiRateLimitTracker: any = null;
function getGeminiRateLimitTracker() { if (!_geminiRateLimitTracker) _geminiRateLimitTracker = require_("../services/geminiRateLimitTracker.ts"); return _geminiRateLimitTracker; }

let _claudeCodeCompatible: any = null;
function getClaudeCodeCompatible() { if (!_claudeCodeCompatible) _claudeCodeCompatible = require_("../services/claudeCodeCompatible.ts"); return _claudeCodeCompatible; }

let _claudeAdaptiveThinking: any = null;
function getClaudeAdaptiveThinking() { if (!_claudeAdaptiveThinking) _claudeAdaptiveThinking = require_("../services/claudeAdaptiveThinking.ts"); return _claudeAdaptiveThinking; }

let _opencodeReasoningSanitizer: any = null;
function getOpencodeReasoningSanitizer() { if (!_opencodeReasoningSanitizer) _opencodeReasoningSanitizer = require_("../services/opencodeReasoningSanitizer.ts"); return _opencodeReasoningSanitizer; }

let _gpt5SamplingGuard: any = null;
function getGpt5SamplingGuard() { if (!_gpt5SamplingGuard) _gpt5SamplingGuard = require_("../services/gpt5SamplingGuard.ts"); return _gpt5SamplingGuard; }

let _tokenRefresh: any = null;
function getTokenRefresh() { if (!_tokenRefresh) _tokenRefresh = require_("../services/tokenRefresh.ts"); return _tokenRefresh; }

let _dbProviders: any = null;
function getDbProviders() { if (!_dbProviders) _dbProviders = require_("@/lib/db/providers"); return _dbProviders; }

let _sessionAccountAffinity: any = null;
function getSessionAccountAffinity() { if (!_sessionAccountAffinity) _sessionAccountAffinity = require_("@/lib/db/sessionAccountAffinity"); return _sessionAccountAffinity; }

let _codexFastTier: any = null;
function getCodexFastTier() { if (!_codexFastTier) _codexFastTier = require_("@/lib/providers/codexFastTier"); return _codexFastTier; }

let _requestDefaults: any = null;
function getRequestDefaults() { if (!_requestDefaults) _requestDefaults = require_("@/lib/providers/requestDefaults"); return _requestDefaults; }

let _circuitBreaker: any = null;
function getCircuitBreaker() { if (!_circuitBreaker) _circuitBreaker = require_("@/shared/utils/circuitBreaker"); return _circuitBreaker; }

let _diagnostics: any = null;
function getDiagnostics() { if (!_diagnostics) _diagnostics = require_("../utils/diagnostics.ts"); return _diagnostics; }

let _refreshSerializer: any = null;
function getRefreshSerializer() { if (!_refreshSerializer) _refreshSerializer = require_("@omniroute/open-sse/services/refreshSerializer.ts"); return _refreshSerializer; }

let _streamErrorResult: any = null;
function getStreamErrorResult() { if (!_streamErrorResult) _streamErrorResult = require_("./chatCore/streamErrorResult.ts"); return _streamErrorResult; }

let _streamFinalize: any = null;
function getStreamFinalize() { if (!_streamFinalize) _streamFinalize = require_("./chatCore/streamFinalize.ts"); return _streamFinalize; }

let _nonStreamingResponseBody: any = null;
function getNonStreamingResponseBody() { if (!_nonStreamingResponseBody) _nonStreamingResponseBody = require_("./chatCore/nonStreamingResponseBody.ts"); return _nonStreamingResponseBody; }

let _nonStreamingResponseParse: any = null;
function getNonStreamingResponseParse() { if (!_nonStreamingResponseParse) _nonStreamingResponseParse = require_("./chatCore/nonStreamingResponseParse.ts"); return _nonStreamingResponseParse; }

let _nonStreamingUsageStats: any = null;
function getNonStreamingUsageStats() { if (!_nonStreamingUsageStats) _nonStreamingUsageStats = require_("./chatCore/nonStreamingUsageStats.ts"); return _nonStreamingUsageStats; }

let _streamingUsageStats: any = null;
function getStreamingUsageStats() { if (!_streamingUsageStats) _streamingUsageStats = require_("./chatCore/streamingUsageStats.ts"); return _streamingUsageStats; }

let _streamingCost: any = null;
function getStreamingCost() { if (!_streamingCost) _streamingCost = require_("./chatCore/streamingCost.ts"); return _streamingCost; }

let _streamingQuotaShare: any = null;
function getStreamingQuotaShare() { if (!_streamingQuotaShare) _streamingQuotaShare = require_("./chatCore/streamingQuotaShare.ts"); return _streamingQuotaShare; }

let _quotaShareConsumption: any = null;
function getQuotaShareConsumption() { if (!_quotaShareConsumption) _quotaShareConsumption = require_("./chatCore/quotaShareConsumption.ts"); return _quotaShareConsumption; }

let _pluginOnResponse: any = null;
function getPluginOnResponse() { if (!_pluginOnResponse) _pluginOnResponse = require_("./chatCore/pluginOnResponse.ts"); return _pluginOnResponse; }

let _passthroughToolNames: any = null;
function getPassthroughToolNames() { if (!_passthroughToolNames) _passthroughToolNames = require_("./chatCore/passthroughToolNames.ts"); return _passthroughToolNames; }

let _responseTranslator: any = null;
function getResponseTranslator() { if (!_responseTranslator) _responseTranslator = require_("./responseTranslator.ts"); return _responseTranslator; }

let _usageExtractor: any = null;
function getUsageExtractor() { if (!_usageExtractor) _usageExtractor = require_("./usageExtractor.ts"); return _usageExtractor; }

let _responseSanitizer: any = null;
function getResponseSanitizer() { if (!_responseSanitizer) _responseSanitizer = require_("./responseSanitizer.ts"); return _responseSanitizer; }

let _unsupportedParamsStrip: any = null;
function getUnsupportedParamsStrip() { if (!_unsupportedParamsStrip) _unsupportedParamsStrip = require_("./chatCore/unsupportedParamsStrip.ts"); return _unsupportedParamsStrip; }

let _toolCallingRequiredCheck: any = null;
function getToolCallingRequiredCheck() { if (!_toolCallingRequiredCheck) _toolCallingRequiredCheck = require_("./chatCore/toolCallingRequiredCheck.ts"); return _toolCallingRequiredCheck; }

let _modelCapabilities: any = null;
function getModelCapabilities() { if (!_modelCapabilities) _modelCapabilities = require_("@/lib/modelCapabilities.ts"); return _modelCapabilities; }

let _modelSpecs: any = null;
function getModelSpecs() { if (!_modelSpecs) _modelSpecs = require_("@/shared/constants/modelSpecs.ts"); return _modelSpecs; }

let _resilienceSettings: any = null;
function getResilienceSettings() { if (!_resilienceSettings) _resilienceSettings = require_("@/lib/resilience/settings"); return _resilienceSettings; }

let _defaultThinkingSignature: any = null;
function getDefaultThinkingSignature() { if (!_defaultThinkingSignature) _defaultThinkingSignature = require_("../config/defaultThinkingSignature.ts"); return _defaultThinkingSignature; }

let _stream: any = null;
function getStream() { if (!_stream) _stream = require_("../utils/stream.ts"); return _stream; }

let _rateLimitManager: any = null;
function getRateLimitManager() { if (!_rateLimitManager) _rateLimitManager = require_("../services/rateLimitManager.ts"); return _rateLimitManager; }

let _accountSemaphore: any = null;
function getAccountSemaphore() { if (!_accountSemaphore) _accountSemaphore = require_("../services/accountSemaphore.ts"); return _accountSemaphore; }

let _auth: any = null;
function getAuth() { if (!_auth) _auth = require_("@/sse/services/auth"); return _auth; }

let _localDb: any = null;
function getLocalDb() { if (!_localDb) _localDb = require_("@/lib/localDb"); return _localDb; }

let _cacheControlSettingsModule: any = null;
function getCacheControlSettingsModule() { if (!_cacheControlSettingsModule) _cacheControlSettingsModule = require_("@/lib/cacheControlSettings"); return _cacheControlSettingsModule; }

let _cacheControlPolicy: any = null;
function getCacheControlPolicy() { if (!_cacheControlPolicy) _cacheControlPolicy = require_("../utils/cacheControlPolicy.ts"); return _cacheControlPolicy; }

let _readCache: any = null;
function getReadCache() { if (!_readCache) _readCache = require_("@/lib/db/readCache"); return _readCache; }

let _logEnv: any = null;
function getLogEnv() { if (!_logEnv) _logEnv = require_("@/lib/logEnv"); return _logEnv; }

let _usageDb: any = null;
function getUsageDb() { if (!_usageDb) _usageDb = require_("@/lib/usageDb"); return _usageDb; }

let _pendingRequestScope: any = null;
function getPendingRequestScope() { if (!_pendingRequestScope) _pendingRequestScope = require_("@/lib/usage/pendingRequestScope"); return _pendingRequestScope; }

let _costRules: any = null;
function getCostRules() { if (!_costRules) _costRules = require_("@/domain/costRules"); return _costRules; }

let _costCalculator: any = null;
function getCostCalculator() { if (!_costCalculator) _costCalculator = require_("@/lib/usage/costCalculator"); return _costCalculator; }

let _upstreamTimeouts: any = null;
function getUpstreamTimeouts() { if (!_upstreamTimeouts) _upstreamTimeouts = require_("./chatCore/upstreamTimeouts.ts"); return _upstreamTimeouts; }

let _upstreamExecuteHeaders: any = null;
function getUpstreamExecuteHeaders() { if (!_upstreamExecuteHeaders) _upstreamExecuteHeaders = require_("./chatCore/upstreamExecuteHeaders.ts"); return _upstreamExecuteHeaders; }

let _upstreamBody: any = null;
function getUpstreamBody() { if (!_upstreamBody) _upstreamBody = require_("./chatCore/upstreamBody.ts"); return _upstreamBody; }

let _attemptLogging: any = null;
function getAttemptLogging() { if (!_attemptLogging) _attemptLogging = require_("./chatCore/attemptLogging.ts"); return _attemptLogging; }

let _requestId: any = null;
function getRequestId() { if (!_requestId) _requestId = require_("@/shared/utils/requestId"); return _requestId; }

let _aiSdkCompat: any = null;
function getAiSdkCompat() { if (!_aiSdkCompat) _aiSdkCompat = require_("../utils/aiSdkCompat.ts"); return _aiSdkCompat; }

let _additionalTools: any = null;
function getAdditionalTools() { if (!_additionalTools) _additionalTools = require_("../translator/request/openai-responses/additionalTools.ts"); return _additionalTools; }

let _modelStrip: any = null;
function getModelStrip() { if (!_modelStrip) _modelStrip = require_("../services/modelStrip.ts"); return _modelStrip; }

let _tokenLimitCounter: any = null;
function getTokenLimitCounter() { if (!_tokenLimitCounter) _tokenLimitCounter = require_("@omniroute/open-sse/services/tokenLimitCounter.ts"); return _tokenLimitCounter; }

let _interceptionRules: any = null;
function getInterceptionRules() { if (!_interceptionRules) _interceptionRules = require_("@/lib/db/interceptionRules"); return _interceptionRules; }

// Lazy re-exports for comboContextCache (export wrappers that load on first call)
export const clearCombosCache = (...args: any[]) => getComboContextCache().clearCombosCache(...args);
export const clearUpstreamProxyConfigCache = (...args: any[]) => getComboContextCache().clearUpstreamProxyConfigCache(...args);
// ── Eager imports (needed for every request) ──
import { createStreamController } from "../utils/streamHandler.ts";
import * as streamFailure from "../utils/streamFailureFinalization.ts";
import { getUnsupportedParams, REGISTRY } from "../config/providerRegistry.ts";
import {
  buildErrorBody,
  createErrorResult,
  parseUpstreamError,
  formatProviderError,
  sanitizeErrorMessage,
} from "../utils/error.ts";
import {
  COOLDOWN_MS,
  HTTP_STATUS,
  PROVIDER_MAX_TOKENS,
  STREAM_READINESS_MAX_TIMEOUT_MS,
  STREAM_READINESS_TIMEOUT_MS,
  ANTIGRAVITY_PRE_RESPONSE_TIMEOUT_CODE,
  STREAM_RECOVERY,
  STREAM_DISCONNECT_GRACE_PERIOD_MS,
} from "../config/constants.ts";
import { buildExecutorClientHeaders } from "./chatCore/executorClientHeaders.ts";
import { resolveExecutionCredentials as resolveExecutionCredentialsFor } from "./chatCore/executionCredentials.ts";
import { resolveExecutorWithProxy as resolveExecutorWithProxyFor } from "./chatCore/executorProxy.ts";
// Type-only imports (no runtime cost)
import type { ClaudeMessage } from "./chatCore/claudeMessageTypes.ts";
import type { EffectiveServiceTier } from "./chatCore/serviceTier.ts";
import type { PersistAttemptLogsArgs } from "./chatCore/attemptLogging.ts";
// Context manager removed (thin gateway) — token limit functions stubbed with defaults.
const getTokenLimit = (_provider: string, _model: string): number => 128_000;
const getComboTargetTokenLimit = (_target: { modelStr?: string; provider?: string }): number | null => null;
const resolveComboContextLimit = ({ model: _model }: { provider?: string; model?: string; comboTargetLimits?: number[] }): { limit: number; source: string } => ({ limit: 128_000, source: "default" });
// Signature caching removed (thin gateway) — setGeminiThoughtSignatureMode stubbed to no-op.
const setGeminiThoughtSignatureMode = (_mode: unknown) => {};
/**
 * Core chat handler - shared between SSE and Worker
 * Returns { success, response, status, error } for caller to handle fallback
 * @param {object} options
 * @param {object} options.body - Request body
 * @param {object} options.modelInfo - { provider, model }
 * @param {object} options.credentials - Provider credentials
 * @param {object} options.log - Logger instance (optional)
 * @param {function} options.onCredentialsRefreshed - Callback when credentials are refreshed
 * @param {function} options.onRequestSuccess - Callback when request succeeds (to clear error status)
 * @param {function} options.onDisconnect - Callback when client disconnects
 * @param {string} options.connectionId - Connection ID for usage tracking
 * @param {object} options.apiKeyInfo - API key metadata for usage attribution
 * @param {string} options.userAgent - Client user agent for caching decisions
 * @param {string} options.comboName - Combo name if this is a combo request
 * @param {string} options.comboStrategy - Combo routing strategy (e.g., 'priority', 'cost-optimized')
 * @param {boolean} options.isCombo - Whether this request is from a combo
 * @param {string} options.connectionId - Connection ID for settings lookup
 */
export async function handleChatCore({
  body,
  modelInfo,
  credentials,
  log,
  onCredentialsRefreshed,
  onRequestSuccess,
  onStreamFailure,
  onDisconnect,
  clientRawRequest,
  connectionId,
  apiKeyInfo = null,
  userAgent,
  comboName,
  comboStrategy = null,
  isCombo = false,
  routingComboId = null,
  comboStepId = null,
  comboExecutionKey = null,
  cachedSettings = null,
  skipUpstreamRetry = false,
  createPiiTransform = null,
  correlationId = null,
  modelPinned = false,
  skipResourcePressureGuard = false,
}) {
  let { provider, model, extendedContext } = modelInfo;
  if (!skipResourcePressureGuard) {
    try {
      const pressureGuard = getResourcePressure().checkResourcePressureGuard();
      if (pressureGuard) return pressureGuard;
    } catch {
      /* fail open */
    }
  }
  // Per-request model-routing metadata (first extracted slice of the request-setup phase).
  const { apiFormat, customModelTargetFormat, requestedModel } = resolveChatCoreRequestSetup(
    modelInfo,
    body,
    model
  );
  // Thin gateway: ModelScope detection only relevant for modelscope provider.
  const isModelScope = () => provider === "modelscope" && getModelscopePolicy().isModelScopeProvider(provider, credentials?.providerSpecificData);
  const startTime = Date.now();
  // Per-request trace id + checkpoint helper. Lets us see exactly which await
  // a hung request was sitting on in `[STAGE_TRACE]` log lines. Uses crypto RNG
  // (not Math.random) purely to satisfy CodeQL js/insecure-randomness — this id
  // is a log-correlation token, not a security secret.
  const traceId = globalThis.crypto.randomUUID().slice(0, 6);
  // Emit request.started event for real-time dashboard
  setImmediate(() => {
    const { emit } = getEventBus();
    emit("request.started", {
      id: traceId,
      model: model || "unknown",
      provider: provider || "unknown",
      timestamp: startTime,
      comboName: comboName || undefined,
    });
  });
  const traceEnabled = process.env.OMNIROUTE_TRACE === "true" || process.env.DEBUG === "true";
  // Stage trace extracted to chatCore/stageTrace.ts (#3501); bind the per-request inputs once so the
  // call sites stay byte-identical.
  const trace = (label: string, extra?: Record<string, unknown>) =>
    getStageTrace().stageTrace(label, extra, { traceEnabled, startTime, traceId, log });
  const getCurrentConnectionId = () => {
    const credentialConnectionId =
      typeof credentials?.connectionId === "string" && credentials.connectionId.trim().length > 0
        ? credentials.connectionId.trim()
        : null;
    return credentialConnectionId || connectionId || null;
  };
  let tokensCompressed: number | null = null;
  // ── Plugin onRequest hook ──
  // Thin gateway: skip plugin hooks entirely (no plugin system loaded).
  // Plugin gate is a no-op pass-through when plugins are disabled.
  const pluginGate = { blocked: false as boolean, body: undefined as unknown };
  // Plugin system disabled in thin gateway mode — uncomment to re-enable:
  // const { runPluginOnRequestHook } = getPluginOnRequest();
  // pluginGate = await runPluginOnRequestHook({ requestId: traceId, body, model, provider, apiKeyInfo, headers: clientRawRequest?.headers, log });
  if (pluginGate.blocked === true) {
    return {
      success: false,
      status: 403,
      // Label the source: this 403 is our own policy decision, not the provider
      // rejecting us. Unlabelled, it is indistinguishable from a real upstream 403
      // and gets the connection banned. Matches the type already sent to the client
      // in pluginOnRequest.ts.
      errorType: "plugin_block",
      errorCode: "plugin_block",
      error: "Request blocked by plugin",
      response: pluginGate.response,
    };
  }
  if (pluginGate.body) {
    body = pluginGate.body;
  }
  // Per-API-key device/connection tracking removed (thin gateway).
  // Agent-goal policy is opt-in via header — skip module load entirely when header absent.
  const agentGoalHeader = clientRawRequest?.headers
    ? (typeof clientRawRequest.headers.get === 'function'
        ? clientRawRequest.headers.get('x-omniroute-agent-goal')
        : (clientRawRequest.headers as Record<string, string>)?.['x-omniroute-agent-goal'])
    : null;
  let agentGoalPolicy = { detected: false, readinessMaxTimeoutMs: 600000, streamRecoveryEnabled: false };
  if (agentGoalHeader) {
    const { resolveAgentGoalPolicy } = getAgentGoalPolicy();
    agentGoalPolicy = resolveAgentGoalPolicy(body, clientRawRequest?.headers ?? null);
    if (agentGoalPolicy.detected) {
      log?.debug?.(
        "AGENT_GOAL",
        `long-running goal mode enabled: readinessMax=${agentGoalPolicy.readinessMaxTimeoutMs}ms streamRecovery=${agentGoalPolicy.streamRecoveryEnabled}`
      );
    }
  }
  let effectiveServiceTier: EffectiveServiceTier = "standard";
  // Codex service-tier resolvers extracted to chatCore/serviceTier.ts (#3501); bind the per-request
  // provider/credentials once and delegate so the existing call sites stay byte-identical.
  const resolveEffectiveServiceTier = (requestBody?: unknown): EffectiveServiceTier =>
    getServiceTier().resolveEffectiveServiceTier(provider, credentials?.providerSpecificData, requestBody);
  const resolveReportedServiceTier = (
    payload?: unknown,
    maxDepth = 3
  ): EffectiveServiceTier | null => getServiceTier().resolveReportedServiceTier(provider, payload, maxDepth);
  // Failure usage record building removed (thin gateway); stub to no-op.
  const persistFailureUsage = (_statusCode: number, _errorCode?: string | null) => {};
  // Key-health updater extracted to chatCore/keyHealth.ts (#3501); bind the per-request log once
  // and delegate so the existing call sites stay byte-identical.
  const recordKeyHealthStatus = (
    status: number,
    creds: Record<string, unknown> | null | undefined,
    transport?: string
  ): void => getKeyHealth().recordKeyHealthStatus(status, creds, log, transport);
  const persistCodexQuotaState = async (headers: Record<string, string> | null, status = 0) => {
    const currentConnectionId = getCurrentConnectionId();
    if (provider !== "codex" || !currentConnectionId || !headers) return;
    try {
      const existingProviderData =
        credentials?.providerSpecificData && typeof credentials.providerSpecificData === "object"
          ? (credentials.providerSpecificData as Record<string, unknown>)
          : {};
      // Pure payload build extracted to chatCore/codexQuota.ts (#3501). Returns null when the
      // response carries no quota headers (nothing to persist).
      const built = getCodexQuota().buildCodexQuotaPersistence({
        headers,
        existingProviderData,
        modelForScope: model || requestedModel || "",
        status,
      });
      if (!built) return;
      if (built.exhaustionLog) {
        log?.debug?.("CODEX", built.exhaustionLog);
      }
      // Invalidate the preflight cache for this connection so the next
      // isModelAvailable check fetches fresh quota data.
      if (status === 429) {
        getCodexQuotaFetcher().invalidateCodexQuotaCache(currentConnectionId);
      }
      await getDbProviders().updateProviderConnection(currentConnectionId, {
        providerSpecificData: built.nextProviderData,
      });
      credentials.providerSpecificData = built.nextProviderData;
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      log?.debug?.("CODEX", `Failed to persist codex quota state: ${errMessage}`);
    }
  };
  // Idempotency cache removed (thin gateway).
  // T07: Inject connectionId into credentials so executors can rotate API keys
  // using providerSpecificData.extraApiKeys (API Key Round-Robin feature)
  if (connectionId && credentials && !credentials.connectionId) {
    credentials.connectionId = connectionId;
  }
  // Endpoint/format resolution extracted to chatCore/requestFormat.ts (#3501); pure derivation
  // from the inbound request, destructured so every downstream use stays byte-identical.
  const {
    endpointPath,
    sourceFormat,
    isResponsesEndpoint,
    nativeCodexPassthrough,
    nativeXaiResponsesPassthrough,
    isDroidCLI,
    isOpencodeClient,
    copilotCompatibleReasoning,
    clientResponseFormat,
  } = resolveChatCoreRequestFormat({ clientRawRequest, body, provider, userAgent });
  const responsesInputItems = Array.isArray(body?.input) ? body.input : [];
  const customToolNames = getAdditionalTools().collectCustomToolNamesForSourceFormat(
    sourceFormat,
    FORMATS.OPENAI_RESPONSES,
    body?.tools,
    responsesInputItems
  );

  // Check for bypass patterns (warmup, skip) - return fake response
  // Thin gateway: only claude-cli sends bypass patterns — skip module load for other clients.
  const bypassResponse = (typeof userAgent === "string" && userAgent.includes("claude-cli"))
    ? getBypassHandler().handleBypassRequest(body, model, userAgent)
    : null;
  if (bypassResponse) {
    return bypassResponse;
  }

  // ── Claude Code auto-mode classifier compat (opt-in, default "off") ──
  // Claude Code's `--permission-mode auto` sends an internal classifier request that
  // requires the response to START with `<block>no</block>`/`<block>yes</block>`.
  // When a combo/fallback route sends that call to a cheap model returning 200 with
  // empty content, Claude Code fails closed on every gated action. Detect the
  // classifier request and short-circuit with a synthetic ALLOW response, WITHOUT
  // calling the upstream provider. See chatCore/claudeClassifierCompat.ts.
  {
    const classifierSettings = cachedSettings ?? (await getReadCache().getCachedSettings());
    if (
      shouldDefaultAllowClassifier(
        sourceFormat,
        body as Record<string, unknown>,
        classifierSettings.claudeClassifierCompat as string | undefined
      )
    ) {
      log?.warn?.(
        "CHAT",
        `classifier compat=${classifierSettings.claudeClassifierCompat} | short-circuit default-allow`
      );
      return buildDefaultAllowClaudeMessage(requestedModel);
    }
  }

  // Detect source format and get target format
  // Model-specific targetFormat takes priority over provider default

  // ── Background Task Redirection (T41) — decision extracted to chatCore/backgroundRedirect.ts (#3501)
  // Thin gateway: background task redirect disabled — skip module load.
  const backgroundReason: string | null = null;
  const bgRedirect: { degradedModel: string; reason: string } | null = null;
  // const { backgroundReason, redirect: bgRedirect } = getBackgroundRedirect().resolveBackgroundTaskRedirect({
  //   body, headers: clientRawRequest?.headers, model,
  // });
  if (bgRedirect) {
    const originalModel = model;
    log?.info?.(
      "BACKGROUND",
      `Background task redirect (${bgRedirect.reason}): ${originalModel} → ${bgRedirect.degradedModel}`
    );
    model = bgRedirect.degradedModel;
    if (body && typeof body === "object") {
      body.model = model;
    }

    getCompliance().logAuditEvent({
      action: "routing.background_task_redirect",
      actor: apiKeyInfo?.name || "system",
      target: connectionId || provider || "chat",
      details: {
        original_model: originalModel,
        redirected_to: bgRedirect.degradedModel,
        reason: bgRedirect.reason,
      },
    });
  }

  // Apply custom model aliases (Settings → Model Aliases → Pattern→Target) before routing (#315, #472)
  // Custom aliases take priority over built-in and must be resolved here so the
  // downstream getModelTargetFormat() lookup AND the actual provider request use
  // the correct, aliased model ID. Without this, aliases only affect format detection.
  const resolvedModel = getModelDeprecation().resolveModelAlias(model);
  // Use resolvedModel for all downstream operations (routing, provider requests, logging)
  let effectiveModel = resolvedModel === model ? model : resolvedModel;
  if (resolvedModel !== model) {
    log?.info?.("ALIAS", `Model alias applied: ${model} → ${resolvedModel}`);
  }

  // Effort-variant model ids: the Claude / Claude-Code model picker (e.g. VS Code's
  // "Effort" slider) advertises claude-...-{low,medium,high,xhigh,max}. Anthropic has
  // no such model, so the suffixed id 404s upstream. Strip it back to the real base id
  // (forwarded as the upstream model via finalModelToUpstream below) and surface the
  // level as reasoning_effort so the OpenAI→Claude translator / Claude-Code bridge turn
  // it into Claude thinking/effort config. An explicit client-supplied effort always
  // wins; native Claude passthrough is left untouched (it carries its own `thinking`),
  // and non-thinking base models are cleaned up later by normalizeThinkingForModel().
  // Extracted to chatCore/claudeEffortVariant.ts (#3501); mutates body in place and returns the
  // stripped model + an optional log line, keeping behaviour byte-identical.
  if (provider === "claude" || provider === "anthropic" || sourceFormat === FORMATS.CLAUDE) {
    const effortVariant = getClaudeEffortVariant().applyClaudeEffortVariant({
      provider,
      effectiveModel,
      body,
      sourceFormat,
    });
    effectiveModel = effortVariant.effectiveModel;
    if (effortVariant.log) {
      log?.info?.("PARAMS", effortVariant.log);
    }
  }

  // Wire target-format resolution extracted to chatCore/targetFormat.ts (#3501); `alias` is reused
  // downstream when stripping the alias/ prefix off the upstream model id.
  const { alias, targetFormat } = resolveChatCoreTargetFormat({
    provider,
    resolvedModel,
    apiFormat,
    sourceFormat,
    customModelTargetFormat,
    providerSpecificData: credentials?.providerSpecificData,
    nativeXaiResponsesPassthrough,
  });
  const nativeResponsesPassthrough = nativeCodexPassthrough || nativeXaiResponsesPassthrough;

  const initialProviderRequest =
    body && typeof body === "object" && !Array.isArray(body)
      ? {
          ...(body as Record<string, unknown>),
          model:
            typeof (body as Record<string, unknown>).model === "string"
              ? (body as Record<string, unknown>).model
              : effectiveModel,
        }
      : body;

  // Track pending requests before slower optional enrichment (settings, logging,
  // compression) so internal usage/runtime counters stay accurate even when
  // upstream never returns response headers.
  // Use credentials.connectionId as a fallback so that requests without an
  // explicit session-level connectionId still register in the pendingRequests map.
  const pendingConnId = connectionId || credentials?.connectionId || null;
  const pendingRequestId =
    getUsageDb().trackPendingRequest(model, provider, pendingConnId, true, {
      clientEndpoint: clientRawRequest?.endpoint || "/v1/chat/completions",
      clientRequest: clientRawRequest?.body ?? body,
      providerRequest: initialProviderRequest,
      stage: "registered",
      correlationId,
    }) || getRequestId().generateRequestId();

  // Initialize rate limit settings from persisted DB (once, lazy)
  await getRateLimitManager().initializeRateLimits();

  // #3384: per-model interception rule (src/lib/db/interceptionRules.ts) overrides the
  // native-bypass defaults below when the operator explicitly configured it for this
  // provider/model pair; undefined falls through to the existing bypass logic.
  // Thin-gateway: skip web search/fetch interception entirely when no tools are present.
  if (Array.isArray((body as Record<string, unknown>)?.tools) && (body as Record<string, unknown>).tools.length > 0) {
  const interceptSearchOverride = getInterceptionRules().resolveInterceptSearch(provider, effectiveModel);
  const { body: bodyWithWebSearchFallback, fallback: webSearchFallbackPlan } =
    getWebSearchFallback().prepareWebSearchFallbackBody(body as Record<string, unknown>, {
      provider,
      sourceFormat,
      targetFormat,
      nativeCodexPassthrough: nativeResponsesPassthrough,
      interceptSearchOverride,
    });
  if (webSearchFallbackPlan.enabled) {
    body = bodyWithWebSearchFallback as typeof body;
    log?.info?.(
      "TOOLS",
      `Converted ${webSearchFallbackPlan.convertedToolCount} web_search tool(s) to OmniRoute fallback for ${provider}`
    );
  }
  // #7339: interceptFetch (Phase 3-4 of #3384) — same per-model rule + native-bypass
  // pattern as interceptSearch directly above.
  const interceptFetchOverride = getInterceptionRules().resolveInterceptFetch(provider, effectiveModel);
  const { body: bodyWithWebFetchFallback, fallback: webFetchFallbackPlan } =
    getWebFetchInterception().prepareWebFetchFallbackBody(body as Record<string, unknown>, {
      provider,
      sourceFormat,
      targetFormat,
      nativeCodexPassthrough: nativeResponsesPassthrough,
      interceptFetchOverride,
    });
  if (webFetchFallbackPlan.enabled) {
    body = bodyWithWebFetchFallback as typeof body;
    log?.info?.(
      "TOOLS",
      `Converted ${webFetchFallbackPlan.convertedToolCount} web_fetch tool(s) to OmniRoute fallback for ${provider}`
    );
  }
  }
  const noLogEnabled = apiKeyInfo?.noLog === true;
  // Consolidate settings reads — fetch once, reuse throughout the request
  const settings = cachedSettings ?? (await getReadCache().getCachedSettings());
  // Opt-in tool-source diagnostics (#1825): summarize the request's tool definitions
  // (count + MCP/hosted/client source breakdown + first names) as a single debug line.
  if (settings.logToolSources === true) {
    const toolSummary = getToolSources().summarizeToolSources((body as { tools?: unknown }).tools);
    if (toolSummary) log?.debug?.("TOOLS", toolSummary);
  }
  // #1311 (opt-in): echo the client-requested alias/combo name in the response `model`
  // field instead of the upstream model, so strict clients (Claude Desktop) that validate
  // response.model === request.model stop rejecting alias/combo requests with a 401.
  // #3697: always echo it for Codex CLI clients on the Responses API — regardless of the
  // opt-in setting — since the Codex CLI status line/model button reads `response.model`
  // to display the active model + reasoning effort (e.g. `gpt-5.5-xhigh`). Detection is by
  // request headers (originator/User-Agent), not by the routed provider, so it still fires
  // when `codex/gpt-5.5-xhigh` is routed through a combo to a non-codex upstream.
  const isCodexResponsesEcho = false;
  const echoModel =
    (settings.echoRequestedModelName === true || isCodexResponsesEcho) &&
    typeof requestedModel === "string" &&
    requestedModel
      ? requestedModel
      : null;
  const detailedLoggingEnabled =
    !noLogEnabled &&
    (settings.call_log_pipeline_enabled === true ||
      settings.call_log_pipeline_enabled === "1" ||
      settings.call_log_pipeline_enabled === "true");
  const capturePipelineStreamChunks =
    detailedLoggingEnabled && getLogEnv().getCallLogPipelineCaptureStreamChunks();
  const skillRequestId = getRequestId().generateRequestId();
  // #8249: raw header value, kept separate from `pipelineSessionId`'s skillRequestId fallback
  // below so call_logs.session_tag is only ever set when the caller explicitly supplied the
  // header — never synthesized from the internal per-request skillRequestId.
  const explicitSessionIdHeader =
    (clientRawRequest?.headers && typeof clientRawRequest.headers.get === "function"
      ? clientRawRequest.headers.get("x-omniroute-session-id")
      : getHeaderValueCaseInsensitive(
          clientRawRequest?.headers ?? null,
          "x-omniroute-session-id"
        )) || null;
  const pipelineSessionId = explicitSessionIdHeader || skillRequestId;
  // persistAttemptLogs extracted to chatCore/attemptLogging.ts (#3501); bind the per-request context
  // once so the 16 call sites keep passing only the per-attempt args (byte-identical).
  const persistAttemptLogs = (args: PersistAttemptLogsArgs) =>
    getAttemptLogging().persistAttemptLogs(args, {
      traceId,
      provider,
      connectionId,
      model,
      skillRequestId,
      detailedLoggingEnabled,
      reqLogger,
      pendingRequestId,
      clientRawRequest,
      requestedModel,
      credentials,
      startTime,
      body,
      sourceFormat,
      targetFormat,
      comboName,
      comboStepId,
      comboExecutionKey,
      tokensCompressed,
      apiKeyInfo,
      noLogEnabled,
      correlationId,
      modelPinned,
      sessionTag: explicitSessionIdHeader,
    });

  // Primary path: merge client model id + alias target so config on either key applies; resolved
  // id wins on same header name. T5 family fallback uses only (nextModel, getModelDeprecation().resolveModelAlias(next))
  // so A-model headers are not sent to B — see buildUpstreamHeadersForExecute.
  const connectionCustomUserAgent =
    credentials?.providerSpecificData &&
    typeof credentials.providerSpecificData === "object" &&
    typeof credentials.providerSpecificData.customUserAgent === "string"
      ? credentials.providerSpecificData.customUserAgent.trim()
      : "";

  // #8369: connection-level custom upstream headers from provider_specific_data.
  const connectionCustomHeaders =
    credentials?.providerSpecificData &&
    typeof credentials.providerSpecificData === "object" &&
    typeof credentials.providerSpecificData.customHeaders === "object" &&
    !Array.isArray(credentials.providerSpecificData.customHeaders)
      ? (credentials.providerSpecificData.customHeaders as Record<string, string>)
      : undefined;

  // Upstream extra-header building extracted to chatCore/upstreamExecuteHeaders.ts (#3501); bind the
  // per-request inputs once and delegate so the existing call sites stay byte-identical.
  const buildUpstreamHeadersForExecute = (modelToCall: string): Record<string, string> =>
    getUpstreamExecuteHeaders().buildUpstreamHeadersForExecute({
      modelToCall,
      effectiveModel,
      provider,
      model,
      resolvedModel,
      sourceFormat,
      connectionCustomUserAgent,
      connectionCustomHeaders,
      settings,
    });

  // Default to false unless client explicitly sets stream: true (OpenAI spec compliant)
  const acceptHeader =
    clientRawRequest?.headers && typeof clientRawRequest.headers.get === "function"
      ? clientRawRequest.headers.get("accept") || clientRawRequest.headers.get("Accept")
      : clientRawRequest?.headers?.["accept"] || clientRawRequest?.headers?.["Accept"];
  const streamUserAgent = [
    typeof userAgent === "string" ? userAgent : "",
    getHeaderValueCaseInsensitive(clientRawRequest?.headers ?? null, "user-agent") || "",
  ]
    .filter(Boolean)
    .join(" ");

  // Explicit per-request opt-in/out for the `</think>` close marker
  // (#5312 / #5245): `x-omniroute-thinking-marker: off` suppresses it for
  // reasoning_content-native clients (e.g. Cursor's OpenAI path) that the UA
  // allowlist does not cover; absent the header, the UA policy applies.
  // Thin gateway: skip think-close-marker header lookup (reasoning tag handling).
  const thinkingMarkerHeader: string | null = null;
  // const thinkingMarkerHeader = getHeaderValueCaseInsensitive(
  //   clientRawRequest?.headers ?? null,
  //   getThinkCloseMarker().THINKING_MARKER_HEADER
  // );

  const explicitStreamAlias = getAiSdkCompat().resolveExplicitStreamAlias(body);

  // Remove non-standard non-stream aliases before provider translation/execution.
  // They are accepted for compatibility at the OmniRoute API boundary only.
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (explicitStreamAlias !== undefined) {
      b.stream = explicitStreamAlias;
    }

    delete b.non_stream;
    delete b.disable_stream;
    delete b.disable_streaming;
    delete b.streaming;
  }

  // Codex /responses/compact is JSON-only: Codex CLI does not send stream=false,
  // so route shape must override the usual Accept/header fallback.
  // sourceFormat="claude" applies the Anthropic Messages spec default (stream=false
  // when body omits stream), preventing STREAM_EARLY_EOF on /v1/messages when
  // clients send Accept: */* without an explicit stream flag.
  // providerRequiresStreaming: providers with forceStream:true (cline/clinepass)
  // only implement upstream streaming — a non-streaming request returns
  // "generateText is not implemented" / an empty body. This flag forces the
  // UPSTREAM request to stream (see `upstreamStream` below), but it MUST NOT
  // force the client-facing `stream` flag: a stream:false client (e.g. the
  // model-test button, plain JSON API callers) still expects a JSON response.
  // The client-side `if (!stream)` branch drains the forced upstream SSE and
  // converts it back to JSON via readNonStreamingResponseBody. Passing this
  // flag into resolveStreamFlag would force `stream=true` and skip that
  // conversion, yielding STREAM_EARLY_EOF for JSON callers. (#2081, #6126)
  const providerRequiresStreaming = REGISTRY[provider]?.forceStream === true;
  const stream =
    nativeCodexPassthrough && getCodexExecutor().isCompactResponsesEndpoint(endpointPath)
      ? false
      : getAiSdkCompat().resolveStreamFlag(body?.stream, acceptHeader, sourceFormat, {
          userAgent: streamUserAgent,
          streamDefaultMode: apiKeyInfo?.streamDefaultMode,
        });

  // `settings` is already consolidated once near the top of handleChatCore
  // (the "fetch once, reuse" const). A second `const settings` here was a
  // duplicate same-scope declaration that broke the esbuild/tsx transform
  // ("settings has already been declared") and the production build. Reuse it.
  if (provider === "codex" || provider?.startsWith("codex")) {
  credentials = getCodexFastTier().applyCodexGlobalFastServiceTier(provider, credentials, settings, {
    model: requestedModel,
    body: body && typeof body === "object" ? (body as Record<string, unknown>) : null,
  });
  }
  effectiveServiceTier = resolveEffectiveServiceTier(body);
  setGeminiThoughtSignatureMode(settings.antigravitySignatureCacheMode);

  const reqLogger = await getRequestLogger().createRequestLogger(sourceFormat, targetFormat, model, {
    enabled: detailedLoggingEnabled,
    captureStreamChunks: capturePipelineStreamChunks,
    maxStreamChunkBytes: getLogEnv().getCallLogPipelineMaxSizeBytes(),
    requestId: pendingRequestId,
    model,
    provider: provider || undefined,
    connectionId: connectionId || credentials?.connectionId || undefined,
  });
  const pendingScope = { id: pendingRequestId, model, provider, connectionId: pendingConnId };
  const providerRequestCapture = getProviderRequestLogging().createPreparedRequestLogger(reqLogger, pendingScope);
  // 0. Log client raw request (before format conversion)
  if (clientRawRequest) {
    reqLogger.logClientRawRequest(
      clientRawRequest.endpoint,
      clientRawRequest.body,
      clientRawRequest.headers
    );
  }
  const reasoningRouteDecision =
    body && typeof body === "object"
      ? (body as Record<string, unknown>)._omnirouteReasoningRouteTrace
      : null;
  if (reasoningRouteDecision) {
    reqLogger.logRouteDecision(reasoningRouteDecision);
    body = { ...(body as Record<string, unknown>) };
    delete (body as Record<string, unknown>)._omnirouteReasoningRouteTrace;
  }

  log?.debug?.("FORMAT", `${sourceFormat} → ${targetFormat} | stream=${stream}`);

  // Semantic cache check removed (thin gateway).

  body = sanitizeChatRequestBody(body, sourceFormat, targetFormat);
  const memoryOwnerId = null;
  const memorySettings = null;

  let preCompressionBody: typeof body | null = null;
  let compressionResponseMeta: string | null = null;
  let contextEditingEnabled = false;
  // Hoisted to function scope so the combo-resolved override survives to the final
  // enforceOutputTokenBudget() call further down — see #8378.
  let contextLimit = getTokenLimit(provider, effectiveModel);

  if (isCombo && comboName) {
    log?.info?.("CONTEXT", `Attempting to resolve combo limits for comboName=${comboName}`);
    try {
      const { getComboByName } = await import("../../src/lib/localDb");
      const { resolveComboTargets } = await import("../services/combo.ts");
      let comboConfig = await getComboByName(comboName);
      if (!comboConfig && comboName.startsWith("combo/")) {
        comboConfig = await getComboByName(comboName.substring(6));
      }
      let comboTargetLimits: number[] = [];
      if (comboConfig) {
        const allCombosData = await getComboContextCache().getCombosCached();
        const targets = resolveComboTargets(
          comboConfig as unknown as { name: string; models: unknown[] },
          allCombosData as unknown as { name: string; models: unknown[] }[]
        );
        // Fall back to ResolvedComboTarget.provider when modelStr lacks a
        // provider/ prefix — parseModel alone returns provider:null (#8716).
        comboTargetLimits = targets
          .map((t: { modelStr?: string; provider?: string }) =>
            getComboTargetTokenLimit({ modelStr: t.modelStr, provider: t.provider })
          )
          .filter(
            (limit): limit is number =>
              typeof limit === "number" && Number.isFinite(limit) && limit > 0
          );
      }
      // chatCore executes per concrete target (handleSingleModel resolves
      // provider/effectiveModel before delegating). Compress against THIS
      // target's window; min(...allTargets) is only a defensive fallback —
      // the old unconditional min compressed a 1M-target request at the
      // smallest sibling's window ("agent keeps forgetting things").
      const resolved = resolveComboContextLimit({
        provider,
        model: effectiveModel,
        comboTargetLimits,
      });
      contextLimit = resolved.limit;
      log?.info?.(
        "CONTEXT",
        `Combo context limit: ${resolved.limit} (source=${resolved.source})`
      );
    } catch (err) {
      log?.warn?.("CONTEXT", "Failed to resolve combo limits for compression: " + err);
    }
  }

  // Token estimation + output budget enforcement removed (thin gateway).

  let translatedBody = body;
  const isClaudePassthrough = sourceFormat === FORMATS.CLAUDE && targetFormat === FORMATS.CLAUDE;
  const isClaudeCodeCompatible = false;
  const isClaudeCodeSemanticPassthrough = isClaudeCodeSemanticPassthroughRequest({
    provider,
    sourceFormat,
    targetFormat,
    headers: clientRawRequest?.headers,
    userAgent,
  });
  // `forceStream` providers (e.g. Cline / ClinePass) only implement upstream
  // streaming — a non-streaming request returns "generateText is not implemented"
  // / an empty body. Force the upstream request to stream even when the client
  // wants JSON; the non-streaming branch below accumulates the SSE and converts
  // it back to JSON (same mechanism already used for Claude-Code-compatible
  // providers via isClaudeCodeCompatible).
  const upstreamStream = stream || isClaudeCodeCompatible || providerRequiresStreaming;
  let ccSessionId: string | null = null;
  const stripTypes = getModelStrip().getStripTypesForProviderModel(provider || "", model || "");

  if (Array.isArray(translatedBody?.messages) && stripTypes.length > 0) {
    const stripResult = getModelStrip().stripIncompatibleMessageContent(translatedBody.messages, stripTypes);
    if (stripResult.removedParts > 0) {
      translatedBody = {
        ...translatedBody,
        messages: stripResult.messages,
      };
      log?.warn?.(
        "CONTENT",
        `Stripped ${stripResult.removedParts} incompatible content part(s) for ${provider}/${model}`
      );
    }
  }

  // Determine if we should preserve client-side cache_control headers
  // Thin gateway: cache_control is Claude-specific — skip for non-Claude providers.
  let preserveCacheControl = false;
  if (provider === "claude" || provider === "anthropic" || targetFormat === FORMATS.CLAUDE) {
    const cacheControlMode = await getCacheControlSettingsModule().getCacheControlSettings().catch(() => "auto" as const);
    const connectionCacheOverride = getCacheControlPolicy().resolveConnectionCacheOverride(credentials?.providerSpecificData);
    preserveCacheControl = getCacheControlPolicy().shouldPreserveCacheControl({
      userAgent,
      isCombo,
      comboStrategy,
      targetProvider: provider,
      targetFormat,
      settings: { alwaysPreserveClientCache: cacheControlMode },
      connectionCacheOverride,
    });
  }

  if (preserveCacheControl) {
    log?.debug?.(
      "CACHE",
      `Preserving client cache_control (client=${userAgent?.substring(0, 20)}, combo=${isCombo}, strategy=${comboStrategy}, provider=${provider})`
    );
  }

  // extractSystemMessagesToBody + normalizeClaudeUpstreamMessages extracted to
  // chatCore/claudeUpstreamMessages.ts (#3501); bind `log` once so the call sites stay byte-identical.
  const normalizeClaudeUpstreamMessages = (
    payload: Record<string, unknown>,
    options?: { preserveToolResultBlocks?: boolean }
  ) => getClaudeUpstreamMessages().normalizeClaudeUpstreamMessages(payload, options, log);

  try {
    if (nativeResponsesPassthrough) {
      translatedBody = stampNativeResponsesPassthroughBody(
        body,
        nativeCodexPassthrough ? "codex" : "xai"
      );
      log?.debug?.(
        "FORMAT",
        nativeCodexPassthrough
          ? "native codex passthrough enabled"
          : "native xAI Responses Agent Tools passthrough enabled"
      );
    } else if (isClaudeCodeCompatible) {
      let normalizedForCc = { ...body };

      // Claude Code-compatible providers expect Anthropic Messages-shaped payloads,
      // but we extract only role/text/max_tokens/effort from an OpenAI-like view first.
      if (sourceFormat === FORMATS.CLAUDE && isClaudeCodeSemanticPassthrough) {
        log?.debug?.("FORMAT", "claude-code semantic passthrough enabled for compatible bridge");
      } else if (sourceFormat !== FORMATS.OPENAI) {
        const normalizeToolCallId = getLocalDb().getModelNormalizeToolCallId(
          provider || "",
          model || "",
          sourceFormat
        );
        const preserveDeveloperRole = getLocalDb().getModelPreserveOpenAIDeveloperRole(
          provider || "",
          model || "",
          sourceFormat
        );
        normalizedForCc = translateRequest(
          sourceFormat,
          FORMATS.OPENAI,
          model,
          { ...body },
          stream,
          credentials,
          provider,
          reqLogger,
          {
            normalizeToolCallId,
            preserveDeveloperRole,
            preserveCacheControl,
            copilotClient: copilotCompatibleReasoning,
          }
        );
      }

      ccSessionId = getClaudeCodeCompatible().resolveClaudeCodeCompatibleSessionId(clientRawRequest?.headers);
      const ccRequestDefaults = getRequestDefaults().getClaudeCodeCompatibleRequestDefaults(
        credentials?.providerSpecificData
      );
      translatedBody = getClaudeCodeCompatible().buildClaudeCodeCompatibleRequest({
        sourceBody: body,
        normalizedBody: normalizedForCc,
        claudeBody: sourceFormat === FORMATS.CLAUDE ? body : null,
        model,
        stream: upstreamStream,
        sessionId: ccSessionId,
        cwd: process.cwd(),
        now: new Date(),
        preserveCacheControl,
        preserveClaudeMessages: sourceFormat === FORMATS.CLAUDE && isClaudeCodeSemanticPassthrough,
        summarizeThinking: ccRequestDefaults.summarizeThinking === true,
      });
      log?.debug?.("FORMAT", "claude-code-compatible bridge enabled");

      if (isClaudeCodeSemanticPassthrough) {
        // Semantic passthrough: system role extraction removed (thin gateway).
      } else {
        // Non-CC path: full normalization including content type conversion.
        getClaudeUpstreamMessages().normalizeClaudeUpstreamMessages(translatedBody, { preserveToolResultBlocks: true });
      }
    } else if (isClaudePassthrough) {
      // Pure passthrough: forward the body as-is without OpenAI round-trip.
      // The Claude→OpenAI→Claude double translation was lossy and corrupted
      // payloads at high context (150+ msgs, 100+ tools). Fix: #1359.
      // Claude Code sends well-formed Messages API payloads — trust them
      // regardless of combo strategy or cache_control settings.
      translatedBody = { ...body };
      translatedBody._disableToolPrefix = true;

      // Sanitize historical thinking-block signatures for Anthropic-native Claude OAuth.
      // Only Anthropic's first-party API validates these signatures (token-bound); third-party
      // Claude-shape providers do not. See redactPassthroughThinkingSignatures + issue #2454.
      if (provider === "claude") {
        translatedBody.messages = redactPassthroughThinkingSignatures(
          translatedBody.messages,
          getDefaultThinkingSignature().DEFAULT_THINKING_CLAUDE_SIGNATURE
        ) as typeof translatedBody.messages;

        // Anthropic API rejects requests with both temperature and top_p.
        // VS Code Claude extension and similar clients send both; strip top_p.
        if (translatedBody.temperature !== undefined && translatedBody.top_p !== undefined) {
          delete translatedBody.top_p;
        }
      }

      // Legacy models reject role:"system" messages. Opus accepts them behind
      // its beta, and hoisting them breaks the prompt cache prefix.
      if (isClaudeCodeSemanticPassthrough) {
        // System role extraction + cache control constraints removed (thin gateway).
        if (Array.isArray(translatedBody.messages)) {
          translatedBody.messages = getClaudeHelper().splitMisplacedToolResults(
            translatedBody.messages as ClaudeMessage[]
          ) as typeof translatedBody.messages;
        }
      } else {
        getClaudeUpstreamMessages().normalizeClaudeUpstreamMessages(translatedBody, { preserveToolResultBlocks: true });
      }

      log?.debug?.("FORMAT", `claude passthrough (preserveCache=${preserveCacheControl})`);

      // Migrate deprecated top-level `output_format` → `output_config.format`.
      // Anthropic returns a 400 on the legacy field; some clients (e.g. ForgeCode)
      // still emit it. Preserves an existing output_config.format if present.
      if (translatedBody.output_format !== undefined) {
        const oc =
          translatedBody.output_config && typeof translatedBody.output_config === "object"
            ? (translatedBody.output_config as Record<string, unknown>)
            : {};
        if (oc.format === undefined) oc.format = translatedBody.output_format;
        translatedBody.output_config = oc;
        delete translatedBody.output_format;
      }

      // Fix #1719: Strip output_config.format for non-Anthropic Claude-compatible providers.
      // Third-party Claude endpoints (MiniMax, DeepSeek via aggregators) reject this field
      // with 400 errors since they don't support Anthropic's structured output / json_schema.
      if (
        provider !== "claude" &&
        translatedBody.output_config &&
        typeof translatedBody.output_config === "object"
      ) {
        const oc = translatedBody.output_config as Record<string, unknown>;
        delete oc.format;
        if (Object.keys(oc).length === 0) {
          delete translatedBody.output_config;
        }
      }
    } else {
      translatedBody = { ...body };

      // Issue #199 + #618: Always disable tool name prefix in Claude passthrough.
      // The proxy_ prefix was designed for OpenAI→Claude translation to avoid
      // conflicts with Claude OAuth tools, but in the passthrough path the tools
      // are already in Claude format. Applying the prefix turns "Bash" into
      // "proxy_Bash", which Claude rejects ("No such tool available: proxy_Bash").
      if (targetFormat === FORMATS.CLAUDE) {
        translatedBody._disableToolPrefix = true;
        getClaudeUpstreamMessages().normalizeClaudeUpstreamMessages(translatedBody);
      }

      // OpenAI-compatible providers only support function tools.
      // Non-function tool types (computer, mcp, web_search, custom, etc.) are handled:
      //   - tools with a name → converted to function format in-place before translation
      //   - tools without a name AND without .function → dropped (unconvertible)
      // This must happen before translateRequest, which validates and throws on unknown types.
      if (provider?.startsWith("openai-compatible-") && Array.isArray(translatedBody.tools)) {
        const before = (translatedBody.tools as unknown[]).length;
        translatedBody.tools = (translatedBody.tools as Record<string, unknown>[])
          .filter((t) => !t.type || t.type === "function" || !!t.function || !!t.name)
          .map((t) => {
            if (!t.type || t.type === "function" || t.function) return t;
            // Named non-function tool: normalise to function format so the translator
            // does not throw on the unknown type.
            return {
              type: "function",
              function: {
                name: t.name,
                ...(t.description === undefined ? {} : { description: t.description }),
                ...(t.parameters !== undefined || t.input_schema !== undefined
                  ? { parameters: t.parameters ?? t.input_schema ?? {} }
                  : {}),
                ...(t.strict === undefined ? {} : { strict: t.strict }),
              },
            };
          });
        const dropped = before - (translatedBody.tools as unknown[]).length;
        if (dropped > 0) {
          log?.debug?.(
            "TOOLS",
            `Dropped ${dropped} unconvertible tool(s) for openai-compatible provider`
          );
        }
      }

      const normalizeToolCallId = getLocalDb().getModelNormalizeToolCallId(
        provider || "",
        model || "",
        sourceFormat
      );
      const preserveDeveloperRole = getLocalDb().getModelPreserveOpenAIDeveloperRole(
        provider || "",
        model || "",
        sourceFormat
      );
      translatedBody = translateRequest(
        sourceFormat,
        targetFormat,
        model,
        translatedBody,
        stream,
        credentials,
        provider,
        reqLogger,
        {
          normalizeToolCallId,
          preserveDeveloperRole,
          preserveCacheControl,
          signatureNamespace: connectionId,
          copilotClient: copilotCompatibleReasoning,
          ...(preCompressionBody ? { preCompressionBody } : {}),
        }
      );
    }
  } catch (error) {
    // ── Plugin onError hook ──
    try {
      const { runOnError } = await import("@/lib/plugins/hooks");
      await runOnError(
        { requestId: traceId, body, model, provider, apiKeyInfo, metadata: {} },
        error instanceof Error ? error : new Error(String(error))
      );
    } catch (pluginErr) {
      log?.debug?.(
        "PLUGIN",
        `onError hook error (non-fatal): ${pluginErr instanceof Error ? pluginErr.message : String(pluginErr)}`
      );
    }

    const parsedStatus = Number(error?.statusCode);
    const statusCode =
      Number.isInteger(parsedStatus) && parsedStatus >= 400 && parsedStatus <= 599
        ? parsedStatus
        : HTTP_STATUS.SERVER_ERROR;
    const message = error?.message || "Invalid request";
    const errorType = typeof error?.errorType === "string" ? error.errorType : null;

    log?.warn?.("TRANSLATE", `Request translation failed: ${message}`);

    if (errorType) {
      getUsageDb().trackPendingRequest(model, provider, connectionId, false);
      return {
        success: false,
        status: statusCode,
        error: message,
        response: new Response(
          JSON.stringify({
            error: {
              message,
              type: errorType,
              code: errorType,
            },
          }),
          {
            status: statusCode,
            headers: {
              "Content-Type": "application/json",
            },
          }
        ),
      };
    }

    getUsageDb().trackPendingRequest(model, provider, connectionId, false);
    return createErrorResult(statusCode, message);
  }

  trace("post_translation");

  // Keep the request translator's namespace identities separate from toolNameMap:
  // the latter is a Kiro/Claude passthrough alias channel with string values,
  // while namespace identities carry `{namespace, name}` for the #7936 response
  // seam. Extract first because Kiro merge may reuse `_toolNameMap` below.
  //
  // #9780 — prefer the dedicated channel: on a pivot the openai->claude/gemini
  // step publishes its own alias map on `_toolNameMap`, so that property alone
  // yields aliases here. The `_toolNameMap` read stays as the fallback for the
  // non-pivot producers (executors/base.ts, cliproxyapi.ts, antigravity).
  const namespaceIdentityMap = translatedBody._namespaceToolIdentityMap;
  const requestToolIdentityMap =
    namespaceIdentityMap instanceof Map
      ? namespaceIdentityMap
      : translatedBody._toolNameMap instanceof Map
        ? translatedBody._toolNameMap
        : null;
  delete translatedBody._namespaceToolIdentityMap;
  delete translatedBody._toolNameMap;

  // Kiro tool sanitization removed (thin gateway).

  // Claude tool type defaulting removed (thin gateway).

  // Extract toolNameMap for response translation (Claude OAuth)
  const translatedToolNameMap = translatedBody._toolNameMap;
  const nativeClaudeToolNameMap = isClaudePassthrough
    ? getPassthroughToolNames().buildClaudePassthroughToolNameMap(body)
    : null;
  let toolNameMap: Map<string, string> | null =
    translatedToolNameMap instanceof Map && translatedToolNameMap.size > 0
      ? translatedToolNameMap
      : nativeClaudeToolNameMap;

  // For providers whose _toolNameMap was extracted as requestToolIdentityMap
  // before the Kiro merge block (Gemini/Antigravity), merge it into the
  // response toolNameMap so the response translator can restore tool names
  // from their lowercased form (#9568). Only merge string-valued entries
  // (tool name aliases), not object-valued namespace identities (#7936).
  if (!toolNameMap && requestToolIdentityMap instanceof Map && requestToolIdentityMap.size > 0) {
    const hasStringValues = [...requestToolIdentityMap.values()].every(
      (v: unknown) => typeof v === "string"
    );
    if (hasStringValues) {
      toolNameMap = requestToolIdentityMap;
    }
  }
  delete translatedBody._toolNameMap;
  delete translatedBody._disableToolPrefix;

  // Update model in body — use resolved alias so the provider gets the correct model ID (#472)
  // Strip provider/alias prefix if it exactly matches the routing prefix so upstream receives the raw model name (#1261)
  let finalModelToUpstream = effectiveModel;
  // Defense-in-depth: only string-strip when effectiveModel is actually a string.
  // The API guards `model` via Zod (z.string()), but internal callers could pass a
  // non-string and a bare `.startsWith` would crash with `startsWith is not a
  // function` (same class as #2359 / #2463). Mirrors 9router's `?.startsWith?.()`.
  if (typeof finalModelToUpstream === "string") {
    if (finalModelToUpstream.startsWith(`${provider}/`)) {
      finalModelToUpstream = finalModelToUpstream.slice(provider.length + 1);
    } else if (alias && finalModelToUpstream.startsWith(`${alias}/`)) {
      finalModelToUpstream = finalModelToUpstream.slice(alias.length + 1);
    }
  }
  translatedBody.model = finalModelToUpstream;

  // #3554: a combo/route may substitute the upstream model AFTER the client chose its
  // `thinking` value. Claude Code sends `thinking:{type:"disabled"}` for internal calls,
  // which claude-fable-5 (adaptive-only) rejects with a 400. Drop the now-invalid value
  // when the resolved target model rejects it; models that accept `disabled` are untouched.
  if (typeof finalModelToUpstream === "string") {
    translatedBody = getModelSpecs().normalizeThinkingForModel(translatedBody, finalModelToUpstream);
    // Claude Opus 4.7+/Fable 5 removed manual extended thinking: `thinking.type:"enabled"`
    // or any `thinking.budget_tokens` is a hard 400. Collapse any manual thinking that
    // reached this point (passthrough legacy shape, reasoning_effort buckets, per-model
    // defaults) to `{type:"adaptive"}` — effort stays on `output_config.effort`. Keyed on
    // the resolved upstream model, so it covers every routing mode. See claudeAdaptiveThinking.ts.
    if (provider === "claude" || provider === "anthropic" || sourceFormat === FORMATS.CLAUDE || targetFormat === FORMATS.CLAUDE) {
    // Claude-specific thinking normalization — skip for non-Claude providers
    translatedBody = getClaudeAdaptiveThinking().normalizeClaudeAdaptiveThinking(translatedBody, finalModelToUpstream);
    // Opus 5 allows disabled thinking only through high effort on Anthropic's direct
    // Messages API. The helper scopes this constraint to `anthropic` and `claude`;
    // GitHub Copilot and Claude Web use separate upstream contracts.
    translatedBody = getClaudeAdaptiveThinking().normalizeClaudeDisabledThinkingEffort(
      translatedBody,
      finalModelToUpstream,
      provider
    );
    // Claude Haiku rejects `thinking.type:"adaptive"` and `output_config.effort`
    // (both Sonnet 4.6 / Opus 4.5+ only). Several paths can still emit those
    // shapes on a Haiku target — native passthrough, reasoning_effort buckets,
    // per-model defaults — so collapse them to a Haiku-valid shape here, after
    // model substitution. Mirrors upstream 9router 401d93bd5. See
    // services/claudeHaikuConstraints.ts.
    translatedBody = getClaudeHaikuConstraints().normalizeClaudeHaikuConstraints(translatedBody, finalModelToUpstream);
    }
    // #6879: per-model default reasoning_effort, injected only when the request
    // carries no reasoning field of any shape — an explicit client/combo-leg value
    // always wins. Scoped to the OpenAI Chat Completions dispatch shape (the shape
    // `reasoning_effort` is native to); unset ModelSpec.defaultReasoningEffort is a
    // no-op. #7694: `modelInfo.resolvedThinkingEffort` — set when the request's model
    // id carried a `<prefix>/<model>-{effort}` synced-model alias suffix
    // (`src/sse/services/model.ts`) — takes priority over the static per-model default.
    // See open-sse/services/defaultReasoningEffort.ts.
    if (targetFormat === FORMATS.OPENAI) {
      translatedBody = getDefaultReasoningEffort().applyDefaultReasoningEffort(
        translatedBody,
        finalModelToUpstream,
        (modelInfo as { resolvedThinkingEffort?: string })?.resolvedThinkingEffort
      );
    }
  }

  // Xiaomi MiMo controls reasoning ONLY via `thinking:{type:"enabled"|"disabled"}` and
  // rejects unknown/extra params with a strict "400 Param Incorrect". Map OmniRoute's
  // OpenAI reasoning signals onto that native shape: reduce any thinking object to
  // `{type}` and drop `reasoning_effort`/`reasoning`. See services/mimoThinking.ts.
  if (provider === "xiaomi-mimo") {
    translatedBody = getMimoThinking().normalizeMimoThinking(translatedBody);
  }

  // opencode-go backed providers (ollama-cloud, opencode-go, opencode,
  // opencode-zen) use a Go ChatCompletionRequest struct where `reasoning`
  // is typed as openai.Reasoning (a structured type). A boolean
  // `reasoning: true/false` — valid per the OpenAI API — causes a 400
  // "json: cannot unmarshal bool into Go struct field" on the Go side.
  // Strip the boolean before forwarding. See opencodeReasoningSanitizer.ts.
  // Thin gateway: opencode reasoning sanitizer only for opencode-go providers.
  if (provider === "opencode" || provider === "opencode-go" || provider === "opencode-zen" || provider === "ollama-cloud") {
    if (getOpencodeReasoningSanitizer().isOpencodeGoProvider(provider)) {
      translatedBody = getOpencodeReasoningSanitizer().stripBooleanReasoning(translatedBody);
    }
  }

  if (targetFormat === FORMATS.OPENAI_RESPONSES || sourceFormat === FORMATS.OPENAI_RESPONSES) {
  const previousResponseIdPolicy = getResponsesStatePolicy().applyResponsesPreviousResponseIdPolicy(translatedBody, {
    mode: settings.responsesPreviousResponseIdMode,
    sourceFormat,
    targetFormat,
    credentials,
  });
  translatedBody = previousResponseIdPolicy.body as typeof translatedBody;
  }

  // #1789: Prevent output_config.effort from overriding effort encoded in model name (Codex)
  if (provider === "codex" || provider?.startsWith("codex")) {
    const hasEffortSuffix = finalModelToUpstream.match(/-(low|medium|high|xhigh)$/i);
    if (
      hasEffortSuffix &&
      translatedBody.output_config &&
      typeof translatedBody.output_config === "object"
    ) {
      const oc = translatedBody.output_config as Record<string, unknown>;
      if (oc.effort) {
        log?.warn?.(
          "PARAMS",
          `Stripped output_config.effort="${oc.effort}" because model "${finalModelToUpstream}" already encodes effort`
        );
        delete oc.effort;
        if (Object.keys(oc).length === 0) {
          delete translatedBody.output_config;
        }
      }
    }
  }

  // Strip unsupported parameters for reasoning models (o1, o3, etc.) and any
  // provider that can't accept them at all (e.g. AI Horde's raw completion
  // backends). When "tools" is among them, also flattens leftover
  // tool_calls/tool-result messages in history (from a combo failover away
  // from a tool-capable model) — those message shapes break non-tool-calling
  // backends just as much as a live `tools` param does.
  const unsupported = getUnsupportedParams(provider, model);

  // Direct/pinned requests (isCombo: false) have no other target to fail
  // over to. Combo requests are already kept off a tool-incapable target by
  // filterTargetsByRequestCompatibility before ever reaching this point, so
  // this only fires for the case that filter can't protect: a client
  // explicitly asking for this exact model. A clear error beats a 200 that
  // silently can't do what was asked (the model narrates a fake tool call
  // instead — live incident: AI Horde/Behemoth-X-123B).
  // Thin gateway: tool-calling-required check only matters when tools are present.
  const toolCallingCheck = (Array.isArray(translatedBody?.tools) && translatedBody.tools.length > 0)
    ? getToolCallingRequiredCheck().checkToolCallingRequiredButUnsupported(
        translatedBody,
        unsupported,
    isCombo,
    model
  )
    : { blocked: false as boolean, reason: "" };
  if (toolCallingCheck.blocked) {
    getUsageDb().trackPendingRequest(model, provider, connectionId, false);
    return createErrorResult(400, toolCallingCheck.message!, null, "tool_calling_not_supported");
  }

  if (unsupported.length > 0) {
    const { strippedParams } = getUnsupportedParamsStrip().stripUnsupportedParams(translatedBody, unsupported);
    if (strippedParams.length > 0) {
      log?.warn?.(
        "PARAMS",
        `Stripped unsupported params for ${model}: ${strippedParams.join(", ")}`
      );
    }
  }

  // GPT-5 reasoning models (openai Chat Completions) reject temperature/top_p with a 400
  // whenever a reasoning effort is active, yet accept them under reasoning_effort=none (the
  // GPT-5.1+ default). A static unsupportedParams list can't express that, so strip sampling
  // conditionally here. The codex Responses path is already covered by the executor allowlist.
  if (provider === "openai" || provider === "azure-openai") {
  translatedBody = getGpt5SamplingGuard().stripGpt5SamplingWhenReasoning(
    translatedBody,
    provider,
    finalModelToUpstream,
    log
  );

  // GPT-5.x reasoning models on the raw openai Chat Completions surface reject function
  // `tools` combined with an active `reasoning_effort`: HTTP 400 "Function tools with
  // reasoning_effort are not supported ... Please use /v1/responses instead." This used to
  // be true for every GPT-5.x model on the plain `openai` provider, but #7242 (targetFormat
  // "openai-responses" on GPT_5_6_API_CAPABILITIES) now routes the GPT-5.6 family to
  // /v1/responses instead, which accepts tools + reasoning natively — so the strip must not
  // fire there. Pass the already-resolved `targetFormat` so the guard gates on the actual
  // upstream surface for this request instead of a model-name list. Port of 9router#2540.
  translatedBody = getGpt5SamplingGuard().stripGpt5ReasoningWhenTools(
    translatedBody,
    provider,
    finalModelToUpstream,
    targetFormat,
    log
  );
  }

  // Rename max_tokens to max_completion_tokens if not supported (#1961)
  if (!getModelCapabilities().supportsMaxTokens({ provider, model })) {
    if (translatedBody.max_tokens !== undefined) {
      if (translatedBody.max_completion_tokens === undefined) {
        translatedBody.max_completion_tokens = translatedBody.max_tokens;
      }
      delete translatedBody.max_tokens;
      log?.debug?.("PARAMS", `Renamed max_tokens to max_completion_tokens for ${model}`);
    }
  } else if (translatedBody.max_completion_tokens !== undefined) {
    // Symmetric case (#6912): some providers/models (e.g. Volcengine Ark /
    // DeepSeek) only document the legacy `max_tokens` field and silently
    // ignore an unrecognized `max_completion_tokens`, so a client sending the
    // newer field alone would have it dropped upstream with no cap applied.
    if (translatedBody.max_tokens === undefined) {
      translatedBody.max_tokens = translatedBody.max_completion_tokens;
    }
    delete translatedBody.max_completion_tokens;
    log?.debug?.("PARAMS", `Renamed max_completion_tokens to max_tokens for ${model}`);
  }

  // stripStore removed (thin gateway).

  // Chat clients may send stream_options.include_usage, but OpenAI Responses
  // upstreams (including Azure AI Foundry /responses) reject stream_options.
  if (targetFormat === FORMATS.OPENAI_RESPONSES && "stream_options" in translatedBody) {
    delete translatedBody.stream_options;
  }

  // Provider-specific max_tokens caps (#711)
  // Some providers reject requests when max_tokens exceeds their API limit.
  // Cap before sending to avoid upstream HTTP 400 errors.
  const providerCap = PROVIDER_MAX_TOKENS[provider];
  if (providerCap) {
    for (const field of ["max_tokens", "max_completion_tokens"] as const) {
      if (typeof translatedBody[field] === "number" && translatedBody[field] > providerCap) {
        log?.debug?.(
          "PARAMS",
          `Capping ${field} from ${translatedBody[field]} to ${providerCap} for ${provider}`
        );
        translatedBody[field] = providerCap;
      }
    }
  }

  // Resolve executor with optional upstream proxy (CLIProxyAPI) routing.
  // mode="native" (default): returns the native executor unchanged.
  // mode="cliproxyapi": returns the CLIProxyAPI executor instead.
  // mode="fallback": returns a wrapper that tries native first, falls back to CLIProxyAPI on 5xx/network errors.

  // #6339: pass the resolved connection's providerSpecificData so a per-connection
  // cliproxyapiMode="claude-native" override can deep-route this single connection
  // through CLIProxyAPI regardless of the provider-level upstream_proxy_config mode.
  const resolveExecutorWithProxy = (prov: string) =>
    resolveExecutorWithProxyFor(
      prov,
      log,
      (credentials?.providerSpecificData as Record<string, unknown> | null | undefined) ?? null
    );

  // === Quota Share enforcement PRE-hook (B/F7) ===
  // Runs after provider/model/credentials/apiKeyInfo are fully resolved,
  // before dispatcher. Fail-open per B16: errors → allow.
  let quotaSoftDeprioritize = false;
  if (apiKeyInfo?.id && credentials?.connectionId) {
    try {
      const { enforceQuotaShare } = await import("@/lib/quota/enforce");
      const decision = await enforceQuotaShare({
        apiKeyId: apiKeyInfo.id,
        connectionId: credentials.connectionId,
        provider: provider ?? "unknown",
        // Resolved model id (post background-redirect / alias) — the same scope the
        // router/log use. Operators configure per-(key,model) caps against THIS id.
        model: model || undefined,
        estimatedCost: {},
      }).catch((err: unknown) => {
        log?.warn?.(
          "QUOTA_SHARE",
          `enforceQuotaShare failed; fail-open: ${err instanceof Error ? err.message : String(err)}`
        );
        return { kind: "allow" as const };
      });

      if (decision.kind === "block") {
        const { buildErrorBody } = await import("../utils/error.ts");
        log?.warn?.(
          "QUOTA_SHARE",
          `[quotaShare] blocked apiKeyId=${apiKeyInfo.id} provider=${provider ?? "unknown"}: ${decision.reason}`
        );
        // Finalize the pending-request slot registered at handler entry — this
        // return path never reaches the upstream, and without the decrement the
        // pending detail lingers as an orphaned status-0 call-log row until the
        // reaper sweeps it (mirrors the other pre-upstream error returns).
        getUsageDb().trackPendingRequest(
          model,
          provider,
          connectionId || credentials?.connectionId || null,
          false
        );
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (decision.retryAfterSeconds) {
          headers["Retry-After"] = String(decision.retryAfterSeconds);
        }
        return new Response(JSON.stringify(buildErrorBody(429, decision.reason)), {
          status: 429,
          headers,
        });
      }

      if (decision.kind === "allow" && decision.deprioritize) {
        quotaSoftDeprioritize = true;
        log?.info?.(
          "QUOTA_SHARE",
          `[quotaShare] soft deprioritize active for apiKeyId=${apiKeyInfo.id} provider=${provider ?? "unknown"}`
        );
      }
    } catch (err) {
      // Outer fail-open guard — should not be reached (inner .catch covers it)
      log?.warn?.(
        "QUOTA_SHARE",
        `[quotaShare] enforceQuotaShare unexpected error; fail-open: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  // G2: Propagate soft penalty to the current candidate so combo scoring can deprioritize.
  if (quotaSoftDeprioritize && isCombo && comboStepId) {
    try {
      const { setCandidateQuotaSoftPenalty } = await import("../services/combo");
      setCandidateQuotaSoftPenalty(comboExecutionKey, comboStepId, true);
    } catch (err) {
      log?.warn?.(
        "QUOTA_SHARE",
        `[quotaShare] could not set soft penalty getEventBus().on candidate: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  // === /Quota Share enforcement PRE-hook ===

  // Get executor for this provider (with optional upstream proxy routing)
  const executor = await resolveExecutorWithProxy(provider);
  const getExecutionCredentials = () =>
    resolveExecutionCredentialsFor({
      credentials,
      nativeCodexPassthrough: nativeResponsesPassthrough,
      endpointPath,
      targetFormat,
      provider,
      ccSessionId,
      modelInfo,
    });

  let onPipelineStreamError: streamFailure.PipelineStreamErrorHandler | null = null;
  let onClientDisconnectFinalize:
    ((event: { reason: string; duration: number }) => boolean) | null = null;

  // Create stream controller for disconnect detection
  const streamController = createStreamController({
    onDisconnect: (event) => {
      let finalized = false;
      try {
        finalized = onClientDisconnectFinalize?.(event) === true;
      } catch {}
      if (!finalized) {
        try {
          getPendingRequestScope().finalizePendingScope(pendingScope, {
            status: 499,
            error: `Client disconnected: ${event.reason}`,
            errorCode: "client_disconnected",
          });
          finalized = true;
        } catch {}
      }
      try {
        onDisconnect?.(event);
      } catch {}
      return finalized;
    },
    onError: (event) => onPipelineStreamError?.(event),
    provider,
    model,
    connectionId,
    clientResponseFormat,
    clientAbortSignal: clientRawRequest?.signal,
  });

  const dedupRequestBody = { ...translatedBody, model: `${provider}/${model}`, stream };
  const dedupEnabled = getRequestDedup().shouldDeduplicate(dedupRequestBody);
  const dedupHash = dedupEnabled ? getRequestDedup().computeRequestHash(dedupRequestBody) : null;

  const executeProviderRequest = async (modelToCall = effectiveModel, allowDedup = false) => {
    const execute = async () => {
      // Upstream body preparation extracted to chatCore/upstreamBody.ts (#3501 — first internal
      // sub-slice of executeProviderRequest); produces the body sent upstream (payload rules +
      // tool-limit truncation + prompt_cache_key injection).
      let bodyToSend = await getUpstreamBody().prepareUpstreamBody({
        translatedBody,
        modelToCall,
        provider,
        targetFormat,
        credentials,
        log,
        bypassDefaultToolLimit: isOpencodeClient,
      });

      getPendingRequestScope().updatePendingScope(pendingScope, {
        providerRequest: bodyToSend,
        stage: "payload_prepared",
      });

      let releaseRawResultAccountSemaphore = () => {};
      try {
        const rawResult = await (async () => {
          let attempts = 0;
          const isModelScopeForRequest = isModelScope();
          const maxAttempts = isModelScopeForRequest ? 3 : provider === "codex" ? 3 : 1;

          // ── Codex 429 account-rotation state ─────────────────────────────────
          // Track excluded connection IDs for codex failover across attempts.
          const codexExcludedIds: string[] = [];
          // Derive session affinity key once for codex failover (used to clear affinity on 429).
          const codexSessionAffinityKey =
            provider === "codex"
              ? (getAuth().extractSessionAffinityKey(body, clientRawRequest?.headers) ?? null)
              : null;

          while (attempts < maxAttempts) {
            trace("pre_executor", { attempt: attempts });
            getPendingRequestScope().updatePendingScope(pendingScope, {
              stage: "sending_to_provider",
            });
            const execCreds = getExecutionCredentials();
            const attemptConnectionId = execCreds?.connectionId || connectionId;
            const accountSemaphoreMaxConcurrency = getExecutorHelpers().resolveAccountSemaphoreMaxConcurrency(execCreds);
            const accountSemaphoreKey = getExecutorHelpers().resolveAccountSemaphoreKey({
              provider,
              model: modelToCall,
              connectionId: attemptConnectionId,
              credentials: execCreds,
            });

            trace("pre_semaphore", {
              semaphoreKey: accountSemaphoreKey,
              max: accountSemaphoreMaxConcurrency,
            });
            if (accountSemaphoreKey) {
              getPendingRequestScope().updatePendingScope(pendingScope, {
                stage: "waiting_account_slot",
              });
            }
            const releaseAccountSemaphore = accountSemaphoreKey
              ? await getAccountSemaphore().acquire(accountSemaphoreKey, {
                  maxConcurrency: accountSemaphoreMaxConcurrency,
                  signal: streamController.signal,
                })
              : () => {};
            trace("post_semaphore");
            getPendingRequestScope().updatePendingScope(pendingScope, {
              stage: "waiting_rate_limit",
            });

            try {
              trace("pre_rate_limit", { connectionId: attemptConnectionId });
              const rawExecutorResult = await getRateLimitManager().withRateLimit(
                provider,
                attemptConnectionId,
                modelToCall,
                async () => {
                  trace("inside_rate_limit", { connectionId: attemptConnectionId });
                  getPendingRequestScope().updatePendingScope(pendingScope, {
                    stage: "rate_limit_slot_acquired",
                  });
                  log?.info?.(
                    "EXECUTOR",
                    `dispatch provider=${provider} model=${modelToCall} conn=${attemptConnectionId ?? "?"} attempt=${attempts + 1}/${maxAttempts}`
                  );
                  return getUpstreamTimeouts().executeWithUpstreamStartTimeout({
                    executor,
                    provider,
                    model: modelToCall,
                    signal: streamController.signal,
                    log,
                    execute: (signal) =>
                      getProviderRequestLogging().runWithCapture(providerRequestCapture, () =>
                        executor.execute({
                          model: modelToCall,
                          body: bodyToSend,
                          stream: upstreamStream,
                          credentials: execCreds,
                          signal,
                          log,
                          extendedContext,
                          upstreamExtraHeaders: getUpstreamExecuteHeaders().buildUpstreamHeadersForExecute(modelToCall),
                          clientHeaders: buildExecutorClientHeaders(
                            clientRawRequest?.headers,
                            userAgent
                          ),
                          clientResponseFormat,
                          onCredentialsRefreshed,
                          skipUpstreamRetry,
                          contextEditing: { enabled: contextEditingEnabled },
                        })
                      ),
                  });
                },
                streamController.signal
              );
              const res = getUpstreamTimeouts().normalizeExecutorResult(rawExecutorResult);
              trace("post_executor", { status: res?.response?.status });
              log?.info?.(
                "EXECUTOR",
                `response provider=${provider} model=${modelToCall} status=${res?.response?.status} conn=${attemptConnectionId ?? "?"}`
              );

              // Track Gemini RPM + RPD request counts for 429 classification
              if (provider === "gemini") {
                getGeminiRateLimitTracker().incrementRequestCount(modelToCall);
              }

              getPendingRequestScope().updatePendingScope(pendingScope, {
                stage: "provider_response_started",
              });

              if (res.response.status === 401 && execCreds?.connectionId) {
                recordKeyHealthStatus(401, execCreds);
              }

              if (isModelScope() && res.response.status === 429 && attempts < maxAttempts - 1) {
                const bodyPeek = await res.response
                  .clone()
                  .text()
                  .catch(() => "");
                const normalizedHeaders = normalizeHeaders(res.response.headers);
                const decision = getModelscopePolicy().classifyModelScope429(bodyPeek, normalizedHeaders);
                if (decision.retryable) {
                  const delay = getModelscopePolicy().getModelScopeRetryDelayMs(normalizedHeaders, attempts);
                  log?.warn?.(
                    "MODELSCOPE_RETRY",
                    `429 ${decision.kind}; retrying in ${delay}ms (model remaining: ${decision.snapshot.modelRemaining ?? "unknown"})`
                  );
                  releaseAccountSemaphore();
                  await new Promise((r) => setTimeout(r, delay));
                  attempts++;
                  continue;
                }
              }

              // Codex 429 account-rotation failover (disabled for context-relay so combo.ts can inject handoff)
              if (
                provider === "codex" &&
                comboStrategy !== "context-relay" &&
                res.response.status === 429 &&
                attempts < maxAttempts - 1
              ) {
                const failedConnectionId =
                  execCreds?.connectionId || credentials?.connectionId || connectionId;
                const normalizedHeaders = normalizeHeaders(res.response.headers);
                const retryAfterHeader = normalizedHeaders["retry-after"] ?? null;
                const retryAfterMs = retryAfterHeader
                  ? Number.parseFloat(retryAfterHeader) * 1000
                  : null;

                log?.warn?.(
                  "CODEX_FAILOVER",
                  `429 getEventBus().on connection ${String(failedConnectionId).slice(0, 8)} (attempt ${attempts + 1}/${maxAttempts}), rotating account`
                );

                // Mark only the current Codex model scope as rate-limited.
                if (failedConnectionId) {
                  // markCodexScopeRateLimited removed (thin gateway); still persist cooldown to DB.
                  try {
                    const { setConnectionRateLimitUntil } = await import("@/lib/db/providers");
                    const untilMs = Date.now() + (retryAfterMs || 60_000);
                    setConnectionRateLimitUntil(String(failedConnectionId), untilMs);
                  } catch {
                    // ignore — best effort
                  }
                  if (!codexExcludedIds.includes(String(failedConnectionId))) {
                    codexExcludedIds.push(String(failedConnectionId));
                  }
                }

                // Clear session affinity so next request won't be pinned to the failing account
                if (codexSessionAffinityKey) {
                  try {
                    getSessionAccountAffinity().deleteSessionAccountAffinity(codexSessionAffinityKey, "codex");
                  } catch {
                    // best-effort
                  }
                }

                // Fetch next available codex connection (excluding all previously failed ones)
                const nextCreds = await getAuth().getProviderCredentials(
                  "codex",
                  null,
                  null,
                  modelToCall || model || requestedModel || null,
                  {
                    excludeConnectionIds: [...codexExcludedIds],
                  }
                ).catch(() => null);

                if (!nextCreds || nextCreds.allRateLimited) {
                  log?.warn?.("CODEX_FAILOVER", "No more codex accounts available — returning 429");
                  if (stream) {
                    releaseAccountSemaphore();
                    return {
                      ...res,
                      _executionCredentials: execCreds,
                    };
                  }
                  return {
                    ...res,
                    _accountSemaphoreRelease: releaseAccountSemaphore,
                    _executionCredentials: execCreds,
                  };
                }

                const newConnectionId = nextCreds.connectionId;
                log?.info?.(
                  "CODEX_FAILOVER",
                  `Rotating codex account: ${String(failedConnectionId).slice(0, 8)} → ${newConnectionId.slice(0, 8)} (attempt ${attempts + 2}/${maxAttempts})`
                );

                getCompliance().logAuditEvent({
                  action: "codex.account_rotation",
                  actor: apiKeyInfo?.name || "system",
                  target: newConnectionId,
                  details: {
                    failed_connection_id: failedConnectionId,
                    new_connection_id: newConnectionId,
                    attempt: attempts + 1,
                    retry_after_ms: retryAfterMs,
                  },
                });

                // Update credentials in-place so getExecutionCredentials() picks up the new account
                Object.assign(credentials, nextCreds);

                releaseAccountSemaphore();
                attempts++;
                continue;
              }

              // For streaming: release the semaphore when the client drains or cancels the stream.
              if (stream) {
                const originalBody = res.response.body;
                if (!originalBody) {
                  releaseAccountSemaphore();
                  return res;
                }

                // Opt-in transparent stream recovery (free-claude-code port, default OFF).
                // Only engages for a successful (2xx) stream — an error body must never be
                // held or replayed. Setting is read once here from the cached resolved
                // resilience settings; the default path is byte-for-byte unchanged.
                const okStatus = res.response.status >= 200 && res.response.status < 300;
                let streamRecoveryEnabled = false;
                let continueMidStreamEnabled = false;
                if (okStatus) {
                  try {
                    // Reuse the request-consolidated settings read (see line ~2076) — no
                    // second DB/cache hit. Default OFF when the setting is absent.
                    const sr = getResilienceSettings().resolveResilienceSettings(settings).streamRecovery;
                    // Fail-closed: the agent-goal-policy heuristic may only ADD recovery
                    // when the operator has no explicit configuration. If the operator
                    // explicitly configured stream recovery (env var or DB/settings
                    // override), that value always wins — the goal policy must never
                    // re-enable recovery the operator explicitly turned off.
                    const operatorExplicit = getResilienceSettings().isStreamRecoveryExplicitlyConfigured(settings);
                    const goalOverride = !operatorExplicit && agentGoalPolicy.streamRecoveryEnabled;
                    streamRecoveryEnabled = sr.enabled || goalOverride;
                    continueMidStreamEnabled = sr.continueMidStream === true;
                    if (goalOverride && !sr.enabled) {
                      log?.info?.(
                        "AGENT_GOAL",
                        `agentGoalPolicy override: stream recovery enabled for goal request requestId=${traceId} model=${modelToCall || model || requestedModel || "unknown"}`
                      );
                    }
                  } catch {
                    streamRecoveryEnabled = false;
                    continueMidStreamEnabled = false;
                  }
                }

                let clientBody: ReadableStream<Uint8Array>;
                if (streamRecoveryEnabled) {
                  // Run the SAME upstream (same account/creds) with a given body and return
                  // its 2xx stream, or null. Used both by the early-retry re-open (same body)
                  // and the mid-stream continuation (assistant-prefilled body).
                  const runUpstreamStream = async (
                    body: unknown
                  ): Promise<ReadableStream<Uint8Array> | null> => {
                    try {
                      const retryRaw = await getUpstreamTimeouts().executeWithUpstreamStartTimeout({
                        executor,
                        provider,
                        model: modelToCall,
                        signal: streamController.signal,
                        log,
                        execute: (signal) =>
                          getProviderRequestLogging().runWithCapture(providerRequestCapture, () =>
                            executor.execute({
                              model: modelToCall,
                              body,
                              stream: upstreamStream,
                              credentials: execCreds,
                              signal,
                              log,
                              extendedContext,
                              upstreamExtraHeaders: getUpstreamExecuteHeaders().buildUpstreamHeadersForExecute(modelToCall),
                              clientHeaders: buildExecutorClientHeaders(
                                clientRawRequest?.headers,
                                userAgent
                              ),
                              clientResponseFormat,
                              onCredentialsRefreshed,
                              skipUpstreamRetry,
                              contextEditing: { enabled: contextEditingEnabled },
                            })
                          ),
                      });
                      const retryRes = getUpstreamTimeouts().normalizeExecutorResult(retryRaw);
                      const retryOk =
                        retryRes.response.status >= 200 && retryRes.response.status < 300;
                      if (retryOk && retryRes.response.body) {
                        return retryRes.response.body as ReadableStream<Uint8Array>;
                      }
                      await retryRes.response.body?.cancel().catch(() => {});
                      return null;
                    } catch {
                      return null;
                    }
                  };

                  // Mid-stream continuation (Fase 4.4): re-request with the partial text as an
                  // assistant prefill. Gated by its own setting and only for OpenAI-compatible
                  // bodies (makeContinuationBody returns null otherwise).
                  const continueStream = continueMidStreamEnabled
                    ? (assistantSoFar: string) => {
                        const continuationBody = getStreamRecovery().makeContinuationBody(
                          bodyToSend as Record<string, unknown>,
                          assistantSoFar
                        );
                        return continuationBody
                          ? runUpstreamStream(continuationBody)
                          : Promise.resolve(null);
                      }
                    : undefined;

                  clientBody = getStreamRecovery().createRecoverableStream(
                    originalBody as ReadableStream<Uint8Array>,
                    () => runUpstreamStream(bodyToSend),
                    {
                      finalize: releaseAccountSemaphore,
                      onRetry: (attempt, err) =>
                        log?.warn?.(
                          "STREAM_RECOVERY",
                          `transparent early-retry ${attempt}/${STREAM_RECOVERY.EARLY_RETRY_MAX} after ${
                            (err as { name?: string })?.name || "truncation"
                          }`
                        ),
                      continueStream,
                      onContinue: (attempt) =>
                        log?.warn?.(
                          "STREAM_RECOVERY",
                          `mid-stream continuation attempt ${attempt}/${STREAM_RECOVERY.EARLY_RETRY_MAX}`
                        ),
                    }
                  );
                } else {
                  clientBody = getStreamFinalize().wrapReadableStreamWithFinalize(
                    originalBody,
                    releaseAccountSemaphore
                  );
                }

                return {
                  ...res,
                  _executionCredentials: execCreds,
                  response: new Response(clientBody, {
                    status: res.response.status,
                    statusText: res.response.statusText,
                    headers: new Headers(normalizeHeaders(res.response.headers)),
                  }),
                };
              }

              return {
                ...res,
                _executionCredentials: execCreds,
                _accountSemaphoreRelease: releaseAccountSemaphore,
              };
            } catch (error) {
              releaseAccountSemaphore();
              throw error;
            }
          }
        })();

        if (stream) {
          return rawResult;
        }

        // Non-stream: release semaphore immediately after reading full response body.
        const status = rawResult.response.status;

        // Use execution credentials captured during request processing
        if (
          rawResult._executionCredentials?.connectionId &&
          rawResult._executionCredentials?.apiKey
        ) {
          recordKeyHealthStatus(status, rawResult._executionCredentials, rawResult.transport);
        }
        releaseRawResultAccountSemaphore =
          typeof rawResult._accountSemaphoreRelease === "function"
            ? rawResult._accountSemaphoreRelease
            : () => {};

        const statusText = rawResult.response.statusText;
        const headersObj = normalizeHeaders(rawResult.response.headers);
        const responseHeaders = new Headers(headersObj);
        stripStaleForwardingHeaders(responseHeaders);
        stripNextMiddlewareControlHeaders(responseHeaders);
        const contentType = (responseHeaders.get("content-type") || "").toLowerCase();
        const payload = await getNonStreamingResponseBody().readNonStreamingResponseBody(
          rawResult.response,
          contentType,
          upstreamStream
        );
        releaseRawResultAccountSemaphore();
        releaseRawResultAccountSemaphore = () => {};

        return {
          ...rawResult,
          response: new Response(payload, { status, statusText, headers: responseHeaders }),
          _dedupSnapshot: {
            status,
            statusText,
            headers: (() => {
              const arr: [string, string][] = [];
              responseHeaders.forEach((v, k) => arr.push([k, v]));
              return arr;
            })(),
            payload,
          },
        };
      } catch (error) {
        releaseRawResultAccountSemaphore();
        throw error;
      }
    };

    if (allowDedup && dedupEnabled && dedupHash) {
      const dedupResult = await getRequestDedup().deduplicate(dedupHash, execute);
      if (dedupResult.wasDeduplicated) {
        log?.debug?.("DEDUP", `Joined in-flight request hash=${dedupHash}`);
      }
      return materializeDeduplicatedExecutionResult(dedupResult.result);
    }

    return execute();
  };

  const registeredProviderRequest =
    translatedBody && typeof translatedBody === "object" && !Array.isArray(translatedBody)
      ? {
          ...(translatedBody as Record<string, unknown>),
          model:
            typeof (translatedBody as Record<string, unknown>).model === "string"
              ? (translatedBody as Record<string, unknown>).model
              : effectiveModel,
          ...(!Array.isArray((translatedBody as Record<string, unknown>).messages) &&
          Array.isArray((body as Record<string, unknown>).messages)
            ? { messages: (body as Record<string, unknown>).messages }
            : {}),
        }
      : translatedBody;

  getPendingRequestScope().updatePendingScope(pendingScope, {
    providerRequest: registeredProviderRequest,
  });
  // T5: track which models we've tried for intra-family fallback
  const triedModels = new Set<string>([effectiveModel]);
  let currentModel = effectiveModel;

  // Log start
  getUsageDb().appendRequestLog({ model, provider, connectionId, status: "PENDING" }).catch(() => {});

  const msgCount =
    translatedBody.messages?.length ||
    translatedBody.contents?.length ||
    translatedBody.request?.contents?.length ||
    (translatedBody.conversationState?.history?.length ?? 0) +
      (translatedBody.conversationState?.currentMessage ? 1 : 0) ||
    0;
  log?.debug?.("REQUEST", `${provider?.toUpperCase()} | ${model} | ${msgCount} msgs`);

  // ── Tier 2: Authoritative per-model/provider token-limit check (provider now resolved) ──
  if (apiKeyInfo?.id) {
    try {
      const tokenBreach = getTokenLimitCounter().checkTokenLimits(
        apiKeyInfo.id,
        provider || undefined,
        model || undefined
      );
      if (tokenBreach) {
        const scopeLabel =
          tokenBreach.scopeType === "global"
            ? "account"
            : `${tokenBreach.scopeType} "${tokenBreach.scopeValue}"`;
        // FIX 6: clear the pending request marker before the early return so we do
        // not leak a phantom pending request (start was tracked at line ~1847).
        getUsageDb().trackPendingRequest(model, provider, connectionId, false);
        // FIX 5: tag this as a per-API-key token-limit breach (errorCode
        // TOKEN_LIMIT_EXCEEDED) so the combo loop can distinguish it from an
        // upstream 429 and NOT cool shared accounts / retry it transiently.
        return createErrorResult(
          HTTP_STATUS.RATE_LIMITED,
          `Token limit exceeded for ${scopeLabel}: ${tokenBreach.tokensUsed}/${tokenBreach.limitValue} tokens used in the current window. Please try again later.`,
          null,
          "TOKEN_LIMIT_EXCEEDED"
        );
      }
    } catch (err) {
      // Fail-open at Tier 2: Tier 1 already enforced the model/global limit pre-dispatch.
      // A transient counter read error here must not break an otherwise-valid request.
      log?.warn?.("TOKEN_LIMIT", "Tier 2 token-limit check failed; allowing request", { err });
    }
  }

  // ── Gemini pre-dispatch TPM / RPM guard ──────────────────────────────────
  // Avoids guaranteed upstream 429 by checking local sliding-window counters
  // before dispatch. Fail-open: counter errors → allow through.
  if (provider === "gemini") {
    try {
      if (getGeminiRateLimitTracker().isTpmExhausted(effectiveModel)) {
        getUsageDb().trackPendingRequest(model, provider, connectionId, false);
        return createErrorResult(
          HTTP_STATUS.RATE_LIMITED,
          `Gemini TPM rate limit reached for ${effectiveModel}. Please try again later.`,
          null,
          "GEMINI_TPM_EXHAUSTED"
        );
      }
    } catch (err) {
      log?.warn?.("GEMINI_RATE_LIMIT", "Pre-dispatch TPM check failed; allowing request", { err });
    }
  }

  // Execute request using executor (handles URL building, headers, fallback, transform)
  let providerResponse;
  let providerUrl;
  let providerHeaders;
  let finalBody;
  let claudePromptCacheLogMeta = null;

  try {
    const result = await executeProviderRequest(effectiveModel, true);

    providerResponse = result.response;
    providerUrl = result.url;
    providerHeaders = result.headers;
    finalBody = providerRequestCapture.body(result.transformedBody);
    const responseConnectionId = getCurrentConnectionId();
    effectiveServiceTier = resolveEffectiveServiceTier(finalBody);
    claudePromptCacheLogMeta = getExecutorHelpers().buildClaudePromptCacheLogMeta(
      targetFormat,
      finalBody,
      providerHeaders,
      clientRawRequest?.headers
    );

    // Log target request (final request to provider)
    reqLogger.logTargetRequest(providerUrl, providerHeaders, finalBody);
    getPendingRequestScope().updatePendingScope(pendingScope, {
      providerRequest: finalBody,
      providerUrl,
      stage: "provider_response_started",
    });
    // Update rate limiter from response headers (learn limits dynamically)
    getRateLimitManager().updateFromHeaders(
      provider,
      responseConnectionId,
      providerResponse.headers,
      providerResponse.status,
      model
    );

    // Store rate-limit headers for quota saturation signals
    try {
      const { storeRateLimitHeaders } = await import("@/lib/quota/saturationSignals");
      storeRateLimitHeaders(
        responseConnectionId,
        provider,
        providerResponse.headers as Record<string, string>
      );
    } catch {
      // fail-open: saturation signal is best-effort
    }
  } catch (error) {
    getUsageDb().trackPendingRequest(model, provider, connectionId, false);
    if (getStreamErrorResult().isSemaphoreCapacityError(error)) {
      getUsageDb().appendRequestLog({
        model,
        provider,
        connectionId,
        status: `FAILED ${error.code}`,
      }).catch(() => {});
      const failureMessage = error.message || "Semaphore timeout";
      persistAttemptLogs({
        status: HTTP_STATUS.RATE_LIMITED,
        error: failureMessage,
        providerRequest: finalBody || translatedBody,
        clientResponse: buildErrorBody(HTTP_STATUS.RATE_LIMITED, failureMessage),
        claudeCacheMeta: claudePromptCacheLogMeta,
        cacheSource: "upstream",
      });
      persistFailureUsage(HTTP_STATUS.RATE_LIMITED, error.code);
      const result = stream
        ? getStreamErrorResult().createStreamingErrorResult(HTTP_STATUS.RATE_LIMITED, failureMessage, error.code)
        : createErrorResult(HTTP_STATUS.RATE_LIMITED, failureMessage);
      return {
        ...result,
        errorType: "account_semaphore_capacity",
        errorCode: error.code,
      };
    }
    // abort(reason) can reject the upstream fetch with a raw string reason
    // (e.g. "request_signal_aborted") that has no `name`/`status`; classify
    // via isLocalStreamLifecycleError so those map to 499 instead of falling
    // through to the 502 provider-failure default.
    const isRequestAborted = getCircuitBreaker().isLocalStreamLifecycleError(error);
    // #8376: an unreachable upstream proxy (ECONNREFUSED/ECONNRESET/...) is tagged by
    // proxyFetch.ts (tagProxyUnreachable) with `.errorCode = "proxy_unreachable"` before
    // it reaches this catch. Classify it explicitly to 502 instead of falling through
    // the generic `error.status` branch (a raw connect-refused error has no `.status` at
    // all, so it used to collapse into an ordinary 502/504 the provider-breaker predicate
    // can't tell apart from a per-model 5xx).
    const isProxyUnreachableFailure =
      !isRequestAborted && (error as { errorCode?: unknown })?.errorCode === "proxy_unreachable";
    const errorCode = getStreamErrorResult().getUpstreamErrorIdentifier(error);
    const isLocalQueueTimeout = errorCode === "RATE_LIMIT_QUEUE_TIMEOUT";
    const failureStatus = isRequestAborted
      ? 499
      : isProxyUnreachableFailure
        ? HTTP_STATUS.BAD_GATEWAY
        : isLocalQueueTimeout
          ? HTTP_STATUS.SERVICE_UNAVAILABLE
          : error.name === "TimeoutError" || error.name === "BodyTimeoutError"
            ? HTTP_STATUS.GATEWAY_TIMEOUT
            : error.status && typeof error.status === "number"
              ? error.status
              : HTTP_STATUS.BAD_GATEWAY;
    const failureMessage = isRequestAborted
      ? "Request aborted"
      : formatProviderError(error, provider, model, failureStatus);
    const upstreamErrorCode = isProxyUnreachableFailure ? "proxy_unreachable" : errorCode;
    // Tag our own deadline timeouts (fetch-start TimeoutError / body BodyTimeoutError,
    // both surfaced as a 504) as "upstream_timeout" so the cooldown layer can tell a
    // slow-but-not-failed request apart from a real provider 5xx. (Antigravity already
    // tags its pre-response timeout via the code below.)
    const isOwnDeadlineTimeout =
      failureStatus === HTTP_STATUS.GATEWAY_TIMEOUT &&
      (error.name === "TimeoutError" || error.name === "BodyTimeoutError");
    const upstreamErrorType =
      upstreamErrorCode === ANTIGRAVITY_PRE_RESPONSE_TIMEOUT_CODE || isOwnDeadlineTimeout
        ? "upstream_timeout"
        : failureStatus === 401
          ? "authentication_error"
          : undefined;
    getUsageDb().appendRequestLog({
      model,
      provider,
      connectionId,
      status: `FAILED ${failureStatus}`,
    }).catch(() => {});
    persistAttemptLogs({
      status: failureStatus,
      error: failureMessage,
      providerRequest: finalBody || translatedBody,
      // On a client-abort (AbortError), the client already disconnected before
      // we ever got here — this body is what we WOULD have sent, not what was
      // actually delivered. Logging it as `clientResponse` is misleading (the
      // dashboard reads that field as "what the client received"), so omit it
      // for this case; `error` above already records the failure reason.
      clientResponse:
        error.name === "AbortError" ? undefined : buildErrorBody(failureStatus, failureMessage),
      claudeCacheMeta: claudePromptCacheLogMeta,
      cacheSource: "upstream",
    });
    if (isRequestAborted) {
      streamController.handleError(error);
      return createErrorResult(499, "Request aborted");
    }
    persistFailureUsage(
      failureStatus,
      upstreamErrorCode || (error instanceof Error && error.name ? error.name : "upstream_error")
    );
    console.log(`${getStream().COLORS.red}[ERROR] ${failureMessage}${getStream().COLORS.reset}`);
    if (stream && upstreamErrorCode) {
      const result = getStreamErrorResult().createStreamingErrorResult(
        failureStatus,
        failureMessage,
        upstreamErrorCode,
        upstreamErrorType
      );
      return {
        ...result,
        errorType: upstreamErrorType,
        errorCode: upstreamErrorCode,
      };
    }
    return createErrorResult(
      failureStatus,
      failureMessage,
      null,
      upstreamErrorCode,
      upstreamErrorType
    );
  }
  let upstreamErrorParsed = false;
  let parsedStatusCode = providerResponse.status;
  let parsedMessage = "";
  let parsedRetryAfterMs: number | null = null;
  let upstreamErrorBody: unknown = null;

  // Track whether stream_options was present and stripped — if so, 401/403 after
  // that may be from the modification rather than a genuine auth failure, so we
  // skip the credential refresh attempt in that case.
  const hadStreamOptions =
    targetFormat === FORMATS.OPENAI_RESPONSES && "stream_options" in translatedBody;
  if (hadStreamOptions) {
    delete translatedBody.stream_options;
  }

  // Handle 401/403 - try token refresh using executor
  if (
    (providerResponse.status === HTTP_STATUS.UNAUTHORIZED ||
      providerResponse.status === HTTP_STATUS.FORBIDDEN) &&
    !hadStreamOptions // Skip refresh if failure may be from stream_options removal, not auth
  ) {
    // Fix A: wrap refreshCredentials in runWithOnPersist so the persist callback
    // executes INSIDE the per-connection mutex held by getAccessToken. This makes
    // [network refresh + DB write + outer-state mutation] one atomic step and
    // prevents concurrent requests from reading a stale refreshToken before the
    // DB has been updated (refresh_token_reused on Codex/OpenAI).
    //
    // Not every executor routes refresh through getAccessToken (e.g. github.ts
    // calls refreshCopilotToken directly). When the persistFn doesn't fire from
    // inside getAccessToken, we still need to do the credentials mutation + user
    // callback after refreshCredentials returns. The `persistFnRan` flag tracks
    // which path executed so we don't double-fire (race-prone) or skip (regression).
    // Front 3: remember the refresh_token we are about to present so that, if the
    // refresh fails as unrecoverable, we can tell a genuine death apart from a
    // stale-token reuse that a concurrent/sibling refresh already rotated past.
    const attemptedRefreshToken =
      typeof credentials?.refreshToken === "string" ? credentials.refreshToken : null;
    let persistFnRan = false;
    const persistFn = onCredentialsRefreshed
      ? async (refreshResult: Record<string, unknown>) => {
          persistFnRan = true;
          // Mutate the shared credentials object so subsequent executor calls
          // in this request see the new tokens. Runs INSIDE the mutex.
          Object.assign(credentials, refreshResult);
          await onCredentialsRefreshed(refreshResult);
        }
      : undefined;

    // #4038: build a compare-and-swap reread so getAccessToken can skip the persist if a
    // concurrent writer (sibling request / HealthCheck / replica) already rotated this
    // connection's refresh_token past the one we presented — overwriting would revert it
    // and revoke the token family. No connectionId ⇒ no guard (behavior unchanged).
    const casConnectionId =
      typeof credentials?.connectionId === "string" ? credentials.connectionId.trim() : "";
    const casReread = casConnectionId
      ? async () => {
          const latest = await getDbProviders().getProviderConnectionById(casConnectionId);
          return typeof latest?.refreshToken === "string" ? latest.refreshToken : null;
        }
      : null;

    const newCredentials = (await getTokenRefresh().refreshWithRetry(
      () =>
        getTokenRefresh().runWithCasGuard(
          casReread ? { expectedRefreshToken: attemptedRefreshToken, reread: casReread } : null,
          () => getTokenRefresh().runWithOnPersist(persistFn, () => executor.refreshCredentials(credentials, log))
        ),
      3,
      log,
      provider // Explicitly pass the provider to avoid universally tripping the "unknown" circuit breaker
    )) as null | {
      accessToken?: string;
      copilotToken?: string;
    };

    if (newCredentials?.accessToken || newCredentials?.copilotToken) {
      log?.info?.("TOKEN", `${provider?.toUpperCase()} | refreshed`);

      // Fall back to post-mutex mutation only for executors that don't route
      // through getAccessToken (and therefore never fire onPersist). For
      // executors that DO route through it (Codex, Claude, Gemini, etc.) the
      // mutation already happened atomically inside the mutex.
      if (!persistFnRan) {
        Object.assign(credentials, newCredentials);
        if (onCredentialsRefreshed) {
          await onCredentialsRefreshed(newCredentials);
        }
      }

      // Retry with new credentials — model + extra headers follow translatedBody.model so they
      // stay aligned if this block ever runs after a path that mutates body.model (e.g. fallback).
      try {
        const retryModelId = String(translatedBody.model || effectiveModel);
        const retryResult = await getProviderRequestLogging().runWithCapture(providerRequestCapture, () =>
          executor.execute({
            model: retryModelId,
            body: translatedBody,
            stream: upstreamStream,
            credentials: getExecutionCredentials(),
            signal: streamController.signal,
            log,
            extendedContext,
            upstreamExtraHeaders: getUpstreamExecuteHeaders().buildUpstreamHeadersForExecute(retryModelId),
            clientHeaders: buildExecutorClientHeaders(clientRawRequest?.headers, userAgent),
            clientResponseFormat,
            onCredentialsRefreshed,
            skipUpstreamRetry: isCombo,
            contextEditing: { enabled: contextEditingEnabled },
          })
        );

        if (retryResult.response.ok) {
          providerResponse = retryResult.response;
          providerUrl = retryResult.url;
          providerHeaders = new Headers(retryResult.headers || {});
          finalBody = providerRequestCapture.body(retryResult.transformedBody);
          reqLogger.logTargetRequest(providerUrl, providerHeaders, finalBody);
          getPendingRequestScope().updatePendingScope(pendingScope, {
            providerRequest: finalBody,
            providerUrl,
            stage: "provider_response_started",
          });
          upstreamErrorParsed = false; // Reset since new response is OK
        } else {
          providerResponse = retryResult.response;
          upstreamErrorParsed = false; // Let it be parsed downstream
        }
      } catch (retryErr) {
        // Refresh succeeded but the retry leg failed (network blip, AbortError,
        // executor throw). Don't swallow — the operator-visible signal "the user
        // saw 401 even though auth was actually fixed" is much more confusing
        // than the original 401 alone. Surface at error level with sanitization.
        log?.error?.(
          "TOKEN",
          `${provider?.toUpperCase()} | retry after refresh failed: ${sanitizeErrorMessage(retryErr)}`
        );
      }
    } else {
      log?.warn?.("TOKEN", `${provider?.toUpperCase()} | refresh failed`);
      if (getTokenRefresh().isUnrecoverableRefreshError(newCredentials) && onCredentialsRefreshed) {
        // Front 3 (reuse-race tolerance): before deactivating, re-read the DB.
        // If a sibling/concurrent refresh already rotated this connection's
        // refresh_token (common for Codex/OpenAI under one shared Auth0 client),
        // the failure we saw was a stale-token reuse — the account is healthy
        // with the newer token, so keep it active instead of killing it.
        let alreadyRotated = false;
        if (typeof connectionId === "string" && connectionId && attemptedRefreshToken) {
          try {
            const latest = await getDbProviders().getProviderConnectionById(connectionId);
            if (getRefreshSerializer().wasRefreshTokenRotated(attemptedRefreshToken, latest?.refreshToken)) {
              alreadyRotated = true;
              log?.warn?.(
                "TOKEN",
                `${provider.toUpperCase()} | refresh_token already rotated by a concurrent refresh — keeping connection active`
              );
            }
          } catch {
            // DB read failed — fall through to the safe default (deactivate).
          }
        }
        if (!alreadyRotated) {
          await onCredentialsRefreshed({ testStatus: "expired", isActive: false });
        }
      }
    }
  }

  await persistCodexQuotaState(normalizeHeaders(providerResponse.headers), providerResponse.status);

  // Check provider response - return error info for fallback handling
  providerFailure: if (!providerResponse.ok) {
    getUsageDb().trackPendingRequest(model, provider, connectionId, false);

    let statusCode = providerResponse.status;
    let message = "";
    let retryAfterMs: number | null = null;
    let upstreamErrorCode: string | undefined;
    let upstreamErrorType: string | undefined;

    if (upstreamErrorParsed) {
      statusCode = parsedStatusCode;
      message = parsedMessage;
      retryAfterMs = parsedRetryAfterMs;
    } else {
      const details = await parseUpstreamError(providerResponse, provider);
      statusCode = details.statusCode;
      message = details.message;
      retryAfterMs = details.retryAfterMs;
      upstreamErrorBody = details.responseBody;
      upstreamErrorCode = details.errorCode as string | undefined;
      upstreamErrorType = details.errorType as string | undefined;
    }

    // Thinking signature recovery removed (thin gateway).

    // T06/T10/T36: classify provider errors and persist terminal account states.
    let errorType = getErrorClassifier().classifyProviderError(statusCode, message, provider);
    if (statusCode === 429 && isModelScope()) {
      const decision = getModelscopePolicy().classifyModelScope429(message, normalizeHeaders(providerResponse.headers));
      errorType =
        decision.kind === "quota_exhausted"
          ? getErrorClassifier().PROVIDER_ERROR_TYPES.QUOTA_EXHAUSTED
          : getErrorClassifier().PROVIDER_ERROR_TYPES.RATE_LIMITED;
      log?.warn?.(
        "MODELSCOPE_429",
        `${decision.kind} (model remaining: ${decision.snapshot.modelRemaining ?? "unknown"}, total remaining: ${decision.snapshot.totalRemaining ?? "unknown"})`
      );
    }
    const errorConnectionId = getCurrentConnectionId();
    if (errorConnectionId && errorType) {
      try {
        if (errorType === getErrorClassifier().PROVIDER_ERROR_TYPES.FORBIDDEN) {
          await getDbProviders().updateProviderConnection(errorConnectionId, {
            isActive: false,
            testStatus: "banned",
            lastErrorType: errorType,
            lastError: message,
            errorCode: statusCode,
          });
          console.warn(
            `[provider] Node ${errorConnectionId} banned (${statusCode}) — disabling permanently`
          );
        } else if (errorType === getErrorClassifier().PROVIDER_ERROR_TYPES.ACCOUNT_DEACTIVATED) {
          // Plan A: if connection has extra API keys, don't disable — only the failing key is affected.
          // Single-key connections still get disabled as before.
          if (
            getApiKeyRotator().connectionHasExtraKeys(
              errorConnectionId,
              (credentials?.providerSpecificData as Record<string, unknown> | undefined)
                ?.extraApiKeys as string[] | undefined
            )
          ) {
            await getDbProviders().updateProviderConnection(errorConnectionId, {
              lastErrorType: errorType,
              lastError: message,
              errorCode: statusCode,
            });
            console.warn(
              `[provider] Node ${errorConnectionId} account deactivated (${statusCode}) — has extra keys, keeping connection active`
            );
          } else {
            await getDbProviders().updateProviderConnection(errorConnectionId, {
              isActive: false,
              testStatus: "deactivated",
              lastErrorType: errorType,
              lastError: message,
              errorCode: statusCode,
            });
            console.warn(
              `[provider] Node ${errorConnectionId} account deactivated (${statusCode}) — disabling permanently`
            );
          }
        } else if (errorType === getErrorClassifier().PROVIDER_ERROR_TYPES.QUOTA_EXHAUSTED) {
          // Providers with per-model quotas — lock the model only, not the connection
          const quotaCooldownMs = retryAfterMs || COOLDOWN_MS.rateLimit;
          const accountSemaphoreKey = getExecutorHelpers().resolveAccountSemaphoreKey({
            provider,
            model: currentModel,
            connectionId: errorConnectionId,
            credentials,
          });
          if (accountSemaphoreKey) {
            getAccountSemaphore().markBlocked(accountSemaphoreKey, quotaCooldownMs);
          }
          if (isModelScope() && errorConnectionId) {
            const lockFn = provider === "antigravity" ? getAccountFallback().lockExactModel : getAccountFallback().lockModel;
            lockFn(provider, errorConnectionId, model, "quota_exhausted", quotaCooldownMs);
            console.warn(
              `[provider] Node ${errorConnectionId} ModelScope model quota exhausted (${statusCode}) for ${model} - ${Math.ceil(quotaCooldownMs / 1000)}s (connection stays active)`
            );
          } else if (
            getAccountFallback().lockModelIfPerModelQuota(
              provider,
              errorConnectionId,
              model,
              "quota_exhausted",
              quotaCooldownMs
            )
          ) {
            const quotaScope = getAntigravityQuotaFamily().getQuotaScopeLabelForProvider(provider, model);
            console.warn(
              `[provider] Node ${errorConnectionId} ${quotaScope}-only quota exhausted (${statusCode}) for ${model} - ${Math.ceil(quotaCooldownMs / 1000)}s (cooldown_scope=${quotaScope}, ttl_source=${retryAfterMs ? "upstream" : "inferred"}, connection stays active)`
            );
          } else {
            await getDbProviders().updateProviderConnection(errorConnectionId, {
              testStatus: "credits_exhausted",
              lastErrorType: errorType,
              lastError: message,
              errorCode: statusCode,
            });
            console.warn(`[provider] Node ${errorConnectionId} exhausted quota (${statusCode})`);
          }
        } else if (errorType === getErrorClassifier().PROVIDER_ERROR_TYPES.UNAUTHORIZED) {
          // Normal 401 (token/session auth issue): keep account active for refresh/re-auth.
          await getDbProviders().updateProviderConnection(errorConnectionId, {
            lastErrorType: errorType,
            lastError: message,
            errorCode: statusCode,
          });
        } else if (errorType === getErrorClassifier().PROVIDER_ERROR_TYPES.OAUTH_INVALID_TOKEN) {
          // OAuth 401 with invalid credentials - token refresh can recover
          await getDbProviders().updateProviderConnection(errorConnectionId, {
            lastErrorType: errorType,
            lastError: message,
            errorCode: statusCode,
          });
          console.warn(
            `[provider] Node ${errorConnectionId} OAuth token invalid (${statusCode}) — token refresh available`
          );
        } else if (errorType === getErrorClassifier().PROVIDER_ERROR_TYPES.PROJECT_ROUTE_ERROR) {
          // Cloud Code 403 with stale project: not a ban, keep account active.
          await getDbProviders().updateProviderConnection(errorConnectionId, {
            lastErrorType: errorType,
            lastError: message,
            errorCode: statusCode,
          });
          console.warn(
            `[provider] Node ${errorConnectionId} project routing error (${statusCode}) — not banning`
          );
        } else if (errorType === getErrorClassifier().PROVIDER_ERROR_TYPES.MODEL_NOT_FOUND) {
          // 404 — model/endpoint does not exist upstream. Lock the model so the
          // retry/backoff loop stops hammering the dead endpoint (which would
          // otherwise degenerate into a 429 rate-limit storm). Connection stays
          // active since only the specific model is unavailable. (#6827)
          const notFoundCooldownMs = COOLDOWN_MS.notFound;
          getAccountFallback().lockModel(
            provider,
            errorConnectionId,
            currentModel,
            "model_not_found",
            notFoundCooldownMs
          );
          console.warn(
            `[provider] Node ${errorConnectionId} model not found (${statusCode}) for ${currentModel} - locking model for ${Math.ceil(notFoundCooldownMs / 1000)}s (connection stays active)`
          );
        }
      } catch {
        // Best-effort state update; request flow should continue with fallback handling.
      }
    }

    getUsageDb().appendRequestLog({
      model,
      provider,
      connectionId: errorConnectionId,
      status: `FAILED ${statusCode}`,
    }).catch(() => {});

    const errMsg = formatProviderError(new Error(message), provider, model, statusCode);
    console.log(`${getStream().COLORS.red}[ERROR] ${errMsg}${getStream().COLORS.reset}`);

    // Log Antigravity retry time if available
    if (retryAfterMs && provider === "antigravity") {
      const retrySeconds = Math.ceil(retryAfterMs / 1000);
      log?.debug?.("RETRY", `Antigravity quota getAccountSemaphore().reset in ${retrySeconds}s (${retryAfterMs}ms)`);
    }

    // Log error with full request body for debugging
    reqLogger.logError(new Error(message), finalBody || translatedBody);
    reqLogger.logProviderResponse(
      providerResponse.status,
      providerResponse.statusText,
      providerResponse.headers,
      upstreamErrorBody
    );

    // Update rate limiter from error response headers
    getRateLimitManager().updateFromHeaders(provider, errorConnectionId, providerResponse.headers, statusCode, model);
    if (errorConnectionId && upstreamErrorBody !== null && upstreamErrorBody !== undefined) {
      getRateLimitManager().updateFromResponseBody(provider, errorConnectionId, upstreamErrorBody, statusCode, model);
    }

    // ── T5: Intra-family model fallback ──────────────────────────────────────
    // Before returning a model-unavailable error upstream, try sibling models
    // from the same family. This keeps the request alive on the same account
    // instead of failing the entire combo.
    if (getModelFamilyFallback().isModelUnavailableError(statusCode, message)) {
      const nextModel = getModelFamilyFallback().getNextFamilyFallback(currentModel, triedModels);
      if (nextModel) {
        triedModels.add(nextModel);
        currentModel = nextModel;
        translatedBody.model = nextModel;
        log?.info?.("MODEL_FALLBACK", `${model} unavailable (${statusCode}) → trying ${nextModel}`);
        // Re-execute with the fallback model
        try {
          const fallbackResult = await executeProviderRequest(nextModel, false);
          if (fallbackResult.response.ok) {
            providerResponse = fallbackResult.response;
            providerUrl = fallbackResult.url;
            providerHeaders = fallbackResult.headers;
            finalBody = providerRequestCapture.body(fallbackResult.transformedBody);
            reqLogger.logTargetRequest(providerUrl, providerHeaders, finalBody);
            getPendingRequestScope().updatePendingScope(pendingScope, {
              providerRequest: finalBody,
              providerUrl,
              stage: "provider_response_started",
            });
            // Continue processing with the fallback response — skip error return
            log?.info?.("MODEL_FALLBACK", `Serving ${nextModel} as fallback for ${model}`);
            // Jump to streaming/non-streaming handling below
            // We fall through by NOT returning here
          } else {
            // Fallback also failed — return original error
            persistAttemptLogs({
              status: statusCode,
              error: errMsg,
              providerRequest: finalBody || translatedBody,
              providerResponse: upstreamErrorBody,
              clientResponse: buildErrorBody(statusCode, errMsg),
              cacheSource: "upstream",
            });
            persistFailureUsage(statusCode, "model_unavailable");
            return createErrorResult(
              statusCode,
              errMsg,
              retryAfterMs,
              upstreamErrorCode,
              upstreamErrorType,
              upstreamErrorBody,
              { passthrough: sourceFormat === FORMATS.CLAUDE }
            );
          }
        } catch {
          persistAttemptLogs({
            status: statusCode,
            error: errMsg,
            providerRequest: finalBody || translatedBody,
            providerResponse: upstreamErrorBody,
            clientResponse: buildErrorBody(statusCode, errMsg),
            cacheSource: "upstream",
          });
          persistFailureUsage(statusCode, "model_unavailable");
          return createErrorResult(
            statusCode,
            errMsg,
            retryAfterMs,
            upstreamErrorCode,
            upstreamErrorType,
            upstreamErrorBody,
            { passthrough: sourceFormat === FORMATS.CLAUDE }
          );
        }
      } else {
        persistAttemptLogs({
          status: statusCode,
          error: errMsg,
          providerRequest: finalBody || translatedBody,
          providerResponse: upstreamErrorBody,
          clientResponse: buildErrorBody(statusCode, errMsg),
          cacheSource: "upstream",
        });
        persistFailureUsage(statusCode, "model_unavailable");
        return createErrorResult(
          statusCode,
          errMsg,
          retryAfterMs,
          upstreamErrorCode,
          upstreamErrorType,
          upstreamErrorBody,
          { passthrough: sourceFormat === FORMATS.CLAUDE }
        );
      }
    } else if (getModelFamilyFallback().isContextOverflowError(statusCode, message)) {
      const familyCandidates = getModelFamilyFallback().getModelFamily(currentModel).filter(
        (m) => m !== currentModel && !triedModels.has(m)
      );
      const nextModel =
        getModelFamilyFallback().findLargerContextModel(currentModel, familyCandidates) ??
        getModelFamilyFallback().getNextFamilyFallback(currentModel, triedModels);
      if (nextModel) {
        triedModels.add(nextModel);
        currentModel = nextModel;
        translatedBody.model = nextModel;
        log?.info?.("CONTEXT_OVERFLOW_FALLBACK", `${model} context overflow → trying ${nextModel}`);
        try {
          const fallbackResult = await executeProviderRequest(nextModel, false);
          if (fallbackResult.response.ok) {
            providerResponse = fallbackResult.response;
            providerUrl = fallbackResult.url;
            providerHeaders = fallbackResult.headers;
            finalBody = providerRequestCapture.body(fallbackResult.transformedBody);
            reqLogger.logTargetRequest(providerUrl, providerHeaders, finalBody);
            getPendingRequestScope().updatePendingScope(pendingScope, {
              providerRequest: finalBody,
              providerUrl,
              stage: "provider_response_started",
            });
            log?.info?.(
              "CONTEXT_OVERFLOW_FALLBACK",
              `Serving ${nextModel} as fallback for ${model}`
            );
          } else {
            persistAttemptLogs({
              status: statusCode,
              error: errMsg,
              providerRequest: finalBody || translatedBody,
              providerResponse: upstreamErrorBody,
              clientResponse: buildErrorBody(statusCode, errMsg),
              cacheSource: "upstream",
            });
            persistFailureUsage(statusCode, "context_overflow");
            return createErrorResult(
              statusCode,
              errMsg,
              retryAfterMs,
              upstreamErrorCode,
              upstreamErrorType,
              upstreamErrorBody,
              { passthrough: sourceFormat === FORMATS.CLAUDE }
            );
          }
        } catch {
          persistAttemptLogs({
            status: statusCode,
            error: errMsg,
            providerRequest: finalBody || translatedBody,
            providerResponse: upstreamErrorBody,
            clientResponse: buildErrorBody(statusCode, errMsg),
            cacheSource: "upstream",
          });
          persistFailureUsage(statusCode, "context_overflow");
          return createErrorResult(
            statusCode,
            errMsg,
            retryAfterMs,
            upstreamErrorCode,
            upstreamErrorType,
            upstreamErrorBody,
            { passthrough: sourceFormat === FORMATS.CLAUDE }
          );
        }
      } else {
        persistAttemptLogs({
          status: statusCode,
          error: errMsg,
          providerRequest: finalBody || translatedBody,
          providerResponse: upstreamErrorBody,
          clientResponse: buildErrorBody(statusCode, errMsg),
          cacheSource: "upstream",
        });
        persistFailureUsage(statusCode, "context_overflow");
        return createErrorResult(
          statusCode,
          errMsg,
          retryAfterMs,
          upstreamErrorCode,
          upstreamErrorType,
          upstreamErrorBody,
          { passthrough: sourceFormat === FORMATS.CLAUDE }
        );
      }
    } else {
      persistAttemptLogs({
        status: statusCode,
        error: errMsg,
        providerRequest: finalBody || translatedBody,
        providerResponse: upstreamErrorBody,
        clientResponse: buildErrorBody(statusCode, errMsg),
        cacheSource: "upstream",
      });
      persistFailureUsage(statusCode, `upstream_${statusCode}`);

      // Emergency budget fallback is orchestrated exclusively by the routing layer
      // (src/sse/handlers/chat.ts), which resolves credentials FOR the emergency
      // provider through account selection. The executor-level hop that used to
      // live here re-sent the FAILING provider's credentials to the emergency
      // provider's endpoint (e.g. the OpenAI API key to integrate.api.nvidia.com)
      // — a cross-provider credential leak that also never succeeded upstream.
      return createErrorResult(
        statusCode,
        errMsg,
        retryAfterMs,
        upstreamErrorCode,
        upstreamErrorType,
        upstreamErrorBody,
        { passthrough: sourceFormat === FORMATS.CLAUDE }
      );
    }
    // ── End T5 ───────────────────────────────────────────────────────────────
  }

  // Non-streaming response
  if (!stream) {
    const parsed = await getNonStreamingResponseParse().parseNonStreamingResponseBody({
      providerResponse,
      upstreamStream,
      providerHeaders,
      finalBody,
      targetFormat,
      model,
      log,
    });
    const normalizedProviderPayload = parsed.normalizedProviderPayload;
    const looksLikeSSE = parsed.looksLikeSSE;

    if (parsed.kind === "invalid_sse") {
      getUsageDb().appendRequestLog({
        model,
        provider,
        connectionId,
        status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}`,
      }).catch(() => {});
      const invalidSseMessage = parsed.message;
      persistAttemptLogs({
        status: HTTP_STATUS.BAD_GATEWAY,
        error: invalidSseMessage,
        providerRequest: finalBody || translatedBody,
        providerResponse: normalizedProviderPayload,
        clientResponse: buildErrorBody(HTTP_STATUS.BAD_GATEWAY, invalidSseMessage),
        cacheSource: "upstream",
      });
      persistFailureUsage(HTTP_STATUS.BAD_GATEWAY, "invalid_sse_payload");
      getUsageDb().trackPendingRequest(model, provider, pendingConnId, false);
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, invalidSseMessage);
    }

    if (parsed.kind === "invalid_json") {
      getUsageDb().appendRequestLog({
        model,
        provider,
        connectionId,
        status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}`,
      }).catch(() => {});
      const detailedError = parsed.detailedError;
      const invalidJsonMessage = parsed.message;
      persistAttemptLogs({
        status: HTTP_STATUS.BAD_GATEWAY,
        error: detailedError,
        providerRequest: finalBody || translatedBody,
        providerResponse: normalizedProviderPayload,
        clientResponse: buildErrorBody(HTTP_STATUS.BAD_GATEWAY, invalidJsonMessage),
        cacheSource: "upstream",
      });
      persistFailureUsage(HTTP_STATUS.BAD_GATEWAY, "invalid_json_payload");
      getUsageDb().trackPendingRequest(model, provider, connectionId, false);
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, invalidJsonMessage);
    }

    let responseBody = parsed.responseBody;
    let responsePayloadFormat = parsed.responsePayloadFormat;

    // ── ClinePass {success,data} envelope unwrap (before translation) ──────────
    // ClinePass wraps non-streaming JSON in a {success, data} envelope; errors
    // use {success:false, error}. Transient {success:false, error:"empty..."}
    // responses get one 2s retry before surfacing. CLINEPASS-GATED — untouched
    // for every other provider. Envelope errors route through createErrorResult
    // (→ buildErrorBody/sanitizeErrorMessage, Rule #12).
    if (provider === "clinepass") {
      let { body: unwrapped, error: envError } = getClinepassEnvelope().unwrapClinepassEnvelope(responseBody, provider);
      if (envError && /empty/i.test(envError.message || "")) {
        log?.warn?.("RETRY", "clinepass returned empty content, retrying once after 2s");
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const retryResult = await executeProviderRequest(effectiveModel, false);
          if (retryResult?.response?.ok) {
            const retryParsed = await getNonStreamingResponseParse().parseNonStreamingResponseBody({
              providerResponse: retryResult.response,
              upstreamStream: undefined,
              providerHeaders: retryResult.headers,
              finalBody: retryResult.transformedBody,
              targetFormat,
              model,
              log,
            });
            if (retryParsed.kind !== "invalid_sse" && retryParsed.kind !== "invalid_json") {
              providerResponse = retryResult.response;
              providerUrl = retryResult.url;
              providerHeaders = retryResult.headers;
              finalBody = providerRequestCapture.body(retryResult.transformedBody);
              ({ body: unwrapped, error: envError } = getClinepassEnvelope().unwrapClinepassEnvelope(
                retryParsed.responseBody,
                provider
              ));
            }
          }
        } catch (retryErr) {
          log?.warn?.(
            "RETRY",
            `clinepass retry failed: ${
              retryErr instanceof Error ? retryErr.message : String(retryErr)
            }`
          );
        }
      }
      if (envError) {
        getUsageDb().appendRequestLog({
          model,
          provider,
          connectionId,
          status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}`,
        }).catch(() => {});
        persistFailureUsage(HTTP_STATUS.BAD_GATEWAY, "clinepass_envelope_error");
        getUsageDb().trackPendingRequest(model, provider, connectionId, false);
        return createErrorResult(HTTP_STATUS.BAD_GATEWAY, envError.message);
      }
      responseBody = unwrapped;
    }
    // Thin gateway: Cline envelope only for cline/clinepass providers.
    if (provider === "cline" || provider === "clinepass") {
      responseBody = getClineResponseEnvelope().unwrapClineNonStreamingEnvelope(provider, responseBody);
    }

    // Check for empty content response (fake success) - trigger fallback
    if (getErrorClassifier().isEmptyContentResponse(responseBody)) {
      getUsageDb().appendRequestLog({
        model,
        provider,
        connectionId,
        status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}`,
      }).catch(() => {});
      const emptyContentMessage = "Provider returned empty content";
      persistAttemptLogs({
        status: HTTP_STATUS.BAD_GATEWAY,
        error: emptyContentMessage,
        providerRequest: finalBody || translatedBody,
        providerResponse: normalizedProviderPayload,
        clientResponse: buildErrorBody(HTTP_STATUS.BAD_GATEWAY, emptyContentMessage),
        cacheSource: "upstream",
      });
      persistFailureUsage(HTTP_STATUS.BAD_GATEWAY, "empty_content");

      // Trigger non-recursive fallback for empty content
      const nextModel = getModelFamilyFallback().getNextFamilyFallback(currentModel, triedModels);
      if (nextModel) {
        triedModels.add(nextModel);
        currentModel = nextModel;
        translatedBody.model = nextModel;
        log?.info?.(
          "EMPTY_CONTENT_FALLBACK",
          `${model} returned empty content → trying ${nextModel}`
        );
        try {
          const fallbackResult = await executeProviderRequest(nextModel, false);
          if (fallbackResult.response.ok) {
            const fallbackRaw = await getStream().withBodyTimeout<string>(fallbackResult.response.text());
            try {
              responseBody = fallbackRaw ? JSON.parse(fallbackRaw) : {};
              providerUrl = fallbackResult.url;
              providerHeaders = fallbackResult.headers;
              finalBody = providerRequestCapture.body(fallbackResult.transformedBody);
              reqLogger.logTargetRequest(providerUrl, providerHeaders, finalBody);
              log?.info?.(
                "EMPTY_CONTENT_FALLBACK",
                `Serving ${nextModel} as fallback for ${model}`
              );
              // Fall through — continue processing with the new responseBody
            } catch {
              getUsageDb().trackPendingRequest(model, provider, connectionId, false);
              return createErrorResult(HTTP_STATUS.BAD_GATEWAY, emptyContentMessage);
            }
          } else {
            getUsageDb().trackPendingRequest(model, provider, connectionId, false);
            return createErrorResult(HTTP_STATUS.BAD_GATEWAY, emptyContentMessage);
          }
        } catch {
          getUsageDb().trackPendingRequest(model, provider, connectionId, false);
          return createErrorResult(HTTP_STATUS.BAD_GATEWAY, emptyContentMessage);
        }
      } else {
        getUsageDb().trackPendingRequest(model, provider, connectionId, false);
        return createErrorResult(HTTP_STATUS.BAD_GATEWAY, emptyContentMessage);
      }
    }

    const restoreClaudeNames = sourceFormat === FORMATS.CLAUDE && targetFormat === FORMATS.CLAUDE;
    let responseToolNameMap: Map<string, string> | null;
    [responseBody, responseToolNameMap] = getPassthroughToolNames().restoreNonStreamingToolNames(
      responseBody,
      toolNameMap,
      finalBody,
      restoreClaudeNames
    );
    reqLogger.logProviderResponse(
      providerResponse.status,
      providerResponse.statusText,
      providerResponse.headers,
      looksLikeSSE
        ? {
            _streamed: true,
            _format: "sse-json",
            summary: responseBody,
          }
        : responseBody
    );
    effectiveServiceTier = resolveReportedServiceTier(responseBody) ?? effectiveServiceTier;

    // Notify success - caller can clear error status if needed
    if (onRequestSuccess) {
      await onRequestSuccess();
    }
    const successConnectionId = getCurrentConnectionId();
    await maybeSyncClaudeExtraUsageState({
      provider,
      connectionId: successConnectionId,
      providerSpecificData: credentials?.providerSpecificData,
      log,
    });

    // Log usage for non-streaming responses
    const usage = getUsageExtractor().extractUsageFromResponse(responseBody, provider);
    if (usage && typeof usage === "object") {
      // Track Gemini token consumption for TPM rate-limit pre-check
      if (provider === "gemini") {
        const promptTokens =
          typeof (usage as Record<string, unknown>).prompt_tokens === "number"
            ? ((usage as Record<string, unknown>).prompt_tokens as number)
            : 0;
        if (promptTokens > 0) getGeminiRateLimitTracker().incrementTokenUsage(model, promptTokens);
      }
    }

    // Context Editing telemetry removed (thin gateway).
    getUsageDb().appendRequestLog({
      model,
      provider,
      connectionId: successConnectionId,
      tokens: usage,
      status: "200 OK",
    }).catch(() => {});

    // Save structured call log with full payloads
    // Thin gateway: cache usage meta is Claude prompt-cache specific — skip for non-Claude.
    const cacheUsageLogMeta = (provider === "claude" || provider === "anthropic")
      ? getCacheUsageMeta().buildCacheUsageLogMeta(usage)
      : {};
    getNonStreamingUsageStats().recordNonStreamingUsageStats(usage, {
      traceEnabled,
      provider,
      connectionId: successConnectionId,
      model,
      startTime,
      apiKeyInfo,
      effectiveServiceTier,
      isCombo,
      comboStrategy,
      endpoint: endpointPath,
    });

    // Translate response to client's expected format (usually OpenAI)
    // Pass toolNameMap so Claude OAuth proxy_ prefix is stripped in tool_use blocks (#605)
    let translatedResponse = needsTranslation(responsePayloadFormat, clientResponseFormat)
      ? getResponseTranslator().translateNonStreamingResponse(
          responseBody,
          responsePayloadFormat,
          clientResponseFormat,
          responseToolNameMap
        )
      : responseBody;

    // T26: Strip markdown code blocks if provider format is Claude
    if (sourceFormat === "claude" && !stream) {
      if (typeof translatedResponse?.choices?.[0]?.message?.content === "string") {
        translatedResponse.choices[0].message.content = getAiSdkCompat().stripMarkdownCodeFence(
          translatedResponse.choices[0].message.content
        ) as string;
      }
    }

    // T18: Normalize finish_reason to 'tool_calls' if tool calls are present
    getPassthroughToolNames().normalizeOpenAIToolFinishReasons(translatedResponse);

    // Reasoning Replay Cache (#1628): Capture reasoning_content from non-streaming responses
    // with tool_calls so it can be replayed on subsequent turns (DeepSeek V4, Kimi K2, etc.)
    // Thin gateway: only load reasoningCache for providers that need reasoning replay.
    if (provider === "deepseek" || provider === "opencode-go" || provider === "opencode-zen" || provider === "opencode" || provider === "kimi-coding" || provider === "kimi-coding-apikey") {
    try {
      const firstChoice = translatedResponse?.choices?.[0];
      const msg = firstChoice?.message;
      const bodyMessages = (body as { messages?: unknown[] } | null | undefined)?.messages;
      getReasoningCache().cacheReasoningFromAssistantMessage(msg, provider, model, {
        requestId: skillRequestId,
        messageIndex: Array.isArray(bodyMessages) ? bodyMessages.length : 0,
      });
    } catch {
      // Cache capture is non-critical — never block the response
    }
    } // end reasoning-provider gate
    // Sanitize response for OpenAI SDK compatibility
    // Strips non-standard fields (x_groq, usage_breakdown, service_tier, etc.)
    // Extracts <think> and <thinking> tags into reasoning_content
    // Source format determines output shape. If we are outputting OpenAI shape or pseudo-OpenAI shape, sanitize.
    if (clientResponseFormat === FORMATS.OPENAI_RESPONSES) {
      translatedResponse = getResponseSanitizer().sanitizeResponsesApiResponse(translatedResponse);
      // Responses-API non-stream path: restore `{namespace, name}` on every
      // `function_call` item that was flattened from a namespace sub-tool on
      // the request side (#7936 round-trip closure).
      const responseOutput = translatedResponse?.output;
      if (requestToolIdentityMap && Array.isArray(responseOutput)) {
        for (const item of responseOutput) {
          if (item?.type !== "function_call") continue;
          const identity = requestToolIdentityMap.get(item.name);
          if (identity) {
            item.namespace = identity.namespace;
            item.name = identity.name;
          }
        }
      }
    } else if (clientResponseFormat === FORMATS.OPENAI) {
      // Port of decolua/9router#517: opt-in `x-omniroute-strip-reasoning` header
      // unconditionally drops `reasoning_content` from the final non-streaming
      // JSON for clients (e.g. Firecrawl AI SDK) whose JSON parsers break on
      // that non-standard field. Reasoning replay cache is captured above this
      // sanitize step, so the cache feature is unaffected.
      const stripReasoning = isStripReasoningRequested(clientRawRequest?.headers ?? null);
      translatedResponse = getResponseSanitizer().sanitizeOpenAIResponse(translatedResponse, {
        stripReasoning,
        parseTextualReasoningTags: getResponseSanitizer().shouldParseTextualReasoningTags(provider, model),
      });
    }

    // Client usage buffer + post-call guardrails removed (thin gateway).

    const responseUsage =
      (usage && typeof usage === "object" ? usage : null) ||
      (translatedResponse?.usage && typeof translatedResponse.usage === "object"
        ? translatedResponse.usage
        : null);
    const estimatedCost = responseUsage
      ? await getCostCalculator().calculateCost(provider, model, responseUsage, { serviceTier: effectiveServiceTier })
      : 0;

    // Validate the *translated* response actually carries client-usable output.
    // isEmptyContentResponse (above) runs on the raw responseBody before translation;
    // this check runs after translation + sanitization + tool-call execution to catch
    // cases where a provider returns a structurally valid raw body that translates into
    // choices:[] or output:[] with no usable content (Responses API shape included).
    const malformedTranslatedReason = getDiagnostics().detectMalformedNonStream(translatedResponse);
    if (malformedTranslatedReason) {
      const totalLatency = Date.now() - startTime;
      const rawBytes = (() => {
        try {
          return JSON.stringify(responseBody || {}).length;
        } catch {
          return -1;
        }
      })();
      getDiagnostics().reportMalformed200({
        mode: "nonstream",
        provider,
        model,
        connectionId,
        reason: malformedTranslatedReason,
        recvBytes: rawBytes,
        recvLines: -1,
        emitted: -1,
        events: {},
        ttftMs: totalLatency,
        elapsedMs: totalLatency,
      });
      getUsageDb().appendRequestLog({
        model,
        provider,
        connectionId,
        status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}`,
      }).catch(() => {});
      const malformed = getDiagnostics().describeMalformedNonStream(translatedResponse, malformedTranslatedReason);
      const malformedMessage = `[${provider}/${model}] ${malformed.message}`;
      const malformedClientBody = buildErrorBody(HTTP_STATUS.BAD_GATEWAY, malformedMessage);
      malformedClientBody.error.code = malformed.code;
      malformedClientBody.error.type = malformed.type;
      persistAttemptLogs({
        status: HTTP_STATUS.BAD_GATEWAY,
        tokens: usage,
        responseBody,
        providerRequest: finalBody || translatedBody,
        providerResponse: looksLikeSSE
          ? { _streamed: true, _format: "sse-json", summary: responseBody }
          : responseBody,
        clientResponse: malformedClientBody,
        claudeCacheMeta: claudePromptCacheLogMeta,
        claudeCacheUsageMeta: cacheUsageLogMeta,
        cacheSource: "upstream",
      });
      persistFailureUsage(HTTP_STATUS.BAD_GATEWAY, "malformed_translated_response");
      getUsageDb().trackPendingRequest(model, provider, pendingConnId, false);
      return createErrorResult(
        HTTP_STATUS.BAD_GATEWAY,
        malformedMessage,
        null,
        malformed.code,
        malformed.type
      );
    }

    // Semantic cache store + idempotency save removed (thin gateway).

    reqLogger.logConvertedResponse(translatedResponse);
    persistAttemptLogs({
      status: 200,
      tokens: usage,
      responseBody,
      providerRequest: finalBody || translatedBody,
      providerResponse: looksLikeSSE
        ? {
            _streamed: true,
            _format: "sse-json",
            summary: responseBody,
          }
        : responseBody,
      clientResponse: translatedResponse,
      claudeCacheMeta: claudePromptCacheLogMeta,
      claudeCacheUsageMeta: cacheUsageLogMeta,
      cacheSource: "upstream",
    });
    if (apiKeyInfo?.id && estimatedCost > 0) {
      getCostRules().recordCost(apiKeyInfo.id, estimatedCost);
    }

    // === Quota Share POST-hook (B/F7) — fire-and-forget, fail-open ===
    await getQuotaShareConsumption().scheduleQuotaShareConsumption({
      apiKeyId: apiKeyInfo?.id,
      connectionId: credentials?.connectionId,
      provider,
      model,
      usage,
      estimatedCost,
      log,
    });
    // === /Quota Share POST-hook ===

    getPendingRequestScope().finalizePendingScope(pendingScope, {
      providerResponse: responseBody,
      clientResponse: translatedResponse,
    });
    const responseHeaders = buildNonStreamingResponseHeaders({
      provider,
      model,
      startTime,
      responseUsage,
      estimatedCost,
      requestId: skillRequestId,
      compressionResponseMeta,
      comboStrategy,
    });
    // #6426: align response body `model` with the `X-OmniRoute-Model` header
    // (both must be the resolved backend model). Some upstreams (notably legacy
    // /v1/completions text-completion path) return a body `model` field that
    // differs from the resolved backend id we advertised in the header, leaving
    // strict clients unable to reconcile the two. Rewrite body.model to `model`
    // FIRST, then let #1311 echo override it when the opt-in setting is on.
    if (typeof model === "string" && model) getResponseModelEcho().echoModelInObject(translatedResponse, model);
    // #1311: echo the requested alias/combo name in the non-streaming response model.
    if (echoModel) getResponseModelEcho().echoModelInObject(translatedResponse, echoModel);

    // ── Plugin onResponse hook (fire-and-forget) ──
    // Thin gateway: plugin onResponse hook disabled.
    // await getPluginOnResponse().runPluginOnResponseHook({
    //   requestId: traceId, body, model, provider, apiKeyInfo,
    //   headers: clientRawRequest?.headers,
    //   response: { status: 200, data: translatedResponse },
    // });

    return {
      success: true,
      response: buildNonStreamingJsonResponse(translatedResponse, responseHeaders),
    };
  }

  // Streaming response
  // JSON-to-SSE conversion removed (thin gateway).
  const streamReadinessPolicy = getStreamReadinessPolicy().resolveStreamReadinessTimeout({
    baseTimeoutMs: STREAM_READINESS_TIMEOUT_MS,
    provider,
    model,
    body: (finalBody || translatedBody) as Record<string, unknown> | null | undefined,
    maxTimeoutMs: agentGoalPolicy.detected
      ? Math.max(STREAM_READINESS_MAX_TIMEOUT_MS, agentGoalPolicy.readinessMaxTimeoutMs)
      : STREAM_READINESS_MAX_TIMEOUT_MS,
  });
  if (streamReadinessPolicy.timeoutMs !== streamReadinessPolicy.baseTimeoutMs) {
    log?.debug?.(
      "STREAM",
      `adaptive readiness timeout=${streamReadinessPolicy.timeoutMs}ms base=${streamReadinessPolicy.baseTimeoutMs}ms reason=${streamReadinessPolicy.reasons.join(",")}`
    );
  }

  const streamReadiness = await getStreamReadiness().ensureStreamReadiness(providerResponse, {
    timeoutMs: streamReadinessPolicy.timeoutMs,
    provider,
    model,
    log,
  });
  if (streamReadiness.ok === false) {
    const { response: failureResponse, reason } = streamReadiness;
    const { classificationReason, upstreamDiagnostic } = streamReadiness;
    getUsageDb().trackPendingRequest(model, provider, connectionId, false);
    getUsageDb().appendRequestLog({
      model,
      provider,
      connectionId,
      status: `FAILED ${failureResponse.status}`,
    }).catch(() => {});
    persistAttemptLogs({
      status: failureResponse.status,
      error: reason,
      providerRequest: finalBody || translatedBody,
      clientResponse: buildErrorBody(
        failureResponse.status,
        classificationReason,
        upstreamDiagnostic ? { error: { message: upstreamDiagnostic } } : undefined
      ),
      claudeCacheMeta: claudePromptCacheLogMeta,
      cacheSource: "upstream",
    });
    persistFailureUsage(failureResponse.status, streamReadiness.code);
    // Do NOT call onStreamFailure — a stream stall is an upstream issue,
    // not an account/quota failure. Marking the account unavailable here
    // would lock out legitimate accounts when the upstream hangs.
    return {
      success: false,
      status: failureResponse.status,
      error: reason,
      classificationError: classificationReason,
      errorType: streamReadiness.type,
      errorCode: streamReadiness.code,
      response: failureResponse,
    };
  }
  providerResponse = streamReadiness.response;

  // Notify success - caller can clear error status if needed
  if (onRequestSuccess) {
    await onRequestSuccess();
  }

  const responseHeaders = assembleStreamingResponseHeaders({
    providerHeaders: providerResponse.headers,
    provider,
    model,
    pendingRequestId,
    compressionResponseMeta,
    comboStrategy,
  });

  // Create transform stream with logger for streaming response
  let transformStream;
  const responseToolNameMap = getPassthroughToolNames().mergeResponseToolNameMap(
    toolNameMap,
    (finalBody as Record<string, unknown> | null | undefined) ?? null
  );

  let streamCompletionRecorded = false;
  let streamFailureCompletionRecorded = false;

  // Callback to save call log when stream completes (include responseBody when provided by stream)
  const onStreamComplete = ({
    status: streamStatus,
    usage: streamUsage,
    responseBody: streamResponseBody,
    providerPayload,
    clientPayload,
    error: streamError,
    errorCode: streamErrorCode,
    ttft,
  }) => {
    const normalizedStreamStatus = streamStatus || 200;
    if (streamCompletionRecorded) return;
    streamCompletionRecorded = true;
    if (normalizedStreamStatus !== 200) {
      if (streamFailureCompletionRecorded) return;
      streamFailureCompletionRecorded = true;
    }
    const cacheUsageLogMeta = (provider === "claude" || provider === "anthropic")
      ? getCacheUsageMeta().buildCacheUsageLogMeta(streamUsage)
      : {};
    const streamConnectionId = getCurrentConnectionId();

    if (normalizedStreamStatus === 200) {
      void maybeSyncClaudeExtraUsageState({
        provider,
        connectionId: streamConnectionId,
        providerSpecificData: credentials?.providerSpecificData,
        log,
      });
    }

    // Reasoning Replay Cache (#1628): Capture reasoning_content from streaming responses
    // with tool_calls so it can be replayed on subsequent turns (DeepSeek V4, Kimi K2, etc.)
    // Thin gateway: only load reasoningCache for providers that need reasoning replay.
    if (normalizedStreamStatus === 200 && streamResponseBody &&
        (provider === "deepseek" || provider === "opencode-go" || provider === "opencode-zen" || provider === "opencode" || provider === "kimi-coding" || provider === "kimi-coding-apikey")) {
      try {
        const streamBody = streamResponseBody as Record<string, unknown>;
        const choices = streamBody.choices as { message?: Record<string, unknown> }[] | undefined;
        const msg = choices?.[0]?.message;
        // See the non-streaming capture above: messageIndex must match the
        // position this message will occupy in the *next* turn's history.
        const bodyMessages = (body as { messages?: unknown[] } | null | undefined)?.messages;
        getReasoningCache().cacheReasoningFromAssistantMessage(msg, provider, model, {
          requestId: skillRequestId,
          messageIndex: Array.isArray(bodyMessages) ? bodyMessages.length : 0,
        });
      } catch {
        // Cache capture is non-critical — never block the stream
      }
    }
    effectiveServiceTier = resolveReportedServiceTier(streamResponseBody) ?? effectiveServiceTier;

    // Context Editing telemetry removed (thin gateway).

    streamFailure.finalizeStreamRequestLog({
      pendingRequestId,
      model,
      provider,
      connectionId: streamConnectionId,
      providerResponse: providerPayload ?? streamResponseBody ?? undefined,
      clientResponse: clientPayload ?? streamResponseBody ?? undefined,
      status: normalizedStreamStatus,
      error: streamError,
      errorCode: streamErrorCode,
    });

    // Track cache token metrics for streaming responses
    if (streamUsage && typeof streamUsage === "object") {
      // Track Gemini token consumption for TPM rate-limit pre-check
      if (provider === "gemini") {
        const promptTokens =
          typeof (streamUsage as Record<string, unknown>).prompt_tokens === "number"
            ? ((streamUsage as Record<string, unknown>).prompt_tokens as number)
            : 0;
        if (promptTokens > 0) getGeminiRateLimitTracker().incrementTokenUsage(model, promptTokens);
      }
    }
    getStreamingUsageStats().recordStreamingUsageStats(streamUsage, {
      provider,
      model,
      streamStatus: normalizedStreamStatus,
      startTime,
      ttft,
      streamErrorCode,
      connectionId: streamConnectionId,
      apiKeyInfo,
      effectiveServiceTier,
      isCombo,
      comboStrategy,
      endpoint: endpointPath,
    });

    persistAttemptLogs({
      status: normalizedStreamStatus,
      error: streamError || undefined,
      tokens: streamUsage || {},
      responseBody: streamResponseBody ?? undefined,
      providerRequest: finalBody || translatedBody,
      providerResponse: providerPayload,
      clientResponse: clientPayload ?? streamResponseBody ?? undefined,
      claudeCacheMeta: claudePromptCacheLogMeta,
      claudeCacheUsageMeta: cacheUsageLogMeta,
      cacheSource: "upstream",
    });

    getStreamingCost().recordStreamingCost({
      apiKeyId: apiKeyInfo?.id,
      provider,
      model,
      streamUsage,
      serviceTier: effectiveServiceTier,
      calculateCost: getCostCalculator().calculateCost,
      recordCost: getCostRules().recordCost,
    });

    // === Quota Share POST-hook streaming (B/F7) — fire-and-forget, fail-open ===
    // Resolve the real per-request cost (calculateCost) so USD-unit pools accrue
    // on streaming traffic too; this previously recorded usd:0 hardcoded, which
    // meant DeepSeek-style `usd/monthly` shared pools never blocked on streams.
    getStreamingQuotaShare().scheduleStreamingQuotaShareConsumption({
      apiKeyId: apiKeyInfo?.id,
      connectionId: credentials?.connectionId,
      provider,
      model,
      streamUsage,
      streamStatus: normalizedStreamStatus,
      serviceTier: effectiveServiceTier,
      calculateCost: getCostCalculator().calculateCost,
      log,
    });
    // === /Quota Share POST-hook streaming ===

    // Streaming semantic cache store removed (thin gateway).
  };

  const streamFailureFinalizers = streamFailure.createStreamFailureFinalizers({
    isFailureCompletionRecorded: () => streamFailureCompletionRecorded,
    isStreamCompletionRecorded: () => streamCompletionRecorded,
    onStreamComplete,
    persistFailureUsage,
    onStreamFailure,
  });
  const handleStreamFailure = streamFailureFinalizers.handleStreamFailure;
  onPipelineStreamError = streamFailureFinalizers.onPipelineStreamError;
  // #9653: gives a genuine, race-delayed completion a chance to land (see
  // createClientDisconnectGraceHandler's doc comment) before persisting a false
  // 499/0-tokens for a request that actually delivered its full response.
  onClientDisconnectFinalize = streamFailure.createClientDisconnectGraceHandler({
    isStreamCompletionRecorded: () => streamCompletionRecorded,
    gracePeriodMs: STREAM_DISCONNECT_GRACE_PERIOD_MS,
    finalize: (event) =>
      handleStreamFailure({
        status: 499,
        message: `Client disconnected: ${event.reason}`,
        code: "client_disconnected",
        type: "client_disconnected",
      }),
  });

  // For providers using Responses API format, translate stream back to openai (Chat Completions) format
  // UNLESS client is Droid CLI which expects openai-responses format back
  const needsResponsesTranslation =
    targetFormat === FORMATS.OPENAI_RESPONSES &&
    clientResponseFormat === FORMATS.OPENAI &&
    !isResponsesEndpoint &&
    !isDroidCLI;
  const streamStateBody = finalBody || body;

  if (needsResponsesTranslation) {
    // Provider returns openai-responses, translate to openai (Chat Completions) that clients expect
    log?.debug?.("STREAM", `Responses translation mode: openai-responses → openai`);
    transformStream = getStream().createSSETransformStreamWithLogger(
      "openai-responses",
      "openai",
      provider,
      reqLogger,
      responseToolNameMap,
      model,
      connectionId,
      streamStateBody,
      onStreamComplete,
      apiKeyInfo,
      handleStreamFailure,
      copilotCompatibleReasoning,
      // openai-responses → openai translation still wants the namespace identity
      // map for #7936-style round-trip closure when the client also speaks
      // Responses (Codex CLI).
      requestToolIdentityMap
    );
  } else if (needsTranslation(targetFormat, clientResponseFormat)) {
    // Standard translation for other providers
    log?.debug?.("STREAM", `Translation mode: ${targetFormat} → ${clientResponseFormat}`);
    transformStream = getStream().createSSETransformStreamWithLogger(
      targetFormat,
      clientResponseFormat,
      provider,
      reqLogger,
      responseToolNameMap,
      model,
      connectionId,
      streamStateBody,
      onStreamComplete,
      apiKeyInfo,
      handleStreamFailure,
      copilotCompatibleReasoning,
      // Suppress the `</think>` close marker for clients that render it verbatim
      // (e.g. OpenCode by UA; any client via `x-omniroute-thinking-marker: off`);
      // preserved for Claude Code / Cursor and unknown clients by default (#5245 /
      // #5312). Responses API clients always suppress it (structured reasoning
      // items make the marker meaningless); otherwise the header wins over the
      // UA allowlist.
      getThinkCloseMarker().resolveSuppressThinkClose({
        userAgent: streamUserAgent,
        thinkingMarkerHeader,
        clientResponseFormat,
      }),
      customToolNames,
      requestToolIdentityMap
    );
  } else {
    log?.debug?.("STREAM", `Standard passthrough mode`);
    transformStream = getStream().createPassthroughStreamWithLogger(
      provider,
      reqLogger,
      responseToolNameMap,
      model,
      connectionId,
      streamStateBody,
      onStreamComplete,
      apiKeyInfo,
      handleStreamFailure,
      clientResponseFormat,
      requestToolIdentityMap
    );
  }

  const finalStream = assembleStreamingPipeline({
    providerResponse,
    transformStream,
    streamController,
    createPiiTransform,
    clientRawRequestHeaders: clientRawRequest?.headers,
    clientResponseFormat,
    echoModel,
    responseHeaders,
  });

  // ── Plugin onResponse hook (fire-and-forget) ──
  // Thin gateway: plugin onResponse hook disabled.
  // await getPluginOnResponse().runPluginOnResponseHook({
  //   requestId: traceId, body, model, provider, apiKeyInfo,
  //   headers: clientRawRequest?.headers,
  //   response: { status: 200, streamed: true },
  // });

  return {
    success: true,
    response: new Response(finalStream, {
      headers: responseHeaders,
    }),
  };
}
export function isTokenExpiringSoon(expiresAt, bufferMs = 5 * 60 * 1000) {
  if (!expiresAt) return false;
  const expiresAtMs = new Date(expiresAt).getTime();
  return expiresAtMs - Date.now() < bufferMs;
}
