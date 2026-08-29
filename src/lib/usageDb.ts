// Thin gateway — usage tracking removed. All functions are no-ops.
export const trackPendingRequest = () => {};
export const updatePendingRequest = () => {};
export const updatePendingRequestStreamChunks = () => {};
export const finalizePendingRequest = () => {};
export const getUsageDb = () => null;
export const saveRequestUsage = () => Promise.resolve();
export const getUsageHistory = () => [];
export const getModelLatencyStats = () => [];
export const appendRequestLog = () => Promise.resolve();
export const getRecentLogs = () => [];
export const calculateCost = () => 0;
export const getUsageStats = () => ({});
export const saveCallLog = () => Promise.resolve();
export const rotateCallLogs = () => {};
export const getCallLogs = () => [];
export const getCallLogById = () => null;

// Additional no-ops for chat-path callers that previously imported directly
// from ./usage/usageHistory (which pulls in migrations → yazl + piiSanitizer).
export const finalizePendingRequestById = () => false;
export const finalizeMostRecentPendingRequest = () => {};
export const updatePendingRequestById = () => false;
export const getPendingById = () => new Map<string, unknown>();
