// ==UserScript==
// @name         OpsPilot GHN Tracking Bridge
// @namespace    https://opspilot-tau-lyart.vercel.app/
// @version      2.3.0
// @description  Tra cứu lộ trình GHN trực tiếp cho OpsPilot mà không gửi token lên server.
// @author       OpsPilot
// @match        https://tracuunoibo.ghn.vn/*
// @match        https://nhanh.ghn.vn/*
// @match        https://opspilot-tau-lyart.vercel.app/*
// @downloadURL  https://opspilot-tau-lyart.vercel.app/ghn-bridge.user.js
// @updateURL    https://opspilot-tau-lyart.vercel.app/ghn-bridge.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @connect      fe-online-gateway.ghn.vn
// @connect      nhanh-api.ghn.vn
// @connect      rillnet-app.vercel.app
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  const TRACKING_TOKEN_KEY = "opspilot_ghn_tracking_token";
  const LASTMILE_TOKEN_KEY = "opspilot_ghn_lastmile_token";
  const AUTHORIZATION_KEY = "opspilot_ghn_lastmile_authorization";
  const ORDER_DETAIL_PREFIX = "opspilot_ghn_order_detail:";
  const ORDER_LOGS_ENDPOINT = "https://fe-online-gateway.ghn.vn/order-tracking/public-api/internal/order-logs";
  const META_ENDPOINT = "https://rillnet-app.vercel.app/wh_meta.json";
  const LASTMILE_API = "https://nhanh-api.ghn.vn";
  const LASTMILE_INGEST_PATH = "/api/integrations/ghn-lastmile/bridge";
  const LASTMILE_HUB_IDS = ["21156000", "21158000", "21160000", "21161000", "21321001", "23052000", "23064000", "23083000", "23084000"];
  const LASTMILE_POLL_INTERVAL_MS = 15 * 60 * 1000;
  const LASTMILE_REQUEST_DELAY_MS = 350;
  const ORDER_CODE_PATTERN = /^[A-Z0-9_-]{4,40}$/i;
  const BRIDGE_VERSION = "2.3.0";
  const STATUS_LABELS = {
    ready_to_pick: "Chờ lấy hàng", picking: "Đang lấy hàng", picked: "Đã lấy hàng",
    storing: "Đang lưu tại kho", transporting: "Đang trung chuyển", delivering: "Đang giao hàng",
    money_collect_delivering: "Đang giao và thu tiền", delivery_fail: "Giao hàng không thành công",
    delivered: "Đã giao hàng", success: "Đã giao hàng", returning: "Đang chuyển hoàn", returned: "Đã chuyển hoàn"
  };

  const isGhnPage = location.hostname === "tracuunoibo.ghn.vn" || location.hostname === "nhanh.ghn.vn";
  const isOpsPilot = location.hostname === "opspilot-tau-lyart.vercel.app";

  function normalizeToken(value) {
    return typeof value === "string" && value.trim().length >= 16 ? value.trim() : "";
  }

  if (isGhnPage) {
    const pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    let lastTrackingToken = "";
    let lastLastmileToken = "";
    let lastAuthorization = "";
    const rememberTrackingToken = (value) => {
      const token = normalizeToken(value);
      if (!token || token === lastTrackingToken) return;
      lastTrackingToken = token;
      GM_setValue(TRACKING_TOKEN_KEY, token);
      console.info("[OpsPilot GHN Bridge] GHN tracking session captured.");
    };
    const rememberLastmileToken = (value) => {
      const token = normalizeToken(value);
      if (!token || token === lastLastmileToken) return;
      lastLastmileToken = token;
      GM_setValue(LASTMILE_TOKEN_KEY, token);
      console.info("[OpsPilot GHN Bridge] GHN last-mile session captured.");
    };
    const rememberAuthorization = (value) => {
      const authorization = typeof value === "string" ? value.trim() : "";
      if (!authorization || authorization === lastAuthorization) return;
      lastAuthorization = authorization;
      GM_setValue(AUTHORIZATION_KEY, authorization);
      console.info("[OpsPilot GHN Bridge] GHN authorization captured.");
    };
    const readHeaders = (headers, hostname) => {
      if (!headers) return;
      const rememberToken = hostname === "fe-online-gateway.ghn.vn"
        ? rememberTrackingToken
        : hostname === "nhanh-api.ghn.vn"
          ? rememberLastmileToken
          : () => {};
      if (headers instanceof pageWindow.Headers) {
        rememberToken(headers.get("token"));
        if (hostname === "nhanh-api.ghn.vn") rememberAuthorization(headers.get("authorization"));
        return;
      }
      if (Array.isArray(headers)) {
        for (const pair of headers) {
          if (!Array.isArray(pair)) continue;
          if (/^token$/i.test(String(pair[0]))) rememberToken(pair[1]);
          if (hostname === "nhanh-api.ghn.vn" && /^authorization$/i.test(String(pair[0]))) rememberAuthorization(pair[1]);
        }
        return;
      }
      for (const key of Object.keys(headers)) {
        if (/^token$/i.test(key)) rememberToken(headers[key]);
        if (hostname === "nhanh-api.ghn.vn" && /^authorization$/i.test(key)) rememberAuthorization(headers[key]);
      }
    };

    const detailField = (value, keys) => {
      if (!value || typeof value !== "object") return null;
      for (const key of keys) if (text(value[key])) return text(value[key]);
      return null;
    };
    const labelKey = (value) => String(value || "").toLocaleLowerCase("vi").replace(/\s*:\s*$/, "").replace(/\s+/g, " ").trim();
    const detailValueFromPage = (source, label, stopLabels) => {
      const lines = String(source || "").split(/\n+/).map((line) => text(line)).filter(Boolean);
      const at = lines.findIndex((line) => labelKey(line).startsWith(labelKey(label)));
      if (at < 0) return null;
      const colonAt = lines[at].indexOf(":");
      const inline = colonAt >= 0 ? text(lines[at].slice(colonAt + 1)) : null;
      const candidate = inline || lines[at + 1] || null;
      return candidate && !stopLabels.some((stop) => labelKey(candidate).startsWith(labelKey(stop))) ? candidate : null;
    };
    const looksLikeOrderCode = (value) => Boolean(value && ORDER_CODE_PATTERN.test(value) && /[a-z]/i.test(value) && /\d/.test(value));
    const orderCodeFromPage = (pageText) => {
      const orderLabelMatch = String(pageText || "").match(/Mã\s*đơn\s*hàng\s*:?\s*([A-Z0-9_-]{4,40})/i);
      if (orderLabelMatch && looksLikeOrderCode(orderLabelMatch[1])) return orderLabelMatch[1].toUpperCase();
      const fromUrl = hintedOrderCode(location.href);
      if (looksLikeOrderCode(fromUrl)) return fromUrl.toUpperCase();
      const input = [...document.querySelectorAll("input")].map((element) => text(element.value)).find(looksLikeOrderCode);
      if (input) return input.toUpperCase();
      return null;
    };
    const recipientSectionFromPage = (pageText) => {
      const source = String(pageText || "");
      const at = source.toLocaleLowerCase("vi").indexOf("thông tin người nhận");
      return at >= 0 ? source.slice(at) : source;
    };
    const saveRecipient = async (orderCode, recipientName, recipientAddress, source) => {
      if (!orderCode || (!recipientName && !recipientAddress)) return false;
      const key = `${ORDER_DETAIL_PREFIX}${orderCode}`;
      const existing = await GM_getValue(key, null);
      await GM_setValue(key, {
        ...(existing && typeof existing === "object" ? existing : {}),
        ...(recipientName ? { recipientName } : {}),
        ...(recipientAddress ? { recipientAddress } : {}),
        capturedAt: new Date().toISOString(),
        source
      });
      return true;
    };
    const captureRecipientFromPage = async () => {
      const pageText = document.body && document.body.innerText;
      const orderCode = orderCodeFromPage(pageText);
      if (!orderCode || !pageText) return false;
      const recipientSection = recipientSectionFromPage(pageText);
      const recipientName = detailValueFromPage(recipientSection, "Họ và tên", ["Số điện thoại", "Địa chỉ", "Quận/Huyện"]);
      const recipientAddress = detailValueFromPage(recipientSection, "Địa chỉ", ["Quận/Huyện", "Phường/Xã", "Khu vực giao hàng"]);
      return await saveRecipient(orderCode, recipientName, recipientAddress, "ghn_order_detail_dom");
    };
    const saveOrderDetails = (value, hintedOrderCode) => {
      if (!value || typeof value !== "object") return;
      const candidates = [value, value.data, value.order, value.data && value.data.order].filter(Boolean);
      for (const candidate of candidates) {
        const orderCode = text(candidate.order_code) || text(candidate.orderCode) || hintedOrderCode;
        const recipientName = detailField(candidate, ["to_name", "recipient_name", "receiver_name", "consignee_name", "customer_name"]);
        const recipientAddress = detailField(candidate, ["to_address", "recipient_address", "receiver_address", "consignee_address", "address"]);
        if (orderCode && (recipientName || recipientAddress)) void saveRecipient(String(orderCode).trim().toUpperCase(), recipientName, recipientAddress, "ghn_order_detail_api");
      }
    };
    const hintedOrderCode = (input) => { try { const url = new URL(typeof input === "string" ? input : input.url, location.href); return text(url.searchParams.get("order_code")) || text(url.searchParams.get("orderCode")); } catch (_) { return null; } };
    const apiHostname = (input) => { try { return new URL(typeof input === "string" ? input : input.url, location.href).hostname; } catch (_) { return ""; } };
    const isSupportedApiHostname = (hostname) => hostname === "fe-online-gateway.ghn.vn" || hostname === "nhanh-api.ghn.vn";
    const observeJson = (response, code) => { try { response.clone().json().then((value) => saveOrderDetails(value, code)).catch(() => {}); } catch (_) {} };
    const originalFetch = pageWindow.fetch;
    if (typeof originalFetch === "function") {
      pageWindow.fetch = function (input, init) {
        try {
          const hostname = apiHostname(input);
          if (isSupportedApiHostname(hostname)) {
            readHeaders(init && init.headers, hostname);
            if (input && typeof input === "object") readHeaders(input.headers, hostname);
          }
        } catch (_) {}
        const code = hintedOrderCode(input);
        return originalFetch.apply(this, arguments).then((response) => { observeJson(response, code); return response; });
      };
    }

    const xhrPrototype = pageWindow.XMLHttpRequest && pageWindow.XMLHttpRequest.prototype;
    if (xhrPrototype) {
      const originalOpen = xhrPrototype.open;
      xhrPrototype.open = function (_method, url) { this.__opspilotOrderCode = hintedOrderCode(url); this.__opspilotRequestUrl = String(url || ""); return originalOpen.apply(this, arguments); };
      const originalSetRequestHeader = xhrPrototype.setRequestHeader;
      xhrPrototype.setRequestHeader = function (header, value) {
        const hostname = apiHostname(this.__opspilotRequestUrl);
        if (/^token$/i.test(String(header)) && hostname === "fe-online-gateway.ghn.vn") rememberTrackingToken(value);
        if (/^token$/i.test(String(header)) && hostname === "nhanh-api.ghn.vn") rememberLastmileToken(value);
        if (/^authorization$/i.test(String(header)) && hostname === "nhanh-api.ghn.vn") rememberAuthorization(value);
        return originalSetRequestHeader.apply(this, arguments);
      };
      const originalSend = xhrPrototype.send;
      xhrPrototype.send = function () {
        this.addEventListener("load", function () { try { saveOrderDetails(JSON.parse(this.responseText), this.__opspilotOrderCode); } catch (_) {} }, { once: true });
        return originalSend.apply(this, arguments);
      };
    }
    const observer = new MutationObserver(() => { void captureRecipientFromPage(); });
    if (document.documentElement) observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    let captureAttempts = 0;
    const captureTimer = window.setInterval(async () => {
      captureAttempts += 1;
      const captured = await captureRecipientFromPage();
      if (captured || captureAttempts >= 15) window.clearInterval(captureTimer);
    }, 2000);
    return;
  }

  if (!isOpsPilot) return;

  function gmRequest(options) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      ...options,
      timeout: 10000,
      onload: resolve,
      onerror: () => reject(new Error("GHN_NETWORK_ERROR")),
      ontimeout: () => reject(new Error("GHN_TIMEOUT"))
    }));
  }

  function text(value) {
    return value == null ? null : String(value).trim() || null;
  }

  function phaseFor(status) {
    if (status === "transporting" || status === "return_transporting") return "IN_TRANSIT";
    if (["delivering", "money_collect_delivering", "delivery_fail"].includes(status || "")) return "DELIVERING";
    if (["delivered", "success", "returned"].includes(status || "")) return "COMPLETED";
    return status ? "AT_WAREHOUSE" : "UNKNOWN";
  }

  async function fetchWarehouseDetails(ids) {
    if (!ids.length) return {};
    const details = {};
    try {
      const response = await fetch(`/api/warehouse-directory?ids=${encodeURIComponent(ids.join(","))}`, { cache: "no-store" });
      if (response.ok) {
        const payload = await response.json();
        Object.assign(details, payload && payload.warehouses ? payload.warehouses : {});
      }
    } catch (_) {}
    try {
      const response = await gmRequest({ method: "GET", url: META_ENDPOINT, headers: { accept: "application/json" } });
      if (response.status < 200 || response.status >= 300) return details;
      const metadata = JSON.parse(response.responseText);
      for (const id of ids) {
        if (details[id]) continue;
        const name = metadata[id] && (metadata[id].n || metadata[id].name);
        if (name) details[id] = { name, type: null };
      }
      return details;
    } catch (_) { return details; }
  }

  async function trackOrder(orderCode) {
    const token = normalizeToken(await GM_getValue(TRACKING_TOKEN_KEY, ""));
    if (!token) throw new Error("GHN_SESSION_NOT_FOUND");
    const url = `${ORDER_LOGS_ENDPOINT}?order_code=${encodeURIComponent(orderCode)}`;
    const response = await gmRequest({ method: "GET", url, headers: { accept: "application/json", token } });
    if (response.status === 401 || response.status === 403) throw new Error("GHN_SESSION_EXPIRED");
    if (response.status === 429) throw new Error("GHN_RATE_LIMITED");
    if (response.status < 200 || response.status >= 300) throw new Error(`GHN_HTTP_${response.status || "UNKNOWN"}`);
    let payload;
    try { payload = JSON.parse(response.responseText); } catch (_) { throw new Error("GHN_INVALID_RESPONSE"); }
    const entries = payload && payload.code === 200 && payload.data && Array.isArray(payload.data.data) ? payload.data.data : null;
    if (!entries) throw new Error("GHN_INVALID_RESPONSE");

    const chronological = entries.filter((entry) => entry && Number.isFinite(Date.parse(entry.created_at))).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    let status = null, currentWarehouseId = null, nextWarehouseId = null, pickWarehouseId = null, deliverWarehouseId = null, lastAction = null, lastEventAt = null, deliveryStartedAt = null, deliveryStartedAtInferred = false, endDeliveryAt = null, endSuccessAt = null;
    const journey = [];
    const ids = new Set();
    for (const entry of chronological) {
      const patch = entry.new_data || {};
      const action = text(patch.action) || text(patch.operation) || text(patch.event);
      const warehouseId = text(patch.current_warehouse_id);
      if (warehouseId && warehouseId !== currentWarehouseId) {
        journey.push({ warehouseId, arrivedAt: entry.created_at, arrivalAction: action || undefined });
        currentWarehouseId = warehouseId;
        ids.add(warehouseId);
      }
      if (action && ["TRANSFER_TO_TRUCK", "TRANSPORTING"].includes(action) && journey.length && !journey[journey.length - 1].departedAt) {
        journey[journey.length - 1].departedAt = entry.created_at;
        journey[journey.length - 1].departureAction = action;
      }
      const nextStatus = (text(patch.status) || text(patch.order_status) || text(patch.orderStatus) || text(patch.current_status) || "").toLowerCase() || null;
      const normalizedAction = (action || "").toUpperCase();
      if (!deliveryStartedAt && (["delivering", "money_collect_delivering"].includes(nextStatus || "") || /OUT_FOR_DELIVERY|DELIVERING|SHIPPER_ASSIGN|ASSIGN_SHIPPER/.test(normalizedAction))) {
        deliveryStartedAt = entry.created_at;
        deliveryStartedAtInferred = true;
      }
      if (["delivered", "success"].includes(nextStatus || "") || /DELIVERED|DELIVERY_SUCCESS|SUCCESS/.test(normalizedAction)) {
        endDeliveryAt ||= entry.created_at;
        endSuccessAt ||= entry.created_at;
      }
      status = nextStatus || status;
      nextWarehouseId = text(patch.next_warehouse_id) || nextWarehouseId;
      pickWarehouseId = text(patch.pick_warehouse_id) || pickWarehouseId;
      deliverWarehouseId = text(patch.deliver_warehouse_id) || deliverWarehouseId;
      lastAction = action || lastAction;
      lastEventAt = entry.created_at;
      for (const id of [nextWarehouseId, pickWarehouseId, deliverWarehouseId]) if (id) ids.add(id);
    }
    const warehouses = await fetchWarehouseDetails([...ids]);
    const recipient = await GM_getValue(`${ORDER_DETAIL_PREFIX}${orderCode}`, null);
    const nameFor = (id) => id ? (warehouses[id] && warehouses[id].name) || `Kho ${id}` : null;
    const phase = phaseFor(status);
    return {
      ok: true,
      source: "ghn_tampermonkey_bridge",
      orderCode,
      customerId: null,
      customerName: null,
      status,
      statusLabel: STATUS_LABELS[status] || status || "Chưa xác định",
      phase,
      currentWarehouseId,
      currentWarehouseName: nameFor(currentWarehouseId),
      nextWarehouseId,
      nextWarehouseName: nameFor(nextWarehouseId),
      pickWarehouseId,
      deliverWarehouseId,
      deliverWarehouseName: nameFor(deliverWarehouseId),
      deliverWarehouseType: deliverWarehouseId && warehouses[deliverWarehouseId] ? warehouses[deliverWarehouseId].type || null : null,
      lastAction,
      lastEventAt,
      checkedAt: new Date().toISOString(),
      deliveryStartedAt,
      deliveryStartedAtInferred,
      endDeliveryAt,
      endSuccessAt,
      recipientName: recipient && text(recipient.recipientName),
      recipientAddress: recipient && text(recipient.recipientAddress),
      journey: journey.map((point, index) => ({ ...point, warehouseName: nameFor(point.warehouseId), current: index === journey.length - 1 && phase !== "IN_TRANSIT" && phase !== "COMPLETED" }))
    };
  }

  const pause = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const safeCount = (value) => Number.isFinite(Number(value)) ? Math.max(0, Math.trunc(Number(value))) : 0;
  const localDateTime = (iso) => {
    const date = new Date(iso);
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
    const get = (type) => (parts.find((part) => part.type === type) || {}).value || "";
    return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
  };
  const scheduleDateRange = (iso) => {
    const local = localDateTime(iso);
    const localMidnightUtc = new Date(`${local.date}T00:00:00+07:00`).getTime();
    return {
      fromDate: new Date(localMidnightUtc - 3 * 24 * 60 * 60 * 1000).toISOString(),
      toDate: new Date(localMidnightUtc + 5 * 24 * 60 * 60 * 1000 - 1).toISOString()
    };
  };
  const withinShift = (time, shift) => {
    const start = text(shift && shift.start_at); const end = text(shift && shift.end_at);
    if (!/^\d{2}:\d{2}$/.test(start || "") || !/^\d{2}:\d{2}$/.test(end || "")) return false;
    return start <= end ? time >= start && time < end : time >= start || time < end;
  };
  async function lastmilePost(path, payload) {
    const token = normalizeToken(await GM_getValue(LASTMILE_TOKEN_KEY, ""))
      || normalizeToken(await GM_getValue(TRACKING_TOKEN_KEY, ""));
    if (!token) throw new Error("GHN_SESSION_NOT_FOUND");
    const authorization = String(await GM_getValue(AUTHORIZATION_KEY, "") || "").trim();
    if (!authorization) throw new Error("GHN_AUTHORIZATION_NOT_FOUND");
    const response = await gmRequest({ method: "POST", url: `${LASTMILE_API}${path}`, headers: { "content-type": "application/json", accept: "application/json", token, Authorization: authorization }, data: JSON.stringify(payload) });
    if (response.status === 401 || response.status === 403) throw new Error("GHN_SESSION_EXPIRED");
    if (response.status === 429) throw new Error("GHN_RATE_LIMITED");
    if (response.status < 200 || response.status >= 300) {
      let upstream = null;
      try {
        const parsed = JSON.parse(response.responseText);
        upstream = [text(parsed.errorCode) || text(parsed.code), text(parsed.message) || text(parsed.error)].filter(Boolean).join("-");
      } catch (_) {}
      throw new Error(`GHN_HTTP_${response.status || "UNKNOWN"}:${path}${upstream ? `:${upstream.slice(0, 120)}` : ""}`);
    }
    const body = JSON.parse(response.responseText);
    if (!body || (body.code != null && body.code !== 0) || body.status === "ERROR") throw new Error("GHN_INVALID_RESPONSE");
    return body;
  }
  async function collectTripItemsAggregate(tripCode) {
    let offset = 0, total = Infinity, successful = 0, returned = 0, cancelled = 0;
    const seen = new Set();
    while (offset < total) {
      const body = await lastmilePost("/api/lastmile/trip/get-trip-items", { typeList: ["PICK", "DELIVER", "RETURN"], offset, limit: 50, TripCode: tripCode });
      const rows = Array.isArray(body.data) ? body.data : [];
      total = safeCount(body.total);
      for (const row of rows) {
        const key = `${row.type || ""}:${row.orderCode || ""}`;
        if (!row.orderCode || seen.has(key)) continue;
        seen.add(key);
        if (row.type === "DELIVER" && row.isSucceeded === true) successful += 1;
        if (row.type === "RETURN" || row.isReturn === true) returned += 1;
        if (row.isCancel === true) cancelled += 1;
      }
      offset += rows.length;
      if (!rows.length) break;
      await pause(LASTMILE_REQUEST_DELAY_MS);
    }
    return { successful, returned, cancelled };
  }
  async function collectHubSnapshot(hubId) {
    const now = new Date(); const nowIso = now.toISOString(); const local = localDateTime(nowIso);
    const range = scheduleDateRange(nowIso);
    const schedules = await lastmilePost("/api/sop/user-schedule/get-user-schedules-by-hub", { hub_id: hubId, from_date: range.fromDate, to_date: range.toDate });
    await pause(LASTMILE_REQUEST_DELAY_MS);
    const tripBody = await lastmilePost("/api/lastmile/trip/get-trip-list-by-hub", { hub_id: hubId, status: "ON_TRIP", is_ready: 0, offset: 0, limit: 100, reverse: 1, page: 1, size: 100 });
    const trips = (Array.isArray(tripBody.data) ? tripBody.data : []).filter((trip) => String(trip.hubId) === hubId && trip.status === "ON_TRIP");
    const weekdays = schedules.data && Array.isArray(schedules.data.weekdays) ? schedules.data.weekdays : [];
    const dateLabel = (weekdays.find((day) => localDateTime(day.date).date === local.date) || {}).value;
    const scheduled = new Set(), activeScheduled = new Set(), onLeave = new Set();
    for (const user of schedules.data && Array.isArray(schedules.data.users) ? schedules.data.users : []) {
      const userId = text(user.user_id); const schedule = (user.schedules || []).find((item) => item.date === dateLabel);
      const shifts = schedule && Array.isArray(schedule.shifts) ? schedule.shifts : [];
      const working = shifts.filter((shift) => shift.is_on_leave !== true);
      if (userId && working.length) scheduled.add(userId);
      if (userId && working.some((shift) => withinShift(local.time, shift))) activeScheduled.add(userId);
      if (userId && shifts.length && !working.length) onLeave.add(userId);
    }
    const activeDrivers = new Set(trips.map((trip) => text(trip.driverId)).filter(Boolean));
    let successful = 0, returned = 0, cancelled = 0;
    for (const trip of trips) {
      const aggregate = await collectTripItemsAggregate(String(trip.tripCode));
      successful += aggregate.successful; returned += aggregate.returned; cancelled += aggregate.cancelled;
      await pause(LASTMILE_REQUEST_DELAY_MS);
    }
    const assigned = trips.reduce((sum, trip) => sum + safeCount(trip.deliverCount), 0);
    return {
      hubId,
      sourceFetchedAt: nowIso,
      staffing: { hubId, scheduleDate: local.date, scheduledForDayCount: scheduled.size, currentlyScheduledWorkforceCount: activeScheduled.size, onLeaveCount: onLeave.size, activeDriverCount: activeDrivers.size, scheduledActiveDriverCount: [...activeDrivers].filter((id) => activeScheduled.has(id)).length, unscheduledActiveDriverCount: [...activeDrivers].filter((id) => !activeScheduled.has(id)).length, sourceFetchedAt: nowIso },
      workload: { hubId, activeTripCount: trips.length, activeDriverCount: activeDrivers.size, assignedDeliveryCount: assigned, successfulDeliveryCount: Math.min(successful, assigned), pendingDeliveryCount: Math.max(0, assigned - successful), returnCount: returned, cancelledCount: cancelled, latestSourceUpdatedAt: trips.map((trip) => trip.lastUpdatedTime).filter(Boolean).sort().at(-1) || null, sourceFetchedAt: nowIso }
    };
  }
  let lastmileCollectionRunning = false;
  const reportLastmileStatus = (stage, detail = {}) => {
    const payload = { version: BRIDGE_VERSION, stage, at: new Date().toISOString(), ...detail };
    console.info("[OpsPilot GHN Bridge]", payload);
    window.dispatchEvent(new CustomEvent("GHN_LASTMILE_STATUS", { detail: payload }));
  };
  async function collectAllowedHubs() {
    if (lastmileCollectionRunning) {
      reportLastmileStatus("ALREADY_RUNNING");
      return;
    }
    lastmileCollectionRunning = true;
    try {
      const token = normalizeToken(await GM_getValue(LASTMILE_TOKEN_KEY, ""))
        || normalizeToken(await GM_getValue(TRACKING_TOKEN_KEY, ""));
      if (!token) {
        reportLastmileStatus("NO_GHN_SESSION", { message: "Reload nhanh.ghn.vn and perform one data refresh, then retry." });
        return;
      }
      const authorization = String(await GM_getValue(AUTHORIZATION_KEY, "") || "").trim();
      if (!authorization) {
        reportLastmileStatus("NO_GHN_AUTHORIZATION", { message: "Reload nhanh.ghn.vn and perform one data refresh, then retry." });
        return;
      }
      reportLastmileStatus("STARTED", { hubCount: LASTMILE_HUB_IDS.length });
      const snapshots = [];
      for (const hubId of LASTMILE_HUB_IDS) {
        try {
          snapshots.push(await collectHubSnapshot(hubId));
          reportLastmileStatus("HUB_COLLECTED", { hubId });
        } catch (error) {
          reportLastmileStatus("HUB_FAILED", { hubId, error: error instanceof Error ? error.message : "UNKNOWN_ERROR" });
        }
        await pause(LASTMILE_REQUEST_DELAY_MS);
      }
      if (!snapshots.length) {
        reportLastmileStatus("NO_SNAPSHOTS");
        return;
      }
      const response = await fetch(LASTMILE_INGEST_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "ghn_tampermonkey_lastmile", snapshots }) });
      reportLastmileStatus(response.ok ? "COMPLETED" : "INGEST_FAILED", { status: response.status, snapshotCount: snapshots.length });
    } catch (error) {
      reportLastmileStatus("FAILED", { error: error instanceof Error ? error.message : "UNKNOWN_ERROR" });
    } finally { lastmileCollectionRunning = false; }
  }
  window.addEventListener("GHN_LASTMILE_COLLECT", () => { void collectAllowedHubs(); });
  window.setTimeout(() => { void collectAllowedHubs(); }, 15_000);
  window.setInterval(() => { void collectAllowedHubs(); }, LASTMILE_POLL_INTERVAL_MS);

  function respond(requestId, detail) {
    window.dispatchEvent(new CustomEvent(`GHN_ORDER_TRACKING_RESPONSE_${requestId}`, { detail }));
  }

  window.addEventListener("GHN_BRIDGE_PING", () => window.dispatchEvent(new CustomEvent("GHN_BRIDGE_READY", { detail: { version: BRIDGE_VERSION } })));
  window.addEventListener("GHN_ORDER_TRACKING_REQUEST", async (event) => {
    const detail = event && event.detail;
    const requestId = detail && typeof detail.requestId === "string" ? detail.requestId : "";
    const orderCode = detail && typeof detail.orderCode === "string" ? detail.orderCode.trim().toUpperCase() : "";
    if (!requestId || !ORDER_CODE_PATTERN.test(orderCode)) return respond(requestId || "invalid", { error: "INVALID_ORDER_CODE" });
    try {
      respond(requestId, await trackOrder(orderCode));
    } catch (error) {
      respond(requestId, { error: error instanceof Error ? error.message : "GHN_BRIDGE_ERROR" });
    }
  });
  window.dispatchEvent(new CustomEvent("GHN_BRIDGE_READY", { detail: { version: BRIDGE_VERSION } }));
})();
