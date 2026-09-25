import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";

const GENERATION_ID = "9761bdc2-baff-46f1-9456-f881284663fb";
const BATCH_SIZE = 100;
const MANIFEST_PAGE_SIZE = 500;
const MEMBER_GENERATION_TABLE = "followup_case_member_generations";
const SELECT_COLUMNS = "followup_case_id,generation_id,source_sync_run_id,expected_member_count,generation_status";

function fail(code, detail = "") {
  throw new Error(code + (detail ? ": " + detail : ""));
}

function check(condition, code, detail = "") {
  if (!condition) fail(code, detail);
  console.log(code + "=PASS" + (detail ? " (" + detail + ")" : ""));
}

function scrub(value, secrets = []) {
  let text = String(value ?? "");
  for (const secret of secrets) {
    if (secret) text = text.replaceAll(secret, "[REDACTED]");
  }
  return text
    .replace(/https?:\/\/\S+/gi, "[REDACTED_URL]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\bapikey\s*[:=]\s*[^,\s;]+/gi, "apikey=[REDACTED]")
    .replace(/\bAuthorization\s*[:=]\s*(?:Bearer\s+)?[^,\s;]+/gi, "Authorization=[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 1500);
}

function projectRefFromServiceKey(token) {
  const pieces = token.split(".");
  if (pieces.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(pieces[1], "base64url").toString("utf8"));
    return claims.role === "service_role" ? claims.ref ?? null : null;
  } catch {
    return null;
  }
}

function verifyProductionIdentity() {
  const expectedRef = process.env.EXPECTED_PRODUCTION_REF;
  const rejectedRef = process.env.REJECTED_SHADOW_REF;
  const rawUrl = process.env.SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  let apiUrl;
  try {
    apiUrl = new URL(rawUrl);
  } catch {
    fail("PRODUCTION_API_IDENTITY", "Production URL is invalid");
  }

  if (expectedRef !== "elwnbwimgzijuelfjdsq" || rejectedRef !== "qkrpbompjwxfpicjfoub") {
    fail("PROJECT_REFS_UNEXPECTED");
  }
  const expectedHost = expectedRef + ".supabase.co";
  const rejectedHost = rejectedRef + ".supabase.co";
  const host = apiUrl.hostname.toLowerCase();
  if (host === rejectedHost || host.includes(rejectedRef)) fail("SHADOW_PROJECT_REJECTED");
  if (apiUrl.protocol !== "https:" || host !== expectedHost || apiUrl.pathname !== "/" || apiUrl.search || apiUrl.hash) {
    fail("PRODUCTION_API_IDENTITY", "URL is not the expected Production project");
  }
  if (!key) fail("PRODUCTION_SERVICE_ROLE_KEY_MISSING");
  const keyRef = projectRefFromServiceKey(key);
  if (keyRef && keyRef !== expectedRef) fail("PRODUCTION_SERVICE_KEY_IDENTITY", "key belongs to another project");

  console.log("PRODUCTION_IDENTITY=PASS (" + expectedRef + "; Shadow " + rejectedRef + " rejected)");
  return { baseUrl: apiUrl.origin, serviceKey: key };
}

function restHeaders(serviceKey, extraHeaders = {}) {
  return {
    apikey: serviceKey,
    Authorization: "Bearer " + serviceKey,
    Accept: "application/json",
    ...extraHeaders,
  };
}

async function requestGet(url, serviceKey, extraHeaders = {}) {
  return fetch(url, {
    method: "GET",
    headers: restHeaders(serviceKey, extraHeaders),
    redirect: "error",
  });
}

function buildRestUrl(baseUrl, table) {
  const normalizedBase = String(baseUrl).replace(/\/+$/, "");
  return new URL(normalizedBase + "/rest/v1/" + table);
}

function postgrestErrorFromBody(body, secrets) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { code: null, message: scrub(body, secrets), details: null, hint: null };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { code: null, message: "Unexpected JSON error response shape", details: null, hint: null };
  }
  return {
    code: parsed.code == null ? null : scrub(parsed.code, secrets),
    message: parsed.message == null ? "PostgREST error response omitted message" : scrub(parsed.message, secrets),
    details: parsed.details == null ? null : scrub(parsed.details, secrets),
    hint: parsed.hint == null ? null : scrub(parsed.hint, secrets),
  };
}

function httpError(response, body, secrets) {
  return "HTTP " + response.status + " " + scrub(response.statusText, secrets) + " " +
    JSON.stringify(postgrestErrorFromBody(body, secrets));
}

function parseJsonArray(body, label) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    fail(label + "_JSON_PARSE", "response was not valid JSON");
  }
  if (!Array.isArray(parsed)) fail(label + "_RESPONSE_SHAPE", "expected a JSON array");
  return parsed;
}

function parseContentRange(value, label) {
  const match = /^(\*|(\d+)-(\d+))\/(\d+|\*)$/.exec(String(value || "").trim());
  if (!match || match[4] === "*") fail(label + "_CONTENT_RANGE", "exact Content-Range total is unavailable");
  const total = Number(match[4]);
  if (!Number.isSafeInteger(total) || total < 0) fail(label + "_CONTENT_RANGE", "invalid exact total");
  if (match[1] === "*") return { start: null, end: null, total };
  const start = Number(match[2]);
  const end = Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) {
    fail(label + "_CONTENT_RANGE", "invalid returned range");
  }
  return { start, end, total };
}

async function fetchManifestInventory(baseUrl, serviceKey) {
  const secrets = [serviceKey, baseUrl];
  const manifests = [];
  let offset = 0;
  let total = null;
  let pageCount = 0;

  while (true) {
    const url = buildRestUrl(baseUrl, MEMBER_GENERATION_TABLE);
    url.searchParams.set("select", SELECT_COLUMNS);
    url.searchParams.set("generation_id", "eq." + GENERATION_ID);
    url.searchParams.set("order", "followup_case_id.asc,generation_id.asc,source_sync_run_id.asc.nullsfirst,expected_member_count.asc.nullsfirst,generation_status.asc");
    url.searchParams.set("limit", String(MANIFEST_PAGE_SIZE));

    let response;
    let body;
    try {
      response = await requestGet(url, serviceKey, {
        Prefer: "count=exact",
        "Range-Unit": "items",
        Range: offset + "-" + (offset + MANIFEST_PAGE_SIZE - 1),
      });
      body = await response.text();
    } catch (error) {
      fail("MANIFEST_PAGE_FETCH_FAILED", scrub(error?.message || error, secrets));
    }
    if (!response.ok) fail("MANIFEST_PAGE_QUERY_FAILED", httpError(response, body, secrets));

    const range = parseContentRange(response.headers.get("content-range"), "MANIFEST_PAGE");
    const page = parseJsonArray(body, "MANIFEST_PAGE");
    if (page.length > MANIFEST_PAGE_SIZE) fail("MANIFEST_PAGE_BOUND", "server returned more rows than requested");
    if (total === null) total = range.total;
    else if (range.total !== total) fail("MANIFEST_TOTAL_CHANGED", "exact total changed during pagination");

    if (range.total === 0) {
      if (range.start !== null || page.length !== 0) fail("MANIFEST_EMPTY_RANGE", "unexpected rows for an empty result");
      break;
    }
    if (range.start !== offset) fail("MANIFEST_PAGE_OFFSET", "server returned an unexpected range start");
    if (range.end - range.start + 1 !== page.length) fail("MANIFEST_PAGE_SHAPE", "Content-Range does not match returned rows");
    if (page.length === 0) fail("MANIFEST_PAGE_NO_PROGRESS", "pagination stopped before reaching the exact total");

    manifests.push(...page);
    pageCount += 1;
    offset += page.length;
    if (offset > total) fail("MANIFEST_PAGE_OVERFLOW", "received more rows than the exact total");
    if (offset === total) break;
  }

  if (manifests.length !== total) fail("MANIFEST_INVENTORY_INCOMPLETE", "received row count did not match the exact total");
  return { manifests, total, pageCount };
}

function summarizeManifest(manifests) {
  const caseIds = [];
  const caseIdSet = new Set();
  const sourceSyncRunIds = new Set();
  let duplicateCaseIds = 0;
  let expectedMemberTotal = 0;
  let preparingCount = 0;
  let committedCount = 0;
  let otherStatusCount = 0;
  let nullSourceSyncRunIds = 0;
  let sourceSyncRunMismatchCount = 0;
  let generationMismatchCount = 0;

  for (const row of manifests) {
    const caseId = row.followup_case_id;
    if (typeof caseId !== "string" || caseId.length === 0) fail("MANIFEST_CASE_ID_INVALID");
    caseIds.push(caseId);
    if (caseIdSet.has(caseId)) duplicateCaseIds += 1;
    else caseIdSet.add(caseId);

    const expected = Number(row.expected_member_count);
    if (!Number.isSafeInteger(expected) || expected < 0) fail("MANIFEST_EXPECTED_MEMBER_COUNT_INVALID");
    expectedMemberTotal += expected;
    if (!Number.isSafeInteger(expectedMemberTotal)) fail("MANIFEST_EXPECTED_MEMBER_TOTAL_OVERFLOW");

    if (row.generation_status === "PREPARING") preparingCount += 1;
    else if (row.generation_status === "COMMITTED") committedCount += 1;
    else otherStatusCount += 1;

    if (row.generation_id == null || String(row.generation_id).toLowerCase() !== GENERATION_ID) {
      generationMismatchCount += 1;
    }

    if (row.source_sync_run_id == null) {
      nullSourceSyncRunIds += 1;
    } else {
      const syncRunId = String(row.source_sync_run_id);
      sourceSyncRunIds.add(syncRunId);
      if (syncRunId.toLowerCase() !== String(row.generation_id || "").toLowerCase()) {
        sourceSyncRunMismatchCount += 1;
      }
    }
  }

  const orderedCaseIds = [...caseIdSet].sort();
  const caseIdSha256 = createHash("sha256").update(orderedCaseIds.join("\n"), "utf8").digest("hex");
  return {
    caseIds: orderedCaseIds,
    caseIdCount: orderedCaseIds.length,
    duplicateCaseIds,
    expectedMemberTotal,
    preparingCount,
    committedCount,
    otherStatusCount,
    generationMismatchCount,
    sourceSyncRunIds,
    sourceSyncRunConsistency: {
      distinctSourceSyncRunIds: sourceSyncRunIds.size,
      nullSourceSyncRunIds,
      sourceSyncRunIdMismatchCount,
      sourceSyncRunIdsMatchGeneration: manifests.length > 0 && sourceSyncRunMismatchCount === 0 && generationMismatchCount === 0,
    },
    approximateRawIdListBytes: Buffer.byteLength(orderedCaseIds.join(","), "utf8"),
    caseIdSha256,
  };
}

async function fetchExactCount(baseUrl, serviceKey, table, filters, selectColumn, label) {
  const secrets = [serviceKey, baseUrl];
  const url = buildRestUrl(baseUrl, table);
  url.searchParams.set("select", selectColumn);
  for (const [name, value] of Object.entries(filters)) url.searchParams.set(name, value);

  let response;
  let body;
  try {
    response = await requestGet(url, serviceKey, {
      Prefer: "count=exact",
      "Range-Unit": "items",
      Range: "0-0",
    });
    body = await response.text();
  } catch (error) {
    fail(label + "_FETCH_FAILED", scrub(error?.message || error, secrets));
  }

  if (response.status === 416) {
    const emptyRange = parseContentRange(response.headers.get("content-range"), label);
    if (emptyRange.total === 0) return 0;
  }
  if (!response.ok) fail(label + "_QUERY_FAILED", httpError(response, body, secrets));

  const range = parseContentRange(response.headers.get("content-range"), label);
  const rows = parseJsonArray(body, label);
  if (rows.length > 1) fail(label + "_ROW_BOUND", "count request returned more than one row");
  if (range.total === 0) {
    if (rows.length !== 0) fail(label + "_ROW_COUNT_MISMATCH", "zero total returned a row");
    return 0;
  }
  if (range.start !== 0 || range.end !== 0 || rows.length !== 1) {
    fail(label + "_ROW_COUNT_MISMATCH", "count request did not return exactly the bounded first row");
  }
  return range.total;
}

async function countReferencedSyncRuns(baseUrl, serviceKey, syncRunIds) {
  const ids = [...syncRunIds];
  let found = 0;
  for (let start = 0; start < ids.length; start += BATCH_SIZE) {
    const chunk = ids.slice(start, start + BATCH_SIZE);
    found += await fetchExactCount(
      baseUrl,
      serviceKey,
      "sync_runs",
      { id: "in.(" + chunk.join(",") + ")" },
      "id",
      "SOURCE_SYNC_RUN_REFERENCES"
    );
  }
  return found;
}

async function verifyManifestQuery(baseUrl, serviceKey, ids, label) {
  let requestUrlLength = null;
  const secrets = [serviceKey, baseUrl];
  try {
    const url = buildRestUrl(baseUrl, MEMBER_GENERATION_TABLE);
    url.searchParams.set("select", SELECT_COLUMNS);
    url.searchParams.set("generation_id", "eq." + GENERATION_ID);
    url.searchParams.set("followup_case_id", "in.(" + ids.join(",") + ")");
    requestUrlLength = Buffer.byteLength(url.toString(), "utf8");

    const response = await requestGet(url, serviceKey);
    const body = await response.text();
    if (!response.ok) {
      return {
        label,
        httpStatus: response.status,
        statusText: scrub(response.statusText, secrets),
        requestUrlLength,
        rows: 0,
        error: postgrestErrorFromBody(body, secrets),
      };
    }

    let rows;
    try {
      rows = JSON.parse(body);
    } catch {
      return {
        label,
        httpStatus: response.status,
        statusText: scrub(response.statusText, secrets),
        requestUrlLength,
        rows: 0,
        error: { code: null, message: "Response was not valid JSON", details: null, hint: null },
      };
    }
    if (!Array.isArray(rows)) {
      return {
        label,
        httpStatus: response.status,
        statusText: scrub(response.statusText, secrets),
        requestUrlLength,
        rows: 0,
        error: { code: null, message: "Expected a JSON array response", details: null, hint: null },
      };
    }
    return {
      label,
      httpStatus: response.status,
      statusText: scrub(response.statusText, secrets),
      requestUrlLength,
      rows: rows.length,
      error: null,
    };
  } catch (error) {
    return {
      label,
      httpStatus: null,
      statusText: null,
      requestUrlLength,
      rows: 0,
      error: { code: null, message: scrub(error?.message || error, secrets), details: null, hint: null },
    };
  }
}

function writeStepSummary(lines) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (path) appendFileSync(path, lines.join("\n") + "\n");
}

async function main() {
  const identity = verifyProductionIdentity();
  const inventory = await fetchManifestInventory(identity.baseUrl, identity.serviceKey);
  const manifests = inventory.manifests;
  const summary = summarizeManifest(manifests);

  let referencedSyncRunsFound = null;
  let sourceSyncRunReferenceError = null;
  try {
    referencedSyncRunsFound = await countReferencedSyncRuns(
      identity.baseUrl,
      identity.serviceKey,
      summary.sourceSyncRunIds
    );
  } catch (error) {
    sourceSyncRunReferenceError = scrub(error?.message || error, [identity.serviceKey, identity.baseUrl]);
  }
  const sourceSyncRunConsistency = {
    ...summary.sourceSyncRunConsistency,
    referencedSyncRunRowsFound: referencedSyncRunsFound,
    referenceReadError: sourceSyncRunReferenceError,
  };

  const memberRows = await fetchExactCount(
    identity.baseUrl,
    identity.serviceKey,
    "followup_case_members",
    { generation_id: "eq." + GENERATION_ID },
    "generation_id",
    "MEMBER_ROWS"
  );
  const pointerCount = await fetchExactCount(
    identity.baseUrl,
    identity.serviceKey,
    "followup_cases",
    { member_generation_id: "eq." + GENERATION_ID },
    "member_generation_id",
    "POINTERS_TO_FAILED_GENERATION"
  );

  console.log("MANIFEST_COUNT=" + inventory.total);
  console.log("MANIFEST_PAGE_COUNT=" + inventory.pageCount);
  console.log("EXPECTED_MEMBER_TOTAL=" + summary.expectedMemberTotal);
  console.log("MEMBER_ROWS=" + memberRows);
  console.log("POINTERS_TO_FAILED_GENERATION=" + pointerCount);
  console.log("CASE_ID_COUNT=" + summary.caseIdCount);
  console.log("DUPLICATE_CASE_IDS=" + summary.duplicateCaseIds);
  console.log("MANIFEST_STATUS_COUNTS=" + JSON.stringify({
    PREPARING: summary.preparingCount,
    COMMITTED: summary.committedCount,
    OTHER: summary.otherStatusCount,
  }));
  console.log("MANIFEST_GENERATION_MISMATCH_COUNT=" + summary.generationMismatchCount);
  console.log("SOURCE_SYNC_RUN_CONSISTENCY=" + JSON.stringify(sourceSyncRunConsistency));
  console.log("CASE_ID_SHA256=" + summary.caseIdSha256);
  console.log("APPROX_RAW_ID_LIST_BYTES=" + summary.approximateRawIdListBytes);

  const unbatched = summary.caseIds.length
    ? await verifyManifestQuery(identity.baseUrl, identity.serviceKey, summary.caseIds, "unbatched")
    : null;
  const batches = [];
  for (let start = 0; start < summary.caseIds.length; start += BATCH_SIZE) {
    batches.push(await verifyManifestQuery(
      identity.baseUrl,
      identity.serviceKey,
      summary.caseIds.slice(start, start + BATCH_SIZE),
      "batch-" + batches.length
    ));
  }

  const batchRows = batches.reduce((sum, batch) => sum + batch.rows, 0);
  const batchErrors = batches.filter((batch) => batch.error);
  const batchedPass = batchErrors.length === 0 && batchRows === inventory.total;
  const rootCauseConfirmed = unbatched?.httpStatus === 400 && batchedPass && batchRows === inventory.total;

  console.log("UNBATCHED_HTTP_STATUS=" + (unbatched?.httpStatus ?? (summary.caseIds.length ? "NO_RESPONSE" : "NO_CASE_IDS")));
  console.log("UNBATCHED_STATUS_TEXT=" + (scrub(unbatched?.statusText) || "UNKNOWN"));
  console.log("UNBATCHED_ERROR_CODE=" + (unbatched?.error?.code ?? "NONE"));
  console.log("UNBATCHED_ERROR_MESSAGE=" + (unbatched?.error?.message ?? "NONE"));
  console.log("UNBATCHED_ERROR_DETAILS=" + (unbatched?.error?.details ?? "NONE"));
  console.log("UNBATCHED_ERROR_HINT=" + (unbatched?.error?.hint ?? "NONE"));
  console.log("UNBATCHED_REQUEST_URL_LENGTH=" + (unbatched?.requestUrlLength ?? "UNAVAILABLE"));
  console.log("UNBATCHED_ROWS_RETURNED=" + (unbatched?.rows ?? 0));
  console.log("BATCH_COUNT=" + batches.length);
  console.log("MAX_BATCH_URL_LENGTH=" + batches.reduce((max, batch) => Math.max(max, batch.requestUrlLength || 0), 0));
  console.log("BATCHED_TOTAL_ROWS=" + batchRows);
  console.log("BATCHED_STATUS=" + (batchedPass ? "PASS" : "FAIL"));
  console.log("ANY_BATCH_ERROR=" + (batchErrors.length ? JSON.stringify(batchErrors[0].error) : "NONE"));
  console.log("ROOT_CAUSE_CONFIRMED=" + (rootCauseConfirmed ? "YES" : "NO"));
  console.log("ROOT_CAUSE=" + (rootCauseConfirmed
    ? "The manifest verification step encoded the full Production case set into one unbounded PostgREST IN filter. At this cardinality that request was rejected before member persistence began."
    : "Not confirmed by the required unbatched-versus-batched comparison."));
  if (unbatched && !unbatched.error) console.log("NEXT_SUSPECT=first member upsert");

  writeStepSummary([
    "## Production follow-up forensic (REST GET only)",
    "- Production identity: **PASS** (" + process.env.EXPECTED_PRODUCTION_REF + ")",
    "- Manifests / expected members: **" + inventory.total + " / " + summary.expectedMemberTotal + "**",
    "- Members / pointers: **" + memberRows + " / " + pointerCount + "**",
    "- Case IDs / duplicates: **" + summary.caseIdCount + " / " + summary.duplicateCaseIds + "**",
    "- Unbatched GET: HTTP **" + (unbatched?.httpStatus ?? "NO_RESPONSE") + "**, URL bytes **" + (unbatched?.requestUrlLength ?? "unavailable") + "**, rows **" + (unbatched?.rows ?? 0) + "**",
    "- Batched GET: **" + batches.length + "** requests, **" + batchRows + "** rows, **" + (batchedPass ? "PASS" : "FAIL") + "**",
    "- Root cause confirmed: **" + (rootCauseConfirmed ? "YES" : "NO") + "**",
  ]);
}

main().catch((error) => {
  console.error(scrub(error?.message || error, [
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.SUPABASE_URL,
  ]));
  process.exitCode = 1;
});
