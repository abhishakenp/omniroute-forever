/**
 * Device Tracker — STUBBED (thin gateway).
 * API surface kept for the /api/keys/[id]/devices route; tracking is a no-op.
 */

export interface DeviceDetail {
  ipMasked: string;
  userAgent: string;
  lastSeen: number;
}

export function maskIp(_ip: string | null | undefined): string {
  return "unknown";
}

export function extractIpFromHeaders(
  _headers: Record<string, string> | Headers | null | undefined
): string | null {
  return null;
}

export function trackDevice(
  _apiKeyId: string,
  _ip: string | null,
  _userAgent: string | null
): void {}

export function getDeviceCount(_apiKeyId: string | null | undefined): number {
  return 0;
}

export function getDeviceDetails(_apiKeyId: string | null | undefined): DeviceDetail[] {
  return [];
}

export function getAllDeviceCounts(): Record<string, number> {
  return {};
}

export function clearDeviceTracker(): void {}

export function expireDevices(_now?: number): number {
  return 0;
}
