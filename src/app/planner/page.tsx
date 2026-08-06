"use client";

import { useState, useEffect } from "react";

interface IncidentSummary {
  incidentId: string;
  incidentKey: string;
  warehouseName: string;
  reasonName: string;
  priorityScore: number;
  affectedOrderCount: number;
}

interface PlannerRecommendation {
  id: string;
  type: string;
  title: string;
  description: string;
  priority: "high" | "medium" | "low";
  targetRole: string;
  rationale: string;
  evidenceCodes: string[];
  riskImpact: {
    severity: "low" | "medium" | "high" | "critical";
    potentialConsequence: string;
  };
  prerequisiteData: string[];
  manualApprovalRequired: boolean;
}

interface PlannerInvestigation {
  id: string;
  priority: "high" | "medium" | "low";
  action: string;
  rationale: string;
  targetDepartment: string;
  requiredData: string[];
  safetyCheck: string;
}

interface BlockedOption {
  option: string;
  status: "not_evaluable";
  reason: string;
  missingData: string[];
}

interface NextReview {
  source: "FOLLOWUP_POLICY" | "PLANNER_POLICY";
  reviewAt: string;
  reviewAfterMinutes: number;
  rationale: string;
}

interface Confidence {
  score: number;
  level: "high" | "medium" | "low";
  factors: Array<{
    code: string;
    contribution: number;
    explanation: string;
  }>;
}

interface PlannerResult {
  executiveSummary: string;
  overallPriority: "high" | "medium" | "low";
  recommendations: PlannerRecommendation[];
  investigations: PlannerInvestigation[];
  blockedOptions: BlockedOption[];
  nextReview: NextReview;
  confidence: Confidence;
  limitations: string[];
  metadata: {
    provider: string;
    model: string;
    promptVersion: number;
    generatedAt: string;
  };
}

interface PlannerRunData {
  id: string;
  incident_id: string;
  status: "DRAFT" | "APPROVED" | "REJECTED" | "EXPIRED";
  context_hash: string;
  prompt_version: number;
  provider: string;
  model: string;
  result: PlannerResult;
  created_at: string;
  reviewed_at?: string | null;
  reviewed_by?: string | null;
}

export default function ActionPlannerPage() {
  const [incidents, setIncidents] = useState<IncidentSummary[]>([]);
  const [selectedIncidentId, setSelectedIncidentId] = useState<string>("");
  const [loadingIncidents, setLoadingIncidents] = useState<boolean>(true);
  const [generating, setGenerating] = useState<boolean>(false);
  const [runData, setRunData] = useState<PlannerRunData | null>(null);
  const [aiStatus, setAiStatus] = useState<"Pending" | "Running" | "Completed" | "Failed" | "None">("None");
  const [error, setError] = useState<string | null>(null);
  const [isCached, setIsCached] = useState<boolean>(false);

  // Review Form state
  const [reviewedBy, setReviewedBy] = useState<string>("");
  const [reviewNote, setReviewNote] = useState<string>("");
  const [submittingReview, setSubmittingReview] = useState<boolean>(false);
  const [reviewSuccess, setReviewSuccess] = useState<string | null>(null);

  useEffect(() => {
    async function loadIncidents() {
      try {
        setLoadingIncidents(true);
        const res = await fetch("/api/debug/incidents");
        const json = await res.json();
        const list = json.incidents || [];
        setIncidents(list);
        if (list.length > 0) {
          setSelectedIncidentId(list[0].incidentId);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(`Failed to load incidents: ${msg}`);
      } finally {
        setLoadingIncidents(false);
      }
    }
    loadIncidents();
  }, []);

  useEffect(() => {
    async function fetchPlannerStatus() {
      if (!selectedIncidentId) return;
      try {
        const res = await fetch(`/api/debug/planner/${encodeURIComponent(selectedIncidentId)}`);
        const json = await res.json();
        if (json.aiStatus) {
          if (json.aiStatus === "PENDING") setAiStatus("Pending");
          else if (json.aiStatus === "PROCESSING") setAiStatus("Running");
          else if (json.aiStatus === "COMPLETED") setAiStatus("Completed");
          else if (json.aiStatus === "FAILED") setAiStatus("Failed");
          else setAiStatus("None");
        }
        if (json.run) {
          setRunData(json.run);
        } else {
          setRunData(null);
        }
      } catch {
        // Fallback
      }
    }
    fetchPlannerStatus();
  }, [selectedIncidentId]);

  async function handleGenerate() {
    if (!selectedIncidentId) return;

    try {
      setGenerating(true);
      setError(null);
      setRunData(null);
      setReviewSuccess(null);

      const res = await fetch(`/api/debug/planner/${encodeURIComponent(selectedIncidentId)}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await res.json();

      if (!res.ok || json.error) {
        throw new Error(json.message || json.error || "Generation failed");
      }

      setIsCached(Boolean(json.cached));
      setAiStatus("Completed");

      const fetchRunRes = await fetch(`/api/debug/planner/${encodeURIComponent(selectedIncidentId)}`);
      const fetchRunJson = await fetchRunRes.json();
      if (fetchRunJson.run) {
        setRunData(fetchRunJson.run);
      } else {
        setRunData({
          id: json.runId || "temp-run",
          incident_id: selectedIncidentId,
          status: "DRAFT",
          context_hash: "hash",
          prompt_version: 1,
          provider: "console",
          model: "default",
          result: json.result,
          created_at: new Date().toISOString(),
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Action Planner generation failed: ${msg}`);
    } finally {
      setGenerating(false);
    }
  }

  async function handleReview(decision: "APPROVED" | "REJECTED") {
    if (!runData?.id) return;
    if (!reviewedBy.trim()) {
      alert("Vui lòng nhập tên/mã người phê duyệt (reviewedBy) trước khi gửi.");
      return;
    }

    try {
      setSubmittingReview(true);
      setReviewSuccess(null);
      setError(null);

      const res = await fetch(`/api/debug/planner-runs/${encodeURIComponent(runData.id)}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision,
          reviewedBy: reviewedBy.trim(),
          note: reviewNote.trim() || undefined,
        }),
      });

      const json = await res.json();
      if (!res.ok || json.error) {
        throw new Error(json.message || json.error || "Review failed");
      }

      setRunData((prev) => (prev ? { ...prev, status: decision, reviewed_by: reviewedBy.trim() } : null));
      setReviewSuccess(
        `Đã lưu kết quả ${decision === "APPROVED" ? "PHÊ DUYỆT" : "TỪ CHỐI"} cho Planner Run #${runData.id}.`
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Review failed: ${msg}`);
    } finally {
      setSubmittingReview(false);
    }
  }

  const result = runData?.result;
  const currentIncident = incidents.find((i) => i.incidentId === selectedIncidentId);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 max-w-6xl mx-auto space-y-8">
      <header className="border-b border-slate-800 pb-4">
        <div className="flex items-center justify-between">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-purple-500/10 border border-purple-500/20 text-purple-400 text-xs font-semibold uppercase tracking-wider mb-2">
            OpsPilot Action Planner (Sprint 6.5 AI Background Worker)
          </div>
          {aiStatus !== "None" && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400">Trạng thái AI Analysis:</span>
              <span
                className={`px-3 py-1 rounded-full text-xs font-bold font-mono border ${
                  aiStatus === "Completed"
                    ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
                    : aiStatus === "Running" || aiStatus === "Pending"
                    ? "bg-amber-500/10 border-amber-500/30 text-amber-400 animate-pulse"
                    : "bg-rose-500/10 border-rose-500/30 text-rose-400"
                }`}
              >
                ● {aiStatus}
              </span>
            </div>
          )}
        </div>
        <h1 className="text-3xl font-extrabold text-slate-100">Evidence-Grounded Action Planner</h1>
        <p className="text-sm text-slate-400">
          Lập kế hoạch hành động vận hành dựa trên bằng chứng xác thực và kiểm soát phê duyệt thủ công
        </p>
      </header>

      {/* Incident Selection Form */}
      <section className="bg-slate-900 border border-slate-800 p-6 rounded-2xl space-y-4 shadow-xl">
        <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider">
          Chọn sự cố vận hành để lập kế hoạch:
        </label>

        {loadingIncidents ? (
          <div className="text-sm text-slate-500 animate-pulse">Loading incidents...</div>
        ) : (
          <div className="flex flex-col sm:flex-row gap-3">
            <select
              value={selectedIncidentId}
              onChange={(e) => setSelectedIncidentId(e.target.value)}
              className="flex-1 bg-slate-950 border border-slate-800 text-slate-200 text-sm rounded-xl p-3 focus:outline-none focus:border-purple-500"
            >
              {incidents.map((inc) => (
                <option key={inc.incidentId} value={inc.incidentId}>
                  [{inc.warehouseName}] - {inc.reasonName} (Priority: {inc.priorityScore})
                </option>
              ))}
              {incidents.length === 0 && <option value="">No active incidents available</option>}
            </select>

            <button
              onClick={handleGenerate}
              disabled={generating || !selectedIncidentId}
              className="px-6 py-3 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white font-semibold text-sm rounded-xl transition shadow-lg flex items-center justify-center gap-2"
            >
              {generating ? (
                <>
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
                  Lập kế hoạch...
                </>
              ) : (
                "Tạo Kế Hoạch Action Planner"
              )}
            </button>
          </div>
        )}

        {(aiStatus === "Pending" || aiStatus === "Running") && !result && (
          <div className="p-4 bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs rounded-xl flex items-center gap-3 animate-pulse">
            <span className="w-4 h-4 border-2 border-amber-400/30 border-t-amber-400 rounded-full animate-spin"></span>
            <span>AI analysis is running in the background... Operator does not need to wait. Snapshot synchronization is completed.</span>
          </div>
        )}

        {error && (
          <div className="p-4 bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs rounded-xl">
            {error}
          </div>
        )}
      </section>

      {result && (
        <div className="space-y-8 animate-fadeIn">
          {/* SECTION A: VERIFIED OPERATIONAL CONTEXT */}
          <section className="bg-slate-900 border-2 border-emerald-500/30 p-6 rounded-2xl space-y-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <span className="px-2.5 py-1 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs font-bold uppercase">
                  Phần A: Ngữ cảnh Vận hành Xác thực
                </span>
                <h2 className="text-lg font-bold text-slate-100">Bối cảnh Sự cố & Chỉ số Xác thực</h2>
              </div>
              {isCached && (
                <span className="text-xs font-mono text-purple-400 bg-purple-500/10 px-2 py-0.5 rounded border border-purple-500/20">
                  Cached Context Hash Result
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl">
                <span className="text-slate-400 block font-semibold">Kho hàng</span>
                <span className="text-base font-bold text-slate-100 mt-1 block">
                  {currentIncident?.warehouseName || "N/A"}
                </span>
              </div>

              <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl">
                <span className="text-slate-400 block font-semibold">Loại sự cố</span>
                <span className="text-base font-bold text-amber-400 mt-1 block">
                  {currentIncident?.reasonName || "N/A"}
                </span>
              </div>

              <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl">
                <span className="text-slate-400 block font-semibold">Ưu tiên Tổng thể</span>
                <span
                  className={`text-base font-bold mt-1 block uppercase ${
                    result.overallPriority === "high"
                      ? "text-rose-400"
                      : result.overallPriority === "medium"
                      ? "text-amber-400"
                      : "text-emerald-400"
                  }`}
                >
                  {result.overallPriority}
                </span>
              </div>

              <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl">
                <span className="text-slate-400 block font-semibold">Trạng thái Draft Run</span>
                <span
                  className={`text-base font-bold mt-1 block uppercase ${
                    runData?.status === "APPROVED"
                      ? "text-emerald-400"
                      : runData?.status === "REJECTED"
                      ? "text-rose-400"
                      : "text-amber-300"
                  }`}
                >
                  {runData?.status || "DRAFT"}
                </span>
              </div>
            </div>
          </section>

          {/* SECTION B: PLANNER DRAFT RESULT */}
          <section className="bg-slate-900 border-2 border-purple-500/30 p-6 rounded-2xl space-y-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <span className="px-2.5 py-1 rounded bg-purple-500/10 border border-purple-500/30 text-purple-400 text-xs font-bold uppercase">
                  Phần B: Bản Thảo Kế Hoạch AI
                </span>
                <h2 className="text-lg font-bold text-slate-100">Khuyến nghị Hành động & Rà soát</h2>
              </div>
              <span className="text-xs font-mono text-slate-500">
                Run ID: {runData?.id || "N/A"}
              </span>
            </div>

            {/* Executive Summary */}
            <div className="p-4 bg-slate-950 border border-slate-800 rounded-xl space-y-2">
              <h3 className="text-xs font-semibold text-purple-400 uppercase tracking-wider">Tóm tắt Vận hành (Executive Summary)</h3>
              <p className="text-slate-200 text-sm leading-relaxed">{result.executiveSummary}</p>
            </div>

            {/* Recommendations */}
            <div className="space-y-3">
              <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                Khuyến nghị Hành động (Recommendations):
              </h3>
              <div className="grid grid-cols-1 gap-4 text-xs">
                {result.recommendations.map((rec) => (
                  <div key={rec.id} className="p-4 bg-slate-950 border border-slate-800 rounded-xl space-y-2">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800 pb-2">
                      <div className="flex items-center gap-2">
                        <span className="px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 font-mono text-[10px] font-bold">
                          {rec.type}
                        </span>
                        <span className="font-bold text-slate-100 text-sm">{rec.title}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-mono text-[10px]">
                          Target: {rec.targetRole}
                        </span>
                        <span className="px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/20 text-amber-400 text-[10px] font-bold">
                          Manual Approval Required
                        </span>
                      </div>
                    </div>

                    <p className="text-slate-300 text-sm">{rec.description}</p>
                    <p className="text-slate-400">Lý do: {rec.rationale}</p>

                    <div className="flex items-center justify-between pt-2 border-t border-slate-900 text-[11px]">
                      <div className="flex items-center gap-1">
                        <span className="text-slate-500">Mã bằng chứng:</span>
                        {rec.evidenceCodes.map((code) => (
                          <span key={code} className="px-1.5 py-0.5 rounded bg-slate-900 text-emerald-400 border border-slate-800 font-mono">
                            {code}
                          </span>
                        ))}
                      </div>
                      <div className="text-rose-400">
                        Hậu quả rủi ro: {rec.riskImpact?.potentialConsequence}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Investigations */}
            <div className="space-y-3">
              <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                Quy trình Rà soát An toàn (Investigations):
              </h3>
              <div className="grid grid-cols-1 gap-3 text-xs">
                {result.investigations.map((inv) => (
                  <div key={inv.id} className="p-3 bg-slate-950 border border-slate-800 rounded-xl space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-slate-200">{inv.action}</span>
                      <span className="text-[10px] text-indigo-400 font-mono">Dept: {inv.targetDepartment}</span>
                    </div>
                    <p className="text-slate-400">Lý do: {inv.rationale}</p>
                    <p className="text-amber-400/90 text-[11px]">Kiểm tra an toàn: {inv.safetyCheck}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Blocked Options */}
            <div className="space-y-3">
              <h3 className="text-xs font-semibold text-rose-400 uppercase tracking-wider">
                Lựa chọn bị Chặn / Không thể Đánh giá (Blocked Options):
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                {result.blockedOptions.map((b, i) => (
                  <div key={i} className="p-3 bg-slate-950 border border-rose-500/20 rounded-xl space-y-1">
                    <span className="font-bold text-rose-300 block">{b.option}</span>
                    <p className="text-slate-400">{b.reason}</p>
                    <div className="text-[10px] text-slate-500 font-mono">
                      Thiếu dữ liệu: {b.missingData.join(", ")}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Next Review & Confidence */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
              <div className="p-4 bg-slate-950 border border-slate-800 rounded-xl space-y-2">
                <h4 className="font-semibold text-slate-300 uppercase tracking-wider">Lịch Đánh giá Tiếp theo (Next Review)</h4>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Thời gian:</span>
                  <span className="font-bold text-amber-400 font-mono">{result.nextReview.reviewAt}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Chu kỳ:</span>
                  <span className="font-bold text-slate-200">{result.nextReview.reviewAfterMinutes} phút</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Nguồn chính sách:</span>
                  <span className="font-mono text-purple-400">{result.nextReview.source}</span>
                </div>
                <p className="text-slate-400 text-[11px] pt-1">{result.nextReview.rationale}</p>
              </div>

              <div className="p-4 bg-slate-950 border border-slate-800 rounded-xl space-y-2">
                <h4 className="font-semibold text-slate-300 uppercase tracking-wider">Độ Tin cậy Mô hình (Confidence)</h4>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Điểm tổng hợp:</span>
                  <span className="font-extrabold text-lg text-emerald-400 font-mono">{result.confidence.score} / 100 ({result.confidence.level})</span>
                </div>
                <div className="space-y-1 pt-1">
                  {result.confidence.factors.map((f, i) => (
                    <div key={i} className="flex justify-between text-[11px]">
                      <span className="text-slate-400">{f.code}</span>
                      <span className={`font-mono font-bold ${f.contribution >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                        {f.contribution >= 0 ? "+" : ""}{f.contribution}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Limitations */}
            <div className="p-4 bg-slate-950 border border-slate-800 rounded-xl space-y-2 text-xs">
              <h4 className="font-semibold text-amber-400 uppercase tracking-wider">Giới hạn Hệ thống (System Boundaries)</h4>
              <ul className="list-disc list-inside text-slate-400 space-y-1">
                {result.limitations.map((lim, i) => (
                  <li key={i}>{lim}</li>
                ))}
              </ul>
            </div>
          </section>

          {/* SECTION C: HUMAN REVIEW CONTROLS */}
          <section className="bg-slate-900 border-2 border-indigo-500/30 p-6 rounded-2xl space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <span className="px-2.5 py-1 rounded bg-indigo-500/10 border border-indigo-500/30 text-indigo-400 text-xs font-bold uppercase">
                  Phần C: Phê Duyệt Vận Hành (Human Review)
                </span>
                <h2 className="text-lg font-bold text-slate-100">Quyết định Phê duyệt Kế hoạch</h2>
              </div>
            </div>

            <div className="p-4 bg-amber-500/10 border border-amber-500/20 rounded-xl text-amber-300 text-xs font-semibold">
              ⚠️ <strong>Lưu ý Governance:</strong> Phê duyệt không đồng nghĩa với thực thi. Action Queue integration will be implemented later.
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
              <div className="space-y-2">
                <label className="block font-semibold text-slate-300">
                  Người Phê Duyệt (reviewedBy) <span className="text-rose-400">*</span>:
                </label>
                <input
                  type="text"
                  placeholder="Nhập email hoặc mã nhân viên (ví dụ: nguyen.son@ops.vn)"
                  value={reviewedBy}
                  onChange={(e) => setReviewedBy(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 text-slate-200 text-sm rounded-xl p-3 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="space-y-2">
                <label className="block font-semibold text-slate-300">Ghi chú Review (Note):</label>
                <input
                  type="text"
                  placeholder="Ghi chú thêm (không bắt buộc)..."
                  value={reviewNote}
                  onChange={(e) => setReviewNote(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 text-slate-200 text-sm rounded-xl p-3 focus:outline-none focus:border-indigo-500"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                onClick={() => handleReview("REJECTED")}
                disabled={submittingReview}
                className="px-6 py-2.5 bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 border border-rose-500/30 font-bold text-xs rounded-xl transition"
              >
                TỪ CHỐI (REJECT)
              </button>

              <button
                onClick={() => handleReview("APPROVED")}
                disabled={submittingReview}
                className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs rounded-xl shadow transition flex items-center gap-2"
              >
                {submittingReview ? "Đang xử lý..." : "PHÊ DUYỆT (APPROVE)"}
              </button>
            </div>

            {reviewSuccess && (
              <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs rounded-xl font-semibold">
                {reviewSuccess}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
