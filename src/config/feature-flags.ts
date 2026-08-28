import { SecretProvider } from "../integrations/secrets";

export type RoutingMode = "OFF" | "SHADOW" | "PRIVATE" | "PRIVATE_WITH_FALLBACK";

export const FEATURE_FLAGS = {
  notificationGateway: SecretProvider.getBoolean("TELEGRAM_NOTIFICATION_GATEWAY", true),
  privateRouting: SecretProvider.getBoolean("TELEGRAM_PRIVATE_ROUTING", false),
  managerMirror: SecretProvider.getBoolean("TELEGRAM_MANAGER_MIRROR", false),
} as const;

// Per-province routing mode resolution
// Env var pattern: TELEGRAM_ROUTING_MODE_{PROVINCE_CODE}=OFF|SHADOW|PRIVATE|PRIVATE_WITH_FALLBACK
function getProvinceRoutingMode(provinceCode: string): RoutingMode {
  const envKey = `TELEGRAM_ROUTING_MODE_${provinceCode.toUpperCase()}`;
  const value = SecretProvider.getOptional(envKey, "OFF").toUpperCase().trim();
  if (["OFF", "SHADOW", "PRIVATE", "PRIVATE_WITH_FALLBACK"].includes(value)) {
    return value as RoutingMode;
  }
  return "OFF";
}

export function resolveRoutingMode(provinceCode: string | null | undefined): RoutingMode {
  if (!FEATURE_FLAGS.notificationGateway) return "OFF";
  if (!provinceCode) return "OFF";
  return getProvinceRoutingMode(provinceCode);
}

export function isPrivateRoutingEnabled(provinceCode: string | null | undefined): boolean {
  const mode = resolveRoutingMode(provinceCode);
  return mode === "PRIVATE" || mode === "PRIVATE_WITH_FALLBACK";
}

export function isShadowMode(provinceCode: string | null | undefined): boolean {
  return resolveRoutingMode(provinceCode) === "SHADOW";
}

export function isMirrorEnabled(): boolean {
  return FEATURE_FLAGS.managerMirror;
}
