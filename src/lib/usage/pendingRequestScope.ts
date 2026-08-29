// Thin gateway — pending request scope tracking removed. All functions are no-ops.
// Previously imported from ./usageHistory which pulls in migrations → yazl + piiSanitizer.

export type PendingRequestMetadata = Record<string, unknown>;

export type PendingRequestScope = {
  id: string | null | undefined;
  model: string;
  provider: string;
  connectionId: string | null;
};

export function updatePendingScope(_scope: PendingRequestScope, _metadata: PendingRequestMetadata) {}

export function finalizePendingScope(_scope: PendingRequestScope, _metadata: PendingRequestMetadata) {}
