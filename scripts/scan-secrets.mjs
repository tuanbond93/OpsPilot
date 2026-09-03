import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const trackedFiles = readFileSync(0, "utf8").split("\0").filter(Boolean);

const allowedEnvExamples = /(^|\/)(?:\.env|[^/]+\.env)\.example$/i;
const forbiddenEnvFile = /(^|\/)(?:\.env(?:\..+)?|[^/]+\.env)$/i;
const contentRules = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["provider access token", /\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/],
  ["Telegram bot token", /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/],
  ["JWT or OIDC token", /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/],
  ["Vercel OIDC token assignment", /\bVERCEL_OIDC_TOKEN\s*=\s*[^\s#]+/],
];

const findings = [];
for (const file of trackedFiles) {
  const normalized = file.replaceAll("\\", "/");
  // A tracked file scheduled for deletion is still returned by git ls-files;
  // evaluate the release working tree, not content that no longer exists.
  if (!existsSync(path.resolve(file))) continue;
  if (forbiddenEnvFile.test(normalized) && !allowedEnvExamples.test(normalized)) {
    findings.push({ file: normalized, rule: "tracked environment file" });
    continue;
  }

  let content;
  try {
    content = readFileSync(path.resolve(file), "utf8");
  } catch {
    continue;
  }
  if (content.includes("\0")) continue;

  for (const [rule, pattern] of contentRules) {
    if (pattern.test(content)) findings.push({ file: normalized, rule });
  }
}

if (findings.length > 0) {
  console.error("Secret scan failed. Sensitive values are never printed:");
  for (const finding of findings) {
    console.error(`- ${finding.file}: ${finding.rule}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Secret scan passed (${trackedFiles.length} tracked files checked).`);
}
