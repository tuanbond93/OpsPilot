import { spawnSync } from "node:child_process";
import path from "node:path";

const eslintBin = path.resolve("node_modules", "eslint", "bin", "eslint.js");
const result = spawnSync(process.execPath, [eslintBin, "src"], {
  stdio: "inherit",
  env: {
    ...process.env,
    ESLINT_USE_FLAT_CONFIG: "false",
  },
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
