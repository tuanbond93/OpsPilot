// ==UserScript==
// @name         OpsPilot GHN Tracking Bridge
// @namespace    https://opspilot-tau-lyart.vercel.app/
// @version      1.7.0
// @description  Tra cứu lộ trình GHN trực tiếp cho OpsPilot mà không gửi token lên server.
// @author       OpsPilot
// @match        https://tracuunoibo.ghn.vn/*
// @match        https://nhanh.ghn.vn/*
// @match        https://opspilot-tau-lyart.vercel.app/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @connect      fe-online-gateway.ghn.vn
// @connect      rillnet-app.vercel.app
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  const TOKEN_KEY = "opspilot_ghn_tracking_token";
  const ORDER_DETAIL_PREFIX = "opspilot_ghn_order_detail:";
  const ORDER_LOGS_ENDPOINT = "https://fe-online-gateway.ghn.vn/order-tracking/public-api/internal/order-logs";
  const META_ENDPOINT = "https://rillnet-app.vercel.app/wh_meta.json";
  const ORDER_CODE_PATTERN = /^[A-Z0-9_-]{4,40}$/i;
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
    let lastToken = "";
    const remember = (value) => {
      const token = normalizeToken(value);
      if (!token || token === lastToken) return;
      lastToken = token;
      GM_setValue(TOKEN_KEY, token);
    };
    const readHeaders = (headers) => {
      if (!headers) return;
      if (headers instanceof pageWindow.Headers) {
        remember(headers.get("token") || headers.get("authorization") || headers.get("x-auth-token"));
        return;
      }
      if (Array.isArray(headers)) {
        for (const pair of headers) if (Array.isArray(pair) && /^(token|authorization|x-auth-token)$/i.test(String(pair[0]))) remember(pair[1]);
        return;
      }
      for (const key of Object.keys(headers)) if (/^(token|authorization|x-auth-token)$/i.test(key)) remember(headers[key]);
    };

    const detailField = (value, keys) => {
      if (!value || typeof value !== "object") return null;
      for (const key of keys) if (text(value[key])) return text(value[key]);
      return null;
    };
    const saveOrderDetails = (value, hintedOrderCode) => {
      if (!value || typeof value !== "object") return;
      const candidates = [value, value.data, value.order, value.data && value.data.order].filter(Boolean);
      for (const candidate of candidates) {
        const orderCode = text(candidate.order_code) || text(candidate.orderCode) || hintedOrderCode;
        const recipientName = detailField(candidate, ["to_name", "recipient_name", "receiver_name", "consignee_name", "customer_name"]);
        const recipientAddress = detailField(candidate, ["to_address", "recipient_address", "receiver_address", "consignee_address", "address"]);
        if (orderCode && recipientName && recipientAddress) GM_setValue(`${ORDER_DETAIL_PREFIX}${String(orderCode).trim().toUpperCase()}`, { recipientName, recipientAddress, capturedAt: new Date().toISOString() });
      }
    };
    const hintedOrderCode = (input) => { try { const url = new URL(typeof input === "string" ? input : input.url, location.href); return text(url.searchParams.get("order_code")) || text(url.searchParams.get("orderCode")); } catch (_) { return null; } };
    const observeJson = (response, code) => { try { response.clone().json().then((value) => saveOrderDetails(value, code)).catch(() => {}); } catch (_) {} };
    const originalFetch = pageWindow.fetch;
    if (typeof originalFetch === "function") {
      pageWindow.fetch = function (input, init) {
        try {
          readHeaders(init && init.headers);
          if (input && typeof input === "object") readHeaders(input.headers);
        } catch (_) {}
        const code = hintedOrderCode(input);
        return originalFetch.apply(this, arguments).then((response) => { observeJson(response, code); return response; });
      };
    }

    const xhrPrototype = pageWindow.XMLHttpRequest && pageWindow.XMLHttpRequest.prototype;
    if (xhrPrototype) {
      const originalOpen = xhrPrototype.open;
      xhrPrototype.open = function (_method, url) { this.__opspilotOrderCode = hintedOrderCode(url); return originalOpen.apply(this, arguments); };
      const originalSetRequestHeader = xhrPrototype.setRequestHeader;
      xhrPrototype.setRequestHeader = function (header, value) {
        if (/^(token|authorization|x-auth-token)$/i.test(String(header))) remember(value);
        return originalSetRequestHeader.apply(this, arguments);
      };
      const originalSend = xhrPrototype.send;
      xhrPrototype.send = function () {
        this.addEventListener("load", function () { try { saveOrderDetails(JSON.parse(this.responseText), this.__opspilotOrderCode); } catch (_) {} }, { once: true });
        return originalSend.apply(this, arguments);
      };
    }
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
    const token = normalizeToken(await GM_getValue(TOKEN_KEY, ""));
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

  function respond(requestId, detail) {
    window.dispatchEvent(new CustomEvent(`GHN_ORDER_TRACKING_RESPONSE_${requestId}`, { detail }));
  }

  window.addEventListener("GHN_BRIDGE_PING", () => window.dispatchEvent(new CustomEvent("GHN_BRIDGE_READY", { detail: { version: "1.5.0" } })));
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
  window.dispatchEvent(new CustomEvent("GHN_BRIDGE_READY", { detail: { version: "1.5.0" } }));
})();
