import assert from "node:assert/strict";
import test from "node:test";
import { parseSingleJsonSelect } from "./opspilot-shadow-final-gate-output.mjs";

test("separate DO command output is ignored and only the JSON SELECT result is parsed", () => {
  const doCommandStdout = "DO\n";
  const jsonSelectStdout = '{"ok":true}\n';
  const nativeJsonParse = JSON.parse;
  const parsedInputs = [];
  JSON.parse = (input, ...args) => {
    parsedInputs.push(input);
    return nativeJsonParse.call(JSON, input, ...args);
  };

  try {
    // The command runner discards the DO command's stdout; only the distinct
    // SELECT result is handed to the JSON parser.
    assert.deepEqual(parseSingleJsonSelect(jsonSelectStdout), { ok: true });
    assert.deepEqual(parsedInputs, ['{"ok":true}']);

    // A mixed psql transcript must be rejected by shape validation before
    // JSON.parse can receive the command tag or any other non-SELECT output.
    parsedInputs.length = 0;
    assert.throws(
      () => parseSingleJsonSelect(`${doCommandStdout}${jsonSelectStdout}`),
      /expected one SELECT row/,
    );
    assert.deepEqual(parsedInputs, []);
  } finally {
    JSON.parse = nativeJsonParse;
  }
});
