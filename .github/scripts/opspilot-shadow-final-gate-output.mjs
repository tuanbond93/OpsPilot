export function parseSingleJsonSelect(stdout, label = "JSON_SELECT") {
  const lines = String(stdout ?? "").trim().split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length !== 1) {
    throw new Error(`GATE_FAILED:${label}_OUTPUT_SHAPE:expected one SELECT row, received ${lines.length}`);
  }
  try {
    return JSON.parse(lines[0]);
  } catch {
    throw new Error(`GATE_FAILED:${label}_INVALID_JSON_SELECT_OUTPUT`);
  }
}

export function parseSingleScalarSelect(stdout, label = "SCALAR_SELECT") {
  const lines = String(stdout ?? "").trim().split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length !== 1) {
    throw new Error(`GATE_FAILED:${label}_OUTPUT_SHAPE:expected one SELECT row, received ${lines.length}`);
  }
  return lines[0].trim();
}
