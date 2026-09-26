/**
 * Staging Production Safety Guard
 * Validates that staging targets are isolated and strictly distinct from production.
 * NEVER prints secret keys or database passwords.
 */

import fs from "fs";
import path from "path";

const PROD_PROJECT_REF = "elwnbwimgzijuelfjdsq";
const PROD_HOST = "elwnbwimgzijuelfjdsq.supabase.co";

export function loadAndVerifyStagingEnv(envFilePath) {
  if (!fs.existsSync(envFilePath)) {
    throw new Error(`STAGING_ENV_MISSING: File not found at ${envFilePath}`);
  }

  const content = fs.readFileSync(envFilePath, "utf-8");
  const env = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }

  const projectRef = env["STAGING_SUPABASE_PROJECT_REF"] || "";
  const url = env["STAGING_SUPABASE_URL"] || "";
  const secretKey = env["STAGING_SUPABASE_SECRET_KEY"] || "";
  const dbPassword = env["STAGING_SUPABASE_DB_PASSWORD"] || "";

  if (!url || !secretKey || !projectRef || !dbPassword) {
    throw new Error("STAGING_ENV_INCOMPLETE: One or more required staging credentials are missing.");
  }

  let host = "";
  try {
    host = new URL(url).hostname;
  } catch (err) {
    throw new Error(`STAGING_URL_INVALID: Could not parse URL hostname: ${err.message}`);
  }

  // MANDATORY PRODUCTION TARGET SAFETY GUARD
  if (projectRef === PROD_PROJECT_REF) {
    console.error("FATAL: STAGING_SUPABASE_PROJECT_REF matches production ref!");
    throw new Error("SAFETY_ABORT_PRODUCTION_TARGET");
  }

  if (host === PROD_HOST || url.includes(PROD_PROJECT_REF)) {
    console.error("FATAL: STAGING_SUPABASE_URL matches production host!");
    throw new Error("SAFETY_ABORT_PRODUCTION_TARGET");
  }

  if (!host.includes(projectRef)) {
    console.warn(`WARNING: Staging host ${host} does not contain project ref ${projectRef}`);
  }

  return {
    isSafe: true,
    projectRef,
    host,
    url,
    secretKey,
    dbPassword,
  };
}

if (process.argv[1]?.endsWith("staging-safety-guard.mjs")) {
  const envPath = path.resolve(process.cwd(), ".env.staging.local");
  try {
    const res = loadAndVerifyStagingEnv(envPath);
    console.log("PRODUCTION_TARGET_GUARD: PASS");
    console.log(`STAGING_PROJECT_REF: ${res.projectRef}`);
    console.log(`STAGING_HOST: ${res.host}`);
    console.log("STAGING_SUPABASE_URL: PRESENT");
    console.log("STAGING_SUPABASE_SECRET_KEY: PRESENT");
    console.log("STAGING_SUPABASE_DB_PASSWORD: PRESENT");
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
