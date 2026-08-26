const SNAPSHOT_UPDATED_AT = "2026-08-05T08:00:00.000Z";

const TEST_ORDERS = [{
  order_code: "OPS-TEST-001",
  status: "delivering",
  current_warehouse_id: "WH-TEST",
  current_warehouse_name: "Kho kiểm thử",
  client_id: "CLIENT-TEST",
  created_date: "2026-08-03T06:00:00.000Z",
}];

/** Installs a bounded offline Rillnet fixture without intercepting other hosts. */
export function installRillnetFetchFixture(): void {
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("rillnet-app.vercel.app/api/gtalk-send")) {
      return Response.json({ liveUrl: "https://rillnet-fixture.local/api/opsfile", liveUpdated: SNAPSHOT_UPDATED_AT });
    }
    if (url.includes("rillnet-fixture.local/api/opsfile") || url.startsWith("/api/opsfile")) {
      return new Response(JSON.stringify(TEST_ORDERS), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("rillnet-app.vercel.app/wh_meta.json")) return Response.json({});
    return originalFetch(input, init);
  };
}
