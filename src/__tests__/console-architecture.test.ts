import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

describe("Sprint 11.4 — Production Console Architecture Guardrail Test", () => {
  const ALLOWLIST: { [filePath: string]: number[] } = {
    "src/observability/logger.ts": [29, 41, 53, 65], // Final log transport
    "src/notifications/providers/console.ts": [11], // Mock notification transport
    "src/security/edge-audit.ts": [18], // Edge-safe structured security audit transport
  };

  function walk(dir: string): string[] {
    let results: string[] = [];
    if (!fs.existsSync(dir)) return results;
    const list = fs.readdirSync(dir);
    list.forEach((file) => {
      file = path.join(dir, file);
      const stat = fs.statSync(file);
      if (stat && stat.isDirectory()) {
        results = results.concat(walk(file));
      } else if (file.match(/\.(ts|tsx|js|jsx)$/)) {
        results.push(file);
      }
    });
    return results;
  }

  it("ensures zero unauthorized production console.* statements exist in src/", () => {
    const allFiles = walk(path.resolve(process.cwd(), "src"));

    const violations: string[] = [];

    allFiles.forEach((fullPath) => {
      const relativePath = path.relative(process.cwd(), fullPath).replace(/\\/g, "/");

      // Skip test directory and CLI evaluation tool
      if (relativePath.startsWith("src/__tests__/") || relativePath.startsWith("src/evaluation/")) {
        return;
      }

      const content = fs.readFileSync(fullPath, "utf8");
      const lines = content.split("\n");

      lines.forEach((line, index) => {
        const lineNumber = index + 1;
        // Match console.log, console.warn, console.error, console.debug
        if (line.match(/console\.(log|warn|error|debug)/)) {
          // Check if line is a comment or JSDoc
          const trimmed = line.trim();
          if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
            return;
          }

          const allowedLines = ALLOWLIST[relativePath];
          if (!allowedLines || !allowedLines.includes(lineNumber)) {
            violations.push(`${relativePath}:${lineNumber} -> ${line.trim()}`);
          }
        }
      });
    });

    expect(violations, `Unauthorized console statements found in production code:\n${violations.join("\n")}`).toEqual([]);
  });
});
