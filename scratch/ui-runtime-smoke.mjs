const baseUrl = process.env.OPSPILOT_URL || "http://localhost:3003";
const route = process.env.OPSPILOT_SMOKE_ROUTE || "/dashboard";
const pageUrl = new URL(route, baseUrl);
const response = await fetch(pageUrl);
if (!response.ok) throw new Error(`UI page failed: ${response.status} ${pageUrl}`);
const html = await response.text();
const stylesheetUrls = [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["']/gi)].map((match) => new URL(match[1], baseUrl));
if (stylesheetUrls.length === 0) throw new Error(`No stylesheet links found at ${pageUrl}`);
for (const url of stylesheetUrls) {
  const stylesheet = await fetch(url);
  const contentType = stylesheet.headers.get("content-type") || "";
  if (!stylesheet.ok || !contentType.includes("text/css")) {
    throw new Error(`Stylesheet unavailable: ${stylesheet.status} ${contentType} ${url}`);
  }
  const css = await stylesheet.text();
  if (css.length < 1000) throw new Error(`Stylesheet unexpectedly small (${css.length} bytes): ${url}`);
}
console.log(JSON.stringify({ ok: true, page: pageUrl.toString(), stylesheets: stylesheetUrls.length }));
