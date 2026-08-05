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

interface EvidenceItem {
  code: string;
  value: string | number;
  statement: string;
}

interface RiskFactor {
  code: string;
  label: string;
  contribution: number;
  evidence: string;
}

interface RiskData {
  score: number;
  level: "low" | "medium" | "high" | "critical";
  factors: RiskFactor[];
}

interface AnalysisResult {
  summary: string;
  assessment: {
    status: "improving" | "stagnant" | "worsening" | "insufficient_data";
    explanation: string;
  };
  causes: Array<{
    title: string;
    confidence: number;
    evidenceCodes: string[];
    explanation: string;
  }>;
  investigationSteps: Array<{
    priority: "high" | "medium" | "low";
    action: string;
    rationale: string;
    requiredData: string[];
  }>;
  risk: RiskData;
  confidence: number;
  limitations: string[];
}

interface FullApiResponse {
  incident: {
    warehouseName: string;
    reasonName: string;
    affectedOrderCount: number;
  };
  context: {
    historyPointCount: number;
    currentAffectedCount: number;
    previousAffectedCount: number;
    changeAbsolute: number;
    changePercent: number;
    trendDirection: string;
    incidentDurationHours: number;
  };
  evidence: EvidenceItem[];
  analysis: AnalysisResult;
  metadata?: {
    provider: string;
    model: string;
    promptVersion: number;
  };
}

export default function RootCausePlayground() {
  const [incidents, setIncidents] = useState<IncidentSummary[]>([]);
  const [selectedIncidentId, setSelectedIncidentId] = useState<string>("");
  const [loadingIncidents, setLoadingIncidents] = useState<boolean>(true);
  const [analyzing, setAnalyzing] = useState<boolean>(false);
  const [data, setData] = useState<FullApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  async function handleAnalyze() {
    if (!selectedIncidentId) return;

    try {
      setAnalyzing(true);
      setError(null);
      setData(null);

      const res = await fetch(`/api/debug/rootcause/${encodeURIComponent(selectedIncidentId)}`);
      const json = await res.json();

      if (!res.ok || json.error) {
        throw new Error(json.message || json.error || "Analysis failed");
      }

      setData(json);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Root Cause Analysis failed: ${msg}`);
    } finally {
      setAnalyzing(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 max-w-6xl mx-auto space-y-8">
      <header className="border-b border-slate-800 pb-4">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs font-semibold uppercase tracking-wider mb-2">
          OpsPilot Root Cause Explanation Playground
        </div>
        <h1 className="text-3xl font-extrabold text-slate-100">Root Cause Agent Playground</h1>
        <p className="text-sm text-slate-400">
          Evidence-grounded operational explanation agent separating verified facts from AI interpretation
        </p>
      </header>

      {/* Incident Selection Form */}
      <section className="bg-slate-900 border border-slate-800 p-6 rounded-2xl space-y-4 shadow-xl">
        <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider">
          Select Target Operational Incident:
        </label>

        {loadingIncidents ? (
          <div className="text-sm text-slate-500 animate-pulse">Loading active incidents...</div>
        ) : (
          <div className="flex flex-col sm:flex-row gap-3">
            <select
              value={selectedIncidentId}
              onChange={(e) => setSelectedIncidentId(e.target.value)}
              className="flex-1 bg-slate-950 border border-slate-800 text-slate-200 text-sm rounded-xl p-3 focus:outline-none focus:border-blue-500"
            >
              {incidents.map((inc) => (
                <option key={inc.incidentId} value={inc.incidentId}>
                  [{inc.warehouseName}] - {inc.reasonName} (Priority: {inc.priorityScore})
                </option>
              ))}
              {incidents.length === 0 && <option value="">No active incidents available</option>}
            </select>

            <button
              onClick={handleAnalyze}
              disabled={analyzing || !selectedIncidentId}
              className="px-6 py-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold text-sm rounded-xl transition shadow-lg flex items-center justify-center gap-2"
            >
              {analyzing ? (
                <>
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
                  Analyzing Evidence...
                </>
              ) : (
                "Analyze Incident"
              )}
            </button>
          </div>
        )}

        {error && (
          <div className="p-4 bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs rounded-xl">
            {error}
          </div>
        )}
      </section>

      {data && (
        <div className="space-y-8 animate-fadeIn">
          {/* SECTION A: VERIFIED DETERMINISTIC EVIDENCE */}
          <section className="bg-slate-900 border-2 border-emerald-500/30 p-6 rounded-2xl space-y-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <span className="px-2.5 py-1 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs font-bold uppercase">
                  Part A: Verified Evidence
                </span>
                <h2 className="text-lg font-bold text-slate-100">Deterministic Facts & Rule Metrics</h2>
              </div>
              <span className="text-xs text-slate-400">Calculated by Code Engine</span>
            </div>

            {/* Context Metrics Summary */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs">
              <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl">
                <span className="text-slate-400 block font-semibold">Current Count</span>
                <span className="text-xl font-bold text-blue-400 mt-1 block">
                  {data.context.currentAffectedCount} đơn
                </span>
              </div>

              <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl">
                <span className="text-slate-400 block font-semibold">Previous Count</span>
                <span className="text-xl font-bold text-slate-300 mt-1 block">
                  {data.context.previousAffectedCount} đơn
                </span>
              </div>

              <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl">
                <span className="text-slate-400 block font-semibold">Percentage Change</span>
                <span
                  className={`text-xl font-bold mt-1 block ${
                    data.context.changePercent > 0
                      ? "text-rose-400"
                      : data.context.changePercent < 0
                      ? "text-emerald-400"
                      : "text-slate-300"
                  }`}
                >
                  {data.context.changePercent > 0 ? "+" : ""}
                  {data.context.changePercent}%
                </span>
              </div>

              <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl">
                <span className="text-slate-400 block font-semibold">Trend Direction</span>
                <span className="text-sm font-bold text-indigo-400 mt-1.5 block capitalize">
                  {data.context.trendDirection.replace("_", " ")}
                </span>
              </div>

              <div className="p-3 bg-slate-950 border border-slate-800 rounded-xl">
                <span className="text-slate-400 block font-semibold">Incident Duration</span>
                <span className="text-xl font-bold text-amber-400 mt-1 block">
                  {data.context.incidentDurationHours}h
                </span>
              </div>
            </div>

            {/* Deterministic Risk Breakdown */}
            <div className="p-4 bg-slate-950 border border-slate-800 rounded-xl space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                  Deterministic Risk Score:
                </span>
                <span
                  className={`text-xs font-bold uppercase px-3 py-1 rounded-full border ${
                    data.analysis.risk.level === "critical"
                      ? "bg-rose-500/10 text-rose-400 border-rose-500/20"
                      : data.analysis.risk.level === "high"
                      ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                      : "bg-blue-500/10 text-blue-400 border-blue-500/20"
                  }`}
                >
                  {data.analysis.risk.level} ({data.analysis.risk.score} / 100)
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                {data.analysis.risk.factors.map((f, i) => (
                  <div key={i} className="p-2.5 bg-slate-900 rounded-lg border border-slate-800 flex justify-between">
                    <span className="text-slate-300">{f.label}</span>
                    <span className="font-mono font-bold text-amber-400">+{f.contribution} pts</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Evidence List */}
            <div className="space-y-2 text-xs">
              <span className="font-semibold text-slate-300 uppercase tracking-wider block">
                Extracted Evidence Statements:
              </span>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {data.evidence.map((ev, i) => (
                  <div key={i} className="p-2.5 bg-slate-950 rounded-lg border border-slate-800 flex items-start gap-2">
                    <span className="px-1.5 py-0.5 rounded bg-slate-800 font-mono text-[10px] text-blue-400 border border-slate-700">
                      {ev.code}
                    </span>
                    <span className="text-slate-300">{ev.statement}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* SECTION B: AI OPERATIONAL EXPLANATION */}
          <section className="bg-slate-900 border-2 border-blue-500/30 p-6 rounded-2xl space-y-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <span className="px-2.5 py-1 rounded bg-blue-500/10 border border-blue-500/30 text-blue-400 text-xs font-bold uppercase">
                  Part B: AI Explanation
                </span>
                <h2 className="text-lg font-bold text-slate-100">Operational Cause Analysis & Safe Steps</h2>
              </div>
              {data.metadata && (
                <span className="text-xs font-mono text-slate-500">
                  {data.metadata.provider} / {data.metadata.model} (v{data.metadata.promptVersion})
                </span>
              )}
            </div>

            {/* AI Summary */}
            <div className="p-4 bg-slate-950 border border-slate-800 rounded-xl space-y-2">
              <h3 className="text-xs font-semibold text-blue-400 uppercase tracking-wider">Executive Summary</h3>
              <p className="text-slate-200 text-sm leading-relaxed">{data.analysis.summary}</p>
            </div>

            {/* Assessment */}
            <div className="p-4 bg-slate-950 border border-slate-800 rounded-xl space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Assessment Status</h3>
                <span className="text-xs font-bold uppercase px-2.5 py-0.5 rounded bg-slate-800 text-blue-400 border border-slate-700">
                  {data.analysis.assessment.status}
                </span>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">{data.analysis.assessment.explanation}</p>
            </div>

            {/* Causes */}
            <div className="space-y-3">
              <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                Likely Root Causes (Grounded by Evidence):
              </h3>
              <div className="grid grid-cols-1 gap-3 text-xs">
                {data.analysis.causes.map((cause, i) => (
                  <div key={i} className="p-4 bg-slate-950 border border-slate-800 rounded-xl space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-slate-200 text-sm">{cause.title}</span>
                      <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">
                        Confidence: {cause.confidence}%
                      </span>
                    </div>
                    <p className="text-slate-400">{cause.explanation}</p>
                    <div className="flex flex-wrap gap-1 pt-1">
                      {cause.evidenceCodes.map((code, cIdx) => (
                        <span key={cIdx} className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-800 text-[10px] font-mono text-emerald-400">
                          {code}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Investigation Steps */}
            <div className="space-y-3">
              <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                Recommended Safe Investigation Steps:
              </h3>
              <div className="grid grid-cols-1 gap-3 text-xs">
                {data.analysis.investigationSteps.map((step, i) => (
                  <div key={i} className="p-4 bg-slate-950 border border-slate-800 rounded-xl flex items-start gap-3">
                    <span
                      className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border ${
                        step.priority === "high"
                          ? "bg-rose-500/10 text-rose-400 border-rose-500/20"
                          : step.priority === "medium"
                          ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                          : "bg-blue-500/10 text-blue-400 border-blue-500/20"
                      }`}
                    >
                      {step.priority}
                    </span>
                    <div className="space-y-1 flex-1">
                      <p className="font-medium text-slate-200 text-sm">{step.action}</p>
                      <p className="text-slate-400">Rationale: {step.rationale}</p>
                      <div className="flex gap-1 text-[10px] text-slate-500">
                        <span>Required Data:</span>
                        <span className="text-slate-400">{step.requiredData.join(", ")}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Operational Limitations */}
            <div className="p-4 bg-slate-950 border border-slate-800 rounded-xl space-y-2 text-xs">
              <h3 className="font-semibold text-amber-400 uppercase tracking-wider">
                Operational Data Limitations (System Boundaries):
              </h3>
              <ul className="list-disc list-inside text-slate-400 space-y-1">
                {data.analysis.limitations.map((lim, i) => (
                  <li key={i}>{lim}</li>
                ))}
              </ul>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
