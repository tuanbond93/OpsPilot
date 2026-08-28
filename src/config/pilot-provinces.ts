/**
 * Pilot Province Configuration
 *
 * Per-province routing configuration that can be adjusted via
 * environment variables without code deployment.
 *
 * This module does NOT hardcode Yên Bái into business logic.
 * Instead, it provides a configurable mapping that the gateway
 * uses to determine routing strategy.
 */

import { SecretProvider } from "../integrations/secrets";
import type { RoutingMode } from "./feature-flags";
import { resolveRoutingMode } from "./feature-flags";

export interface ProvinceConfig {
  /** Province name as it appears in warehouse-assignments */
  provinceName: string;
  /** Short code used in feature flag env vars (e.g., YBA, LCA) */
  provinceCode: string;
  /** Current routing mode resolved from feature flags */
  routingMode: RoutingMode;
}

/**
 * Province code mapping.
 * Codes are used in environment variable names: TELEGRAM_ROUTING_MODE_{CODE}
 *
 * This list is loaded from config, not hardcoded into business logic.
 * Add new provinces here when ready to pilot.
 */
const PROVINCE_CODES: Record<string, string> = {
  "Yên Bái": "YBA",
  "Lào Cai": "LCA",
  "Hòa Bình": "HBI",
  "Điện Biên": "DBI",
  "Lai Châu": "LCH",
  "Sơn La": "SLA",
  "Phú Thọ": "PTH",
  "Hà Giang": "HGI",
  "Tuyên Quang": "TQU",
  "Bắc Kạn": "BKA",
  "Thái Nguyên": "TNG",
  "Cao Bằng": "CBA",
  "Lạng Sơn": "LSO",
};

/**
 * Normalize province name for lookup (remove diacritics, lowercase).
 */
function normalizeProvinceName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .trim()
    .toLocaleLowerCase("vi");
}

// Build reverse lookup: normalized name → code
const normalizedCodeLookup = new Map(
  Object.entries(PROVINCE_CODES).map(([name, code]) => [
    normalizeProvinceName(name),
    code,
  ])
);

/**
 * Get the province code from a province name.
 */
export function getProvinceCode(provinceName: string | null | undefined): string | null {
  if (!provinceName) return null;
  return normalizedCodeLookup.get(normalizeProvinceName(provinceName)) || null;
}

/**
 * Get the province config for a given province name.
 */
export function getProvinceConfig(provinceName: string | null | undefined): ProvinceConfig | null {
  if (!provinceName) return null;

  const code = getProvinceCode(provinceName);
  if (!code) return null;

  return {
    provinceName,
    provinceCode: code,
    routingMode: resolveRoutingMode(code),
  };
}

/**
 * Get all province configs with their current routing modes.
 * Useful for admin dashboards and debugging.
 */
export function getAllProvinceConfigs(): ProvinceConfig[] {
  return Object.entries(PROVINCE_CODES).map(([name, code]) => ({
    provinceName: name,
    provinceCode: code,
    routingMode: resolveRoutingMode(code),
  }));
}

/**
 * Check if any province has private routing enabled.
 * Useful for determining if private delivery infrastructure is needed.
 */
export function hasAnyPrivateRouting(): boolean {
  return Object.values(PROVINCE_CODES).some((code) => {
    const mode = resolveRoutingMode(code);
    return mode === "PRIVATE" || mode === "PRIVATE_WITH_FALLBACK";
  });
}
