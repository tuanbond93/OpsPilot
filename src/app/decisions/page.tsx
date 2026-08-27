"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Check, CircleAlert, Eye, Plus, RefreshCw, X } from "lucide-react";
import type { Decision } from "@/domain/decision";
import type { ExecutionWorkOrder } from "@/domain/execution-work-order";
import { repairOperationalText, translateStatus } from "@/app/_components/operationalText";
import { createClient } from "@/lib/supabase/client";
import { roleCan, roleFromMetadata, type OpsRole } from "@/security/roles";
import { handleApiAccess } from "@/app/_components/apiAccess";

interface PilotIncident {
  incidentId: string;
  warehouseName: string;
  reasonName: string;
  affectedOrderCount: number;
  maximumAgeHours: number | null;
}

interface OutcomePreview {
  state: "NO_CONTRACT" | "WAITING_MEASUREMENT_WINDOW" | "AWAITING_POST_WINDOW_EVIDENCE" | "READY_TO_VERIFY" | "VERIFIED";
  measurementWindowEnd?: string;
  baselineAffectedOrders?: number | null;
  observedAffectedOrders?: number | null;
  observedAt?: string | null;
  source?: string | null;
  evidenceRefs?: string[];
  evidenceKind?: "SNAPSHOT" | "INCIDENT_RESOLVED" | null;
  shadowFollowup?: { occurredAt: string; observationState: "READY_TO_VERIFY" | "AWAITING_POST_WINDOW_EVIDENCE"; observedAt: string | null; observedAffectedOrders: number | null; source: string | null } | null;
  verification?: { classification: string; reason_code: string; observed_at: string; evidence_refs: string[]; observed_affected_orders: number | null } | null;
}

const badge: Record<string, string> = {
  READY_FOR_REVIEW: "border-amber-400/40 bg-amber-400/10 text-amber-300",
  APPROVED: "border-emerald-400/40 bg-emerald-400/10 text-emerald-300",
  REJECTED: "border-rose-400/40 bg-rose-400/10 text-rose-300",
  SHADOW: "border-sky-400/40 bg-sky-400/10 text-sky-300",
};

type EvidenceFact = { label: string; value: string; emphasis?: boolean };

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readableTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString("vi-VN");
}

function buildEvidenceFacts(decision: Decision): EvidenceFact[] {
  const facts = decision.evidence.operationalFacts;
  const rows: EvidenceFact[] = [];
  const affected = finiteNumber(facts.affectedOrderCount);
  const analyzed = finiteNumber(facts.analyzedCount);
  const averageAge = finiteNumber(facts.averageAgeHours);
  const maximumAge = finiteNumber(facts.maximumAgeHours);
  const gapCount = finiteNumber(facts.gapCount);
  const oldestOrder = typeof facts.oldestOrderCode === "string" && facts.oldestOrderCode ? facts.oldestOrderCode : null;

  if (affected !== null) rows.push({ label: "Đơn đang bị ảnh hưởng", value: `${affected} đơn`, emphasis: true });
  if (analyzed !== null) rows.push({ label: "Đơn được phân tích", value: `${analyzed} đơn`, emphasis: true });
  if (averageAge !== null) rows.push({ label: "Tuổi tồn trung bình", value: `${averageAge.toFixed(1)} giờ` });
  if (maximumAge !== null) rows.push({ label: "Tuổi tồn cao nhất", value: `${maximumAge.toFixed(1)} giờ`, emphasis: true });
  if (gapCount !== null) rows.push({ label: "Hạng mục cần kiểm tra", value: `${gapCount} hạng mục` });
  if (oldestOrder) rows.push({ label: "Mã đơn tồn lâu nhất", value: oldestOrder });
  return rows;
}

function evidenceGroups(value: unknown): Array<{ title: string; action: string; orderCount: number | null }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const group = item as Record<string, unknown>;
    const title = typeof group.title === "string" ? group.title : "Hạng mục cần kiểm tra";
    const action = typeof group.action === "string" ? group.action : "";
    return [{ title, action, orderCount: finiteNumber(group.orderCount) }];
  }).slice(0, 3);
}

export default function DecisionInboxPage() {
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [incidents, setIncidents] = useState<PilotIncident[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actor, setActor] = useState("");
  const [role, setRole] = useState<OpsRole>("OPERATOR");
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [incidentId, setIncidentId] = useState("");
  const [creating, setCreating] = useState(false);
  const [outcomes, setOutcomes] = useState<Record<string, { status: string; observedOutcome: string; measuredAt: string; evidenceRefs: string; inconclusiveReason: string }>>({});
  const [executions, setExecutions] = useState<Record<string, { externalTicketId: string; performedAt: string; note: string }>>({});
  const [workOrders, setWorkOrders] = useState<Record<string, ExecutionWorkOrder | null>>({});
  const [workOrderForms, setWorkOrderForms] = useState<Record<string, { owner: string; dueAt: string; actionItems: string }>>({});
  const [outcomePreviews, setOutcomePreviews] = useState<Record<string, OutcomePreview>>({});

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [decisionResponse, dashboardResponse] = await Promise.all([
        fetch("/api/decisions", { cache: "no-store" }),
        fetch("/api/dashboard", { cache: "no-store" }),
      ]);
      const [payload, dashboard] = await Promise.all([decisionResponse.json(), dashboardResponse.json()]);
      handleApiAccess(decisionResponse, payload, "Không thể tải Decision Inbox.");
      const nextDecisions = payload.data || [];
      setDecisions(nextDecisions);
      const approved = nextDecisions.filter((item: Decision) => item.mode === "HUMAN_APPROVAL" && item.decisionStatus === "APPROVED");
      const entries = await Promise.all(approved.map(async (item: Decision) => {
        const response = await fetch(`/api/decisions/${item.decisionId}/work-order`, { cache: "no-store" });
        const workOrderPayload = await response.json();
        return [item.decisionId, response.ok ? workOrderPayload.data || null : null] as const;
      }));
      setWorkOrders(Object.fromEntries(entries));
      const pending = nextDecisions.filter((item: Decision) => item.mode === "HUMAN_APPROVAL" && ["EXECUTED", "OUTCOME_PENDING", "SUCCESS", "FAILURE", "INCONCLUSIVE"].includes(item.decisionStatus));
      const previews = await Promise.all(pending.map(async (item: Decision) => {
        const response = await fetch(`/api/decisions/${item.decisionId}/outcome-preview`, { cache: "no-store" });
        const previewPayload = await response.json();
        return [item.decisionId, response.ok ? previewPayload.data : { state: "NO_CONTRACT" }] as const;
      }));
      setOutcomePreviews(Object.fromEntries(previews));
      setIncidents(dashboardResponse.ok ? (dashboard.incidents?.items || []) : []);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const supabase = createClient();
    void supabase.auth.getUser().then(({ data }) => {
      if (!data.user) return;
      setActor(data.user.email || data.user.id);
      setRole(roleFromMetadata(data.user.app_metadata, data.user.user_metadata));
    });
  }, []);
  useEffect(() => {
    const selectedIncidentId = new URLSearchParams(window.location.search).get("incidentId");
    if (selectedIncidentId) setIncidentId(selectedIncidentId);
  }, []);

  async function review(decision: Decision, action: "approve" | "reject") {
    const reason = reasons[decision.decisionId]?.trim();
    if (!actor.trim()) { setError("Vui lòng nhập danh tính người review."); return; }
    if (action === "reject" && !reason) { setError("Lý do từ chối là bắt buộc."); return; }
    setSubmitting(decision.decisionId); setError("");
    try {
      const response = await fetch(`/api/decisions/${decision.decisionId}/${action}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actor: actor.trim(), rejectReason: reason, idempotencyKey: `${action}:${decision.decisionId}:${actor.trim()}` }),
      });
      const payload = await response.json();
      handleApiAccess(response, payload, "Review thất bại.");
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setSubmitting(null); }
  }

  async function createShadowFromIncident() {
    if (!actor.trim()) { setError("Vui lòng nhập danh tính pilot actor."); return; }
    if (!incidentId.trim()) { setError("Vui lòng nhập incidentId."); return; }
    setCreating(true); setError("");
    try {
      const response = await fetch(`/api/decisions/from-incident/${encodeURIComponent(incidentId.trim())}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actor: actor.trim(), idempotencyKey: `shadow:${incidentId.trim()}` }),
      });
      const payload = await response.json();
      handleApiAccess(response, payload, "Không thể tạo SHADOW decision.");
      setIncidentId("");
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setCreating(false); }
  }

  async function recordExecution(decision: Decision) {
    const form = executions[decision.decisionId] || { externalTicketId: "", performedAt: "", note: "" };
    if (!actor.trim()) { setError("Vui lòng đăng nhập để ghi nhận thực thi."); return; }
    setSubmitting(decision.decisionId); setError("");
    try {
      const response = await fetch(`/api/decisions/${decision.decisionId}/execute`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actor: actor.trim(),
          externalTicketId: form.externalTicketId.trim() || undefined,
          performedAt: form.performedAt ? new Date(form.performedAt).toISOString() : undefined,
          note: form.note.trim() || undefined,
          idempotencyKey: `execute:${decision.decisionId}`,
        }),
      });
      const payload = await response.json();
      handleApiAccess(response, payload, "Không thể ghi nhận thực thi.");
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setSubmitting(null); }
  }

  async function createWorkOrder(decision: Decision) {
    const form = workOrderForms[decision.decisionId] || { owner: "", dueAt: "", actionItems: "" };
    const actionItems = form.actionItems.split("\n").map((item) => item.trim()).filter(Boolean);
    if (!actor.trim()) { setError("Vui lòng đăng nhập để tạo work order."); return; }
    if (!form.owner.trim() || !form.dueAt || actionItems.length === 0) { setError("Owner, hạn xử lý và ít nhất một hạng mục action là bắt buộc."); return; }
    setSubmitting(decision.decisionId); setError("");
    try {
      const response = await fetch(`/api/decisions/${decision.decisionId}/work-order`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actor: actor.trim(), owner: form.owner.trim(), dueAt: new Date(form.dueAt).toISOString(), actionItems, idempotencyKey: `work-order:${decision.decisionId}` }) });
      const payload = await response.json(); handleApiAccess(response, payload, "Không thể tạo work order."); await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setSubmitting(null); }
  }

  async function transitionWorkOrder(decision: Decision, targetStatus: "IN_PROGRESS" | "COMPLETED") {
    if (!actor.trim()) { setError("Vui lòng đăng nhập để cập nhật work order."); return; }
    setSubmitting(decision.decisionId); setError("");
    try {
      const response = await fetch(`/api/decisions/${decision.decisionId}/work-order/status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actor: actor.trim(), targetStatus, idempotencyKey: `work-order:${decision.decisionId}:${targetStatus}` }) });
      const payload = await response.json(); handleApiAccess(response, payload, "Không thể cập nhật work order."); await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setSubmitting(null); }
  }

  async function verifyOutcome(decision: Decision, preview: OutcomePreview) {
    if (!actor.trim()) { setError("Vui lòng đăng nhập để verify outcome."); return; }
    if (preview.state !== "READY_TO_VERIFY" || preview.observedAffectedOrders === null || !preview.observedAt || !preview.source || !preview.evidenceRefs?.length) {
      setError("Chưa có đủ dữ liệu sau cửa sổ đo để verify outcome."); return;
    }
    setSubmitting(decision.decisionId); setError("");
    try {
      const response = await fetch(`/api/decisions/${decision.decisionId}/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actor: actor.trim(), observedAt: preview.observedAt, source: preview.source, observedMetrics: { affectedOrders: preview.observedAffectedOrders }, evidenceRefs: preview.evidenceRefs, idempotencyKey: `verify:${decision.decisionId}:${preview.observedAt}` }) });
      const payload = await response.json(); handleApiAccess(response, payload, "Không thể verify outcome."); await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setSubmitting(null); }
  }

  async function recordShadowOutcome(decision: Decision) {
    const form = outcomes[decision.decisionId] || { status: "INCONCLUSIVE", observedOutcome: "", measuredAt: "", evidenceRefs: "", inconclusiveReason: "" };
    if (!actor.trim()) { setError("Vui lòng nhập danh tính người ghi nhận outcome."); return; }
    if (!form.observedOutcome.trim()) { setError("Observed outcome là bắt buộc."); return; }
    if (!form.measuredAt) { setError("Measurement time là bắt buộc."); return; }
    if (form.status === "INCONCLUSIVE" && !form.inconclusiveReason.trim()) { setError("Inconclusive reason là bắt buộc."); return; }
    setSubmitting(decision.decisionId); setError("");
    try {
      const response = await fetch(`/api/decisions/${decision.decisionId}/outcome`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actor: actor.trim(), status: form.status, observedOutcome: form.observedOutcome.trim(),
          measuredAt: new Date(form.measuredAt).toISOString(),
          evidenceRefs: form.evidenceRefs.split(",").map((item) => item.trim()).filter(Boolean),
          inconclusiveReason: form.inconclusiveReason.trim() || undefined,
          idempotencyKey: `shadow-outcome:${decision.decisionId}:${form.status}:${form.measuredAt}`,
        }),
      });
      const payload = await response.json();
      handleApiAccess(response, payload, "Không thể ghi nhận outcome.");
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setSubmitting(null); }
  }

  return (
    <main id="main-content" tabIndex={-1} className="min-h-dvh bg-slate-950 px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-5">
        <header className="flex flex-col gap-3 border-b border-slate-800 pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">Decision Core</p>
            <h1 className="mt-1 text-2xl font-bold sm:text-3xl">Hộp quyết định</h1>
            <p className="mt-1 text-sm text-slate-400">Tạo quyết định quan sát từ incident; phê duyệt không tự thực thi hành động vận hành.</p></div>
          <button type="button" onClick={() => void load()} disabled={loading}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-700 px-4 text-sm font-semibold hover:bg-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 disabled:opacity-60">
            <RefreshCw aria-hidden="true" size={16} className={loading ? "animate-spin" : ""} /> Làm mới
          </button>
        </header>

        <section className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
          <label htmlFor="decision-actor" className="mb-2 block text-sm font-semibold">Danh tính người review</label>
          <input id="decision-actor" value={actor} readOnly aria-readonly="true"
            placeholder="Email hoặc mã nhân viên" autoComplete="username"
            className="min-h-11 w-full max-w-lg rounded-lg border border-slate-700 bg-slate-950 px-3 text-base text-slate-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400" />
          <p className="mt-2 text-xs text-slate-400">Danh tính lấy từ phiên Supabase · Vai trò: <strong className="text-blue-200">{role}</strong>.</p>
          {!roleCan(role, "MANAGE_DECISION") && <p role="status" className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-100">Bạn được xem Decision Inbox nhưng vai trò hiện tại không có quyền tạo, phê duyệt hoặc ghi outcome.</p>}
        </section>

        {roleCan(role, "MANAGE_DECISION") && <section className="rounded-xl border border-sky-500/25 bg-sky-500/5 p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h2 className="text-sm font-bold text-sky-100">Tạo quyết định quan sát từ sự cố</h2>
              <p className="mt-1 text-xs text-slate-400">Chọn một sự cố đã kiểm tra để lưu khuyến nghị và snapshot bằng chứng. Chế độ SHADOW không tác động vận hành.</p>
            </div>
            <div className="flex w-full flex-col gap-2 sm:flex-row lg:w-auto">
              <label htmlFor="pilot-incident-id" className="sr-only">Chọn sự cố</label>
              <select id="pilot-incident-id" value={incidentId} onChange={(event) => setIncidentId(event.target.value)}
                className="min-h-11 min-w-0 rounded-lg border border-slate-700 bg-slate-950 px-3 text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 sm:w-[28rem]">
                <option value="">Chọn sự cố đã kiểm tra…</option>
                {incidents.map((incident) => <option key={incident.incidentId} value={incident.incidentId}>{incident.reasonName} · {incident.warehouseName} · {incident.affectedOrderCount} đơn</option>)}
              </select>
              <button type="button" onClick={() => void createShadowFromIncident()} disabled={creating}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-sky-600 px-4 font-semibold text-white hover:bg-sky-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300 disabled:opacity-60">
                <Plus aria-hidden="true" size={17} /> {creating ? "Đang tạo…" : "Tạo quyết định SHADOW"}
              </button>
            </div>
          </div>
        </section>}

        <div aria-live="polite" aria-atomic="true">
          {error && <div role="alert" className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200"><CircleAlert aria-hidden="true" size={18} />{error}</div>}
          {loading && <p className="py-8 text-center text-slate-400">Đang tải decisions…</p>}
          {!loading && !error && decisions.length === 0 && <p className="rounded-xl border border-dashed border-slate-700 py-12 text-center text-slate-400">Chưa có decision. Pilot sẽ nối dữ liệu ở SHADOW mode.</p>}
        </div>

        <section aria-label="Danh sách decision" className="grid gap-4">
          {decisions.map((decision) => {
            const reviewable = decision.mode === "HUMAN_APPROVAL" && decision.decisionStatus === "READY_FOR_REVIEW";
            const workOrder = workOrders[decision.decisionId];
            const facts = buildEvidenceFacts(decision);
            const sampleOrderCodes = Array.isArray(decision.evidence.operationalFacts.sampleOrderCodes)
              ? decision.evidence.operationalFacts.sampleOrderCodes.filter((value): value is string => typeof value === "string" && Boolean(value)).slice(0, 5)
              : [];
            const groups = evidenceGroups(decision.evidence.operationalFacts.groups);
            const followupState = typeof decision.evidence.operationalFacts.followupState === "string" ? decision.evidence.operationalFacts.followupState : null;
            const evidenceCapturedAt = readableTimestamp(decision.evidence.capturedAt) || readableTimestamp(decision.evidence.operationalFacts.capturedAt);
            const humanInvestigation = decision.evidence.actionContext?.humanInvestigation;
            const investigationAction = humanInvestigation && typeof humanInvestigation === "object"
              && typeof (humanInvestigation as Record<string, unknown>).action === "string"
              ? (humanInvestigation as Record<string, unknown>).action as string : null;
            return <article key={decision.decisionId} className="rounded-xl border border-slate-800 bg-slate-900 p-4 shadow-lg sm:p-5">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0"><div className="flex flex-wrap gap-2 text-xs font-bold">
                  <span className={`rounded-full border px-2.5 py-1 ${badge[decision.decisionStatus] || "border-slate-700 bg-slate-800 text-slate-300"}`}>{decision.decisionStatus}</span>
                  <span className={`rounded-full border px-2.5 py-1 ${badge[decision.mode] || "border-indigo-400/40 bg-indigo-400/10 text-indigo-300"}`}>{decision.mode}</span>
                  <span className="rounded-full border border-slate-700 px-2.5 py-1">Risk {decision.riskLevel}</span>
                </div><h2 className="mt-3 text-lg font-bold leading-snug">{repairOperationalText(decision.problem)}</h2>
                  <p className="mt-2 text-sm text-slate-300"><strong>Khuyến nghị:</strong> {repairOperationalText(decision.recommendedAction)}</p></div>
                <dl className="grid shrink-0 grid-cols-2 gap-x-5 gap-y-1 text-sm lg:text-right">
                  <dt className="text-slate-500">Confidence</dt><dd className="font-mono font-bold">{decision.confidence}%</dd>
                  <dt className="text-slate-500">Financial</dt><dd className="font-mono text-amber-300">NOT_EVALUATED</dd>
                </dl>
              </div>
              <section aria-label={`Bằng chứng cho quyết định ${decision.problem}`} className="mt-4 rounded-lg border border-slate-800 bg-slate-950/70 p-4 text-sm">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <h3 className="flex items-center gap-2 font-semibold text-slate-100"><Eye aria-hidden="true" size={16}/> Facts tại thời điểm chụp</h3>
                  {evidenceCapturedAt && <p className="text-xs text-slate-400">Chụp lúc {evidenceCapturedAt}</p>}
                </div>
                {facts.length > 0 ? <dl className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {facts.map((fact) => <div key={fact.label} className="rounded-md border border-slate-800 bg-slate-900/70 px-3 py-2">
                    <dt className="text-xs text-slate-400">{fact.label}</dt>
                    <dd className={`mt-0.5 break-words font-semibold ${fact.emphasis ? "text-amber-200" : "text-slate-100"}`}>{fact.value}</dd>
                  </div>)}
                </dl> : <p className="mt-2 text-slate-400">Chưa có facts định lượng trong snapshot này.</p>}
                {followupState && <p className="mt-3 text-slate-300"><strong>Trạng thái follow-up:</strong> {translateStatus(followupState)}</p>}
                {sampleOrderCodes.length > 0 && <div className="mt-3"><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Mã đơn mẫu để đối soát</p><div className="mt-2 flex flex-wrap gap-2">{sampleOrderCodes.map((code) => <span key={code} className="rounded border border-cyan-400/30 bg-cyan-400/5 px-2 py-1 font-mono text-xs text-cyan-100">{code}</span>)}</div></div>}
                {groups.length > 0 && <div className="mt-3 border-t border-slate-800 pt-3"><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Điểm cần kiểm tra</p><ul className="mt-2 space-y-2 text-slate-300">{groups.map((group, index) => <li key={`${group.title}-${index}`}><strong className="text-slate-100">{group.title}</strong>{group.orderCount !== null ? ` · ${group.orderCount} đơn` : ""}{group.action ? <span className="block text-slate-400">{repairOperationalText(group.action)}</span> : null}</li>)}</ul></div>}
                {investigationAction && <aside className="mt-3 rounded-md border border-amber-400/30 bg-amber-400/5 p-3 text-amber-100"><strong>Điều còn thiếu trước khi quyết định:</strong> {repairOperationalText(investigationAction)}</aside>}
              </section>
              {decision.sourceLinks.incidentId && <div className="mt-4 flex flex-col gap-3 rounded-lg border border-indigo-400/25 bg-indigo-400/5 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div><h3 className="font-semibold text-indigo-100">Từ facts đến bản quyết định</h3><p className="mt-1 text-sm leading-6 text-slate-300">Mở đúng sự cố này để OpsPilot tự tra cứu timeline, gom nguyên nhân theo playbook và chuẩn bị bản <strong>HUMAN_APPROVAL</strong> khi có đủ bằng chứng.</p></div>
                <Link href={`/incidents/${encodeURIComponent(decision.sourceLinks.incidentId)}`} className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-300"><ArrowUpRight aria-hidden="true" size={17}/>Phân tích & chuẩn bị duyệt</Link>
              </div>}
              {decision.mode === "SHADOW" && <p className="mt-4 text-sm text-sky-300">SHADOW: chỉ quan sát recommendation/evidence; không có control tác động operation.</p>}
              {decision.mode === "SHADOW" && roleCan(role, "RECORD_OUTCOME") && <div className="mt-4 rounded-lg border border-sky-500/20 bg-sky-500/5 p-3">
                <h3 className="text-sm font-semibold text-sky-100">Ghi nhận observed outcome</h3>
                <p className="mt-1 text-xs text-slate-400">Chỉ lưu kết quả quan sát để so sánh pilot; không tính saving và không thực thi action.</p>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div><label htmlFor={`outcome-status-${decision.decisionId}`} className="mb-1 block text-xs font-semibold">Outcome status</label>
                    <select id={`outcome-status-${decision.decisionId}`} value={outcomes[decision.decisionId]?.status || "INCONCLUSIVE"}
                      onChange={(event) => setOutcomes((current) => ({ ...current, [decision.decisionId]: { ...(current[decision.decisionId] || { observedOutcome: "", measuredAt: "", evidenceRefs: "", inconclusiveReason: "" }), status: event.target.value } }))}
                      className="min-h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400">
                      <option value="SUCCESS">SUCCESS</option><option value="FAILURE">FAILURE</option><option value="INCONCLUSIVE">INCONCLUSIVE</option>
                    </select></div>
                  <div><label htmlFor={`outcome-time-${decision.decisionId}`} className="mb-1 block text-xs font-semibold">Measurement time</label>
                    <input id={`outcome-time-${decision.decisionId}`} type="datetime-local" value={outcomes[decision.decisionId]?.measuredAt || ""}
                      onChange={(event) => setOutcomes((current) => ({ ...current, [decision.decisionId]: { ...(current[decision.decisionId] || { status: "INCONCLUSIVE", observedOutcome: "", evidenceRefs: "", inconclusiveReason: "" }), measuredAt: event.target.value } }))}
                      className="min-h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400" /></div>
                  <div className="md:col-span-2"><label htmlFor={`observed-${decision.decisionId}`} className="mb-1 block text-xs font-semibold">Observed outcome</label>
                    <textarea id={`observed-${decision.decisionId}`} rows={2} value={outcomes[decision.decisionId]?.observedOutcome || ""} placeholder="Mô tả kết quả quan sát được"
                      onChange={(event) => setOutcomes((current) => ({ ...current, [decision.decisionId]: { ...(current[decision.decisionId] || { status: "INCONCLUSIVE", measuredAt: "", evidenceRefs: "", inconclusiveReason: "" }), observedOutcome: event.target.value } }))}
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400" /></div>
                  <div><label htmlFor={`evidence-refs-${decision.decisionId}`} className="mb-1 block text-xs font-semibold">Evidence refs</label>
                    <input id={`evidence-refs-${decision.decisionId}`} value={outcomes[decision.decisionId]?.evidenceRefs || ""} placeholder="ref-1, ref-2"
                      onChange={(event) => setOutcomes((current) => ({ ...current, [decision.decisionId]: { ...(current[decision.decisionId] || { status: "INCONCLUSIVE", observedOutcome: "", measuredAt: "", inconclusiveReason: "" }), evidenceRefs: event.target.value } }))}
                      className="min-h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400" /></div>
                  <div><label htmlFor={`inconclusive-${decision.decisionId}`} className="mb-1 block text-xs font-semibold">Inconclusive reason</label>
                    <input id={`inconclusive-${decision.decisionId}`} value={outcomes[decision.decisionId]?.inconclusiveReason || ""} placeholder="Bắt buộc nếu INCONCLUSIVE"
                      onChange={(event) => setOutcomes((current) => ({ ...current, [decision.decisionId]: { ...(current[decision.decisionId] || { status: "INCONCLUSIVE", observedOutcome: "", measuredAt: "", evidenceRefs: "" }), inconclusiveReason: event.target.value } }))}
                      className="min-h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400" /></div>
                </div>
                <button type="button" onClick={() => void recordShadowOutcome(decision)} disabled={submitting === decision.decisionId}
                  className="mt-3 inline-flex min-h-10 items-center justify-center rounded-lg bg-sky-600 px-4 text-sm font-semibold text-white hover:bg-sky-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300 disabled:opacity-60">
                  {submitting === decision.decisionId ? "Đang lưu…" : "Lưu outcome quan sát"}
                </button>
              </div>}
              {reviewable && roleCan(role, "MANAGE_DECISION") && <div className="mt-4 grid gap-3 border-t border-slate-800 pt-4 lg:grid-cols-[1fr_auto] lg:items-end">
                <div><label htmlFor={`reject-${decision.decisionId}`} className="mb-2 block text-sm font-semibold">Lý do từ chối <span className="text-rose-300">(bắt buộc khi Reject)</span></label>
                  <textarea id={`reject-${decision.decisionId}`} rows={2} value={reasons[decision.decisionId] || ""}
                    onChange={(event) => setReasons((current) => ({ ...current, [decision.decisionId]: event.target.value }))}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400" /></div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <button type="button" onClick={() => void review(decision, "reject")} disabled={submitting === decision.decisionId}
                    className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-rose-500/50 px-4 font-semibold text-rose-200 hover:bg-rose-500/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-400 disabled:opacity-60"><X aria-hidden="true" size={17}/> Reject</button>
                  <button type="button" onClick={() => void review(decision, "approve")} disabled={submitting === decision.decisionId}
                    className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 font-semibold text-white hover:bg-emerald-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300 disabled:opacity-60"><Check aria-hidden="true" size={17}/> {submitting === decision.decisionId ? "Đang xử lý…" : "Approve"}</button>
                </div></div>}
              {decision.mode === "HUMAN_APPROVAL" && decision.decisionStatus === "APPROVED" && roleCan(role, "MANAGE_DECISION") && !workOrder && <div className="mt-4 rounded-lg border border-cyan-500/25 bg-cyan-500/5 p-4">
                <h3 className="text-sm font-semibold text-cyan-100">Tạo Execution Work Order</h3>
                <p className="mt-1 text-xs leading-5 text-slate-400">Tự sinh mã OPSP-WO trước khi giao việc. OpsPilot chỉ ghi nhận work order, không tự gửi hoặc điều phối hành động.</p>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div><label htmlFor={`work-owner-${decision.decisionId}`} className="mb-1 block text-xs font-semibold">Owner <span className="text-rose-300">(bắt buộc)</span></label><input id={`work-owner-${decision.decisionId}`} value={workOrderForms[decision.decisionId]?.owner || ""} onChange={(event) => setWorkOrderForms((current) => ({ ...current, [decision.decisionId]: { ...(current[decision.decisionId] || { dueAt: "", actionItems: "" }), owner: event.target.value } }))} placeholder="Email, đội hoặc đầu mối chịu trách nhiệm" className="min-h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm" /></div>
                  <div><label htmlFor={`work-due-${decision.decisionId}`} className="mb-1 block text-xs font-semibold">Hạn xử lý <span className="text-rose-300">(bắt buộc)</span></label><input id={`work-due-${decision.decisionId}`} type="datetime-local" value={workOrderForms[decision.decisionId]?.dueAt || ""} onChange={(event) => setWorkOrderForms((current) => ({ ...current, [decision.decisionId]: { ...(current[decision.decisionId] || { owner: "", actionItems: "" }), dueAt: event.target.value } }))} className="min-h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm" /></div>
                  <div className="md:col-span-2"><label htmlFor={`work-actions-${decision.decisionId}`} className="mb-1 block text-xs font-semibold">Hạng mục action <span className="text-rose-300">(mỗi dòng một việc)</span></label><textarea id={`work-actions-${decision.decisionId}`} rows={4} value={workOrderForms[decision.decisionId]?.actionItems || ""} onChange={(event) => setWorkOrderForms((current) => ({ ...current, [decision.decisionId]: { ...(current[decision.decisionId] || { owner: "", dueAt: "" }), actionItems: event.target.value } }))} placeholder={repairOperationalText(decision.recommendedAction)} className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm" /></div>
                </div>
                <button type="button" onClick={() => void createWorkOrder(decision)} disabled={submitting === decision.decisionId} className="mt-3 inline-flex min-h-10 items-center justify-center rounded-lg bg-cyan-600 px-4 text-sm font-semibold text-white hover:bg-cyan-500 disabled:opacity-60">{submitting === decision.decisionId ? "Đang tạo…" : "Tạo work order"}</button>
              </div>}
              {workOrder && <div className="mt-4 rounded-lg border border-cyan-500/25 bg-cyan-500/5 p-4 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold text-cyan-100">Execution Work Order <span className="font-mono text-cyan-300">{workOrder.workOrderCode}</span></h3><span className="rounded-full border border-cyan-400/40 px-2 py-1 text-xs font-bold text-cyan-200">{workOrder.status}</span></div>
                <p className="mt-2 text-slate-300">Owner: <strong>{workOrder.owner}</strong> · Hạn: {new Date(workOrder.dueAt).toLocaleString("vi-VN")}</p>
                <ol className="mt-2 list-decimal space-y-1 pl-5 text-slate-300">{workOrder.actionItems.map((item, index) => <li key={`${workOrder.workOrderId}-${index}`}>{repairOperationalText(item)}</li>)}</ol>
                {roleCan(role, "MANAGE_DECISION") && workOrder.status === "OPEN" && <button type="button" onClick={() => void transitionWorkOrder(decision, "IN_PROGRESS")} disabled={submitting === decision.decisionId} className="mt-3 inline-flex min-h-10 items-center justify-center rounded-lg border border-cyan-400/50 px-4 text-sm font-semibold text-cyan-100 hover:bg-cyan-500/10 disabled:opacity-60">Bắt đầu thực hiện</button>}
                {roleCan(role, "MANAGE_DECISION") && workOrder.status === "IN_PROGRESS" && <button type="button" onClick={() => void transitionWorkOrder(decision, "COMPLETED")} disabled={submitting === decision.decisionId} className="mt-3 inline-flex min-h-10 items-center justify-center rounded-lg bg-cyan-600 px-4 text-sm font-semibold text-white hover:bg-cyan-500 disabled:opacity-60">Xác nhận work order hoàn tất</button>}
              </div>}
              {decision.mode === "HUMAN_APPROVAL" && decision.decisionStatus === "APPROVED" && workOrder?.status === "COMPLETED" && roleCan(role, "MANAGE_DECISION") && <div className="mt-4 rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-4">
                <h3 className="text-sm font-semibold text-emerald-100">Ghi nhận hành động đã thực hiện bên ngoài</h3>
                <p className="mt-1 text-xs leading-5 text-slate-400">OpsPilot không thực thi action. Khi xác nhận, hệ thống tự sinh OpsPilot Execution ID để đối soát; mã ticket ngoài hệ thống là tùy chọn.</p>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div><label htmlFor={`external-ticket-${decision.decisionId}`} className="mb-1 block text-xs font-semibold">Mã ticket ngoài hệ thống <span className="text-slate-500">(tùy chọn)</span></label>
                    <input id={`external-ticket-${decision.decisionId}`} value={executions[decision.decisionId]?.externalTicketId || ""} placeholder="Ví dụ: GTALK-123 hoặc JIRA-456"
                      onChange={(event) => setExecutions((current) => ({ ...current, [decision.decisionId]: { ...(current[decision.decisionId] || { performedAt: "", note: "" }), externalTicketId: event.target.value } }))}
                      className="min-h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-400" /></div>
                  <div><label htmlFor={`performed-at-${decision.decisionId}`} className="mb-1 block text-xs font-semibold">Thời điểm thực hiện</label>
                    <input id={`performed-at-${decision.decisionId}`} type="datetime-local" value={executions[decision.decisionId]?.performedAt || ""}
                      onChange={(event) => setExecutions((current) => ({ ...current, [decision.decisionId]: { ...(current[decision.decisionId] || { externalTicketId: "", note: "" }), performedAt: event.target.value } }))}
                      className="min-h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-400" /></div>
                  <div className="md:col-span-2"><label htmlFor={`execution-note-${decision.decisionId}`} className="mb-1 block text-xs font-semibold">Ghi chú đối soát</label>
                    <textarea id={`execution-note-${decision.decisionId}`} rows={2} value={executions[decision.decisionId]?.note || ""}
                      onChange={(event) => setExecutions((current) => ({ ...current, [decision.decisionId]: { ...(current[decision.decisionId] || { externalTicketId: "", performedAt: "" }), note: event.target.value } }))}
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-400" /></div>
                </div>
                <button type="button" onClick={() => void recordExecution(decision)} disabled={submitting === decision.decisionId}
                  className="mt-3 inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:opacity-60">
                  <Check aria-hidden="true" size={16}/>{submitting === decision.decisionId ? "Đang lưu…" : "Xác nhận đã thực hiện bên ngoài"}
                </button>
              </div>}
              {decision.executionReference && <p className="mt-4 rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm text-slate-300"><strong>OpsPilot Execution ID:</strong> <span className="font-mono text-emerald-200">{decision.executionReference}</span>{decision.executedAt ? ` · Ghi nhận lúc ${new Date(decision.executedAt).toLocaleString("vi-VN")}` : ""}</p>}
              {outcomePreviews[decision.decisionId] && <div className="mt-3 rounded-lg border border-violet-500/30 bg-violet-500/5 p-3 text-sm text-violet-100">
                {(() => { const preview = outcomePreviews[decision.decisionId]; return <>
                  <p className="font-semibold">Outcome Verification</p>
                  {preview.state === "WAITING_MEASUREMENT_WINDOW" && <p className="mt-1 text-slate-300">Chưa đến cửa sổ đo. Có thể verify từ {preview.measurementWindowEnd ? new Date(preview.measurementWindowEnd).toLocaleString("vi-VN") : "thời điểm chưa xác định"}.</p>}
                  {preview.state === "AWAITING_POST_WINDOW_EVIDENCE" && <p className="mt-1 text-amber-200">Chưa có snapshot sau cửa sổ đo. Hãy đồng bộ dữ liệu mới rồi làm mới trang; snapshot trước {preview.measurementWindowEnd ? new Date(preview.measurementWindowEnd).toLocaleString("vi-VN") : "giờ đo"} sẽ không được dùng để verify.</p>}
                  {preview.state === "READY_TO_VERIFY" && <><p className="mt-1 text-slate-300">Baseline: <strong>{preview.baselineAffectedOrders ?? "không có"}</strong> đơn · {preview.evidenceKind === "INCIDENT_RESOLVED" ? "Sự cố đã được giải quyết" : "Snapshot mới"}: <strong>{preview.observedAffectedOrders ?? "không có"}</strong> đơn{preview.observedAt ? ` · ${new Date(preview.observedAt).toLocaleString("vi-VN")}` : ""}.</p><p className="mt-1 text-xs text-slate-400">Nguồn: {preview.source}. Bấm Verify để hệ thống phân loại theo rule và lưu evidence/audit.</p>{roleCan(role, "RECORD_OUTCOME") && <button type="button" onClick={() => void verifyOutcome(decision, preview)} disabled={submitting === decision.decisionId || preview.observedAffectedOrders === null} className="mt-3 inline-flex min-h-10 items-center rounded-lg bg-violet-600 px-4 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-60">{submitting === decision.decisionId ? "Đang verify…" : "Verify outcome"}</button>}</>}
                  {preview.state === "VERIFIED" && <p className="mt-1 text-slate-300">Đã verify: <strong>{preview.verification?.classification}</strong> · {preview.verification?.reason_code} · Snapshot {preview.verification?.observed_affected_orders ?? "không có"} đơn.</p>}
                  {preview.state === "NO_CONTRACT" && <p className="mt-1 text-amber-200">Chưa có Outcome Observation Contract để verify.</p>}
                  {preview.shadowFollowup && <p role="status" aria-atomic="true" className="mt-2 text-xs text-cyan-200">LC-10 SHADOW: {preview.shadowFollowup.observationState === "READY_TO_VERIFY" ? `đã ghi evidence ${preview.shadowFollowup.observedAffectedOrders ?? "—"} đơn` : "đã kiểm tra nhưng chưa có evidence hợp lệ"} · {new Date(preview.shadowFollowup.occurredAt).toLocaleString("vi-VN")}. Chưa tự verify hoặc thay đổi outcome.</p>}
                </>; })()}
              </div>}
              {decision.followupSchedule && <div className="mt-3 rounded-lg border border-indigo-500/30 bg-indigo-500/5 p-3 text-sm text-indigo-100">
                <p className="font-semibold">Auto follow-up đã được lên lịch</p>
                <p className="mt-1 text-slate-300">Kiểm tra lại lúc {new Date(decision.followupSchedule.checkAt).toLocaleString("vi-VN")} · Policy {decision.followupSchedule.policyVersion} · Risk snapshot {decision.followupSchedule.riskLevelAtSchedule}</p>
                <p className="mt-1 text-xs text-slate-500">Đây là lịch thu thập bằng chứng, chưa phải kết luận outcome hay giá trị tài chính.</p>
              </div>}
              {decision.outcomeObservationContract && <div className="mt-3 rounded-lg border border-violet-500/30 bg-violet-500/5 p-3 text-sm text-violet-100">
                <p className="font-semibold">Outcome observation contract</p>
                <p className="mt-1 text-slate-300">Baseline snapshot: {new Date(decision.outcomeObservationContract.baselineCapturedAt).toLocaleString("vi-VN")} · Cửa sổ đo: {new Date(decision.outcomeObservationContract.measurementWindowStart).toLocaleString("vi-VN")} → {new Date(decision.outcomeObservationContract.measurementWindowEnd).toLocaleString("vi-VN")}</p>
                <p className="mt-1 text-xs text-slate-400">Yêu cầu evidence: {decision.outcomeObservationContract.requiredEvidenceTypes.join(" · ")}. Contract này chưa phải outcome verdict hay PnL.</p>
              </div>}
            </article>;
          })}
        </section>
      </div>
    </main>
  );
}
