"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  Calendar,
  CheckCircle2,
  Clock,
  Lock,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Truck,
} from "lucide-react";
import { useOpsSession } from "@/app/_components/useOpsSession";
import { createClient } from "@/lib/supabase/client";
import {
  calculateCapacityPreview,
  formatFactRow,
  formatSanitizedConfirmation,
  GOVERNED_USABLE_PAYLOAD_KG,
  GOVERNED_VEHICLE_CLASS,
  isManagerAuthorized,
  PILOT_WAREHOUSES,
  validateVehicleAvailabilityForm,
  findActiveFactForTuple,
  type FactRowDisplay,
  type SanitizedConfirmation,
  type VehicleAvailabilityFormInput,
} from "./vehicle-availability-ui-logic";

export default function VehicleAvailabilityPage() {
  const session = useOpsSession();

  // Current local time string helper for datetime-local input
  const getTodayTimeString = (hourOffset = 0) => {
    const d = new Date();
    d.setHours(d.getHours() + hourOffset);
    d.setMinutes(0);
    d.setSeconds(0);
    d.setMilliseconds(0);
    const offset = d.getTimezoneOffset();
    const local = new Date(d.getTime() - offset * 60 * 1000);
    return local.toISOString().slice(0, 16);
  };

  const [form, setForm] = useState<VehicleAvailabilityFormInput>({
    warehouse_id: "21160000",
    supplier_name: "Thiên Phú",
    vehicle_class: GOVERNED_VEHICLE_CLASS,
    available_count: 1,
    earliest_available_at: getTodayTimeString(0),
    valid_until: getTodayTimeString(2),
  });

  const [validationErrors, setValidationErrors] = useState<Partial<Record<keyof VehicleAvailabilityFormInput, string>>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [successConfirmation, setSuccessConfirmation] = useState<SanitizedConfirmation | null>(null);

  const [activeFacts, setActiveFacts] = useState<FactRowDisplay[]>([]);
  const [isLoadingFacts, setIsLoadingFacts] = useState(true);
  const [factsError, setFactsError] = useState<string | null>(null);

  // Authorization check
  const authorized = useMemo(() => {
    if (session.loading) return false;
    if (!session.authenticated) return false;
    const opRole = (session as any).userMetadata?.opspilot_operational_role ||
      (session as any).appMetadata?.opspilot_operational_role;
    return isManagerAuthorized(session.role, opRole);
  }, [session]);

  // Selected warehouse metadata
  const selectedWarehouse = useMemo(() => {
    return PILOT_WAREHOUSES.find((w) => w.id === form.warehouse_id) || PILOT_WAREHOUSES[0];
  }, [form.warehouse_id]);

  // Handle warehouse change & reset supplier to valid option
  const handleWarehouseChange = (whId: string) => {
    const wh = PILOT_WAREHOUSES.find((w) => w.id === whId) || PILOT_WAREHOUSES[0];
    setForm((prev) => ({
      ...prev,
      warehouse_id: whId,
      supplier_name: wh.suppliers[0] || "",
    }));
    setValidationErrors((prev) => ({ ...prev, warehouse_id: undefined, supplier_name: undefined }));
  };

  // Capacity Preview calculation
  const capacityPreview = useMemo(() => {
    return calculateCapacityPreview(form.available_count, form.vehicle_class);
  }, [form.available_count, form.vehicle_class]);

  // Existing active fact for the selected tuple (if any)
  const existingActiveFact = useMemo(() => {
    return findActiveFactForTuple(activeFacts, form.warehouse_id, form.supplier_name, form.vehicle_class);
  }, [activeFacts, form.warehouse_id, form.supplier_name, form.vehicle_class]);

  // Fetch active facts from production
  const fetchActiveFacts = async () => {
    setIsLoadingFacts(true);
    setFactsError(null);
    try {
      const supabase = createClient();
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;

      const headers: Record<string, string> = {};
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }

      const res = await fetch("/api/internal/governed-sources/vehicle-availability", {
        method: "GET",
        credentials: "include",
        headers,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: Không thể tải danh sách facts khả dụng.`);
      }

      const data = await res.json();
      if (Array.isArray(data.facts)) {
        const displays = data.facts.map((f: any) => formatFactRow(f));
        setActiveFacts(displays);
      } else {
        setActiveFacts([]);
      }
    } catch (err: any) {
      setFactsError(err?.message || "Lỗi tải dữ liệu khả dụng.");
    } finally {
      setIsLoadingFacts(false);
    }
  };

  useEffect(() => {
    if (authorized) {
      void fetchActiveFacts();
    }
  }, [authorized]);

  // Handle Form Submission
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    setSuccessConfirmation(null);

    // Client-side validation
    const validation = validateVehicleAvailabilityForm(form);
    if (!validation.valid) {
      setValidationErrors(validation.errors);
      return;
    }
    setValidationErrors({});
    setIsSubmitting(true);

    try {
      const supabase = createClient();
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }

      const payload = {
        warehouse_id: form.warehouse_id,
        supplier_name: form.supplier_name,
        vehicle_class: form.vehicle_class,
        available_count: Number(form.available_count),
        earliest_available_at: new Date(form.earliest_available_at).toISOString(),
        valid_until: new Date(form.valid_until).toISOString(),
      };

      const res = await fetch("/api/internal/governed-sources/vehicle-availability", {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify(payload),
      });

      const responseData = await res.json();

      if (!res.ok) {
        throw new Error(responseData.error || `HTTP ${res.status}: Ghi nhận thất bại.`);
      }

      const confirmation = formatSanitizedConfirmation(responseData.fact_id, form);
      setSuccessConfirmation(confirmation);

      // Refresh active facts list
      await fetchActiveFacts();
    } catch (err: any) {
      setSubmitError(err?.message || "Đã xảy ra lỗi trong quá trình gửi xác nhận.");
    } finally {
      setIsSubmitting(false);
    }
  };

  // Render: Loading state
  if (session.loading) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
        <div className="flex items-center gap-3 text-slate-400">
          <RefreshCw className="w-5 h-5 animate-spin text-teal-400" />
          <span>Đang xác thực phiên làm việc Quản lý Vận hành...</span>
        </div>
      </div>
    );
  }

  // Render: Access Denied
  if (!authorized) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 p-6 flex items-center justify-center">
        <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-2xl text-center space-y-4">
          <div className="w-12 h-12 rounded-full bg-rose-500/10 text-rose-400 flex items-center justify-center mx-auto">
            <ShieldAlert className="w-6 h-6" />
          </div>
          <h2 className="text-xl font-bold text-slate-100">Từ chối truy cập</h2>
          <p className="text-sm text-slate-400">
            Chức năng <span className="text-teal-300 font-semibold">Xác nhận xe đang sẵn sàng</span> chỉ dành riêng cho vai trò <span className="font-mono text-amber-300">OPERATIONS_MANAGER</span> / <span className="font-mono text-amber-300">MANAGER</span>.
          </p>
          {!session.authenticated ? (
            <div className="pt-2">
              <Link
                href="/account"
                className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-500 text-sm font-semibold text-white transition-colors w-full"
              >
                Đăng nhập tài khoản
              </Link>
            </div>
          ) : (
            <div className="text-xs text-slate-500 pt-2 font-mono">
              Vai trò hiện tại: {session.role}
            </div>
          )}
          <div className="pt-2">
            <Link href="/operations" className="text-xs text-slate-400 hover:text-slate-200 inline-flex items-center gap-1">
              <ArrowLeft className="w-3.5 h-3.5" /> Quay lại Operations
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 max-w-7xl mx-auto space-y-8">
      {/* Header & Navigation */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <div className="flex items-center gap-2 text-xs text-slate-400 mb-1">
            <Link href="/operations" className="hover:text-teal-400 transition-colors">Operations</Link>
            <span>/</span>
            <span className="text-slate-200">Vehicle Availability</span>
          </div>
          <h1 className="text-2xl font-bold text-slate-100 flex items-center gap-2.5">
            <Truck className="w-6 h-6 text-teal-400" />
            Xác nhận xe đang sẵn sàng
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Ghi nhận thông tin xe sẵn sàng điều động thực tế từ Quản lý Vận hành (Level C Gate 3D.4)
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-right hidden sm:block">
            <div className="text-xs text-slate-400 font-medium">Người xác nhận</div>
            <div className="text-xs font-mono text-teal-300">{session.actor}</div>
          </div>
          <div className="h-8 w-px bg-slate-800 hidden sm:block" />
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-teal-500/10 text-teal-300 border border-teal-500/20">
            <ShieldCheck className="w-3.5 h-3.5" />
            OPERATIONS_MANAGER
          </span>
        </div>
      </div>

      {/* Main Grid: Form + Active Facts Panel */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left Column: Form (5 Cols) */}
        <div className="lg:col-span-5 space-y-6">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-xl space-y-5">
            <div className="border-b border-slate-800/80 pb-3">
              <h2 className="text-base font-semibold text-slate-100 flex items-center gap-2">
                <span>Nhập thông tin xe khả dụng</span>
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Chỉ nhập dữ liệu xe thực tế được nhà cung cấp xác nhận sẵn sàng
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              {/* 1. Kho */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                  1. Kho hàng (Warehouse) <span className="text-rose-400">*</span>
                </label>
                <div className="relative">
                  <select
                    value={form.warehouse_id}
                    onChange={(e) => handleWarehouseChange(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-teal-400 transition-colors"
                  >
                    {PILOT_WAREHOUSES.map((wh) => (
                      <option key={wh.id} value={wh.id}>
                        {wh.name} ({wh.id})
                      </option>
                    ))}
                  </select>
                </div>
                {validationErrors.warehouse_id && (
                  <p className="text-xs text-rose-400 mt-1">{validationErrors.warehouse_id}</p>
                )}
              </div>

              {/* 2. NCC */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                  2. Nhà cung cấp (Supplier) <span className="text-rose-400">*</span>
                </label>
                <select
                  value={form.supplier_name}
                  onChange={(e) => {
                    setForm((prev) => ({ ...prev, supplier_name: e.target.value }));
                    setValidationErrors((prev) => ({ ...prev, supplier_name: undefined }));
                  }}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-teal-400 transition-colors"
                >
                  {selectedWarehouse.suppliers.map((supp) => (
                    <option key={supp} value={supp}>
                      {supp} {form.warehouse_id === "21158000" && supp === "Hoàng Minh" ? "(Chưa có lịch định kỳ)" : ""}
                    </option>
                  ))}
                </select>
                {validationErrors.supplier_name && (
                  <p className="text-xs text-rose-400 mt-1">{validationErrors.supplier_name}</p>
                )}
              </div>

              {/* 3. Loại xe */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                  3. Loại xe (Vehicle Class)
                </label>
                <div className="w-full bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-300 flex items-center justify-between">
                  <span className="font-mono font-medium">{GOVERNED_VEHICLE_CLASS}</span>
                  <span className="text-xs text-slate-400">1.9 Tấn (Định mức 1,600 kg)</span>
                </div>
              </div>

              {/* 4. Số xe đang sẵn sàng */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                  4. Số xe đang sẵn sàng <span className="text-rose-400">*</span>
                </label>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={form.available_count}
                  onChange={(e) => {
                    setForm((prev) => ({ ...prev, available_count: e.target.value }));
                    setValidationErrors((prev) => ({ ...prev, available_count: undefined }));
                  }}
                  placeholder="Ví dụ: 1 hoặc 2"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-teal-400 transition-colors font-mono"
                />
                {validationErrors.available_count && (
                  <p className="text-xs text-rose-400 mt-1">{validationErrors.available_count}</p>
                )}
              </div>

              {/* Read-Only Capacity Preview Card */}
              <div className="bg-teal-950/30 border border-teal-800/40 rounded-lg p-3.5 space-y-1.5">
                <div className="text-xs font-semibold text-teal-300 flex items-center gap-1.5">
                  <Truck className="w-4 h-4 text-teal-400" />
                  {capacityPreview.label}
                </div>
                <div className="text-sm font-bold text-slate-100 font-mono">
                  {capacityPreview.displayText}
                </div>
                <p className="text-[11px] text-slate-400 leading-relaxed italic">
                  {capacityPreview.disclaimer}
                </p>
              </div>

              {/* 5. Sẵn sàng từ */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                  5. Sẵn sàng từ (Earliest Available At) <span className="text-rose-400">*</span>
                </label>
                <input
                  type="datetime-local"
                  value={form.earliest_available_at}
                  onChange={(e) => {
                    setForm((prev) => ({ ...prev, earliest_available_at: e.target.value }));
                    setValidationErrors((prev) => ({ ...prev, earliest_available_at: undefined }));
                  }}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-teal-400 transition-colors font-mono"
                />
                {validationErrors.earliest_available_at && (
                  <p className="text-xs text-rose-400 mt-1">{validationErrors.earliest_available_at}</p>
                )}
              </div>

              {/* 6. Có hiệu lực đến */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                  6. Có hiệu lực đến (Valid Until) <span className="text-rose-400">*</span>
                </label>
                <input
                  type="datetime-local"
                  value={form.valid_until}
                  onChange={(e) => {
                    setForm((prev) => ({ ...prev, valid_until: e.target.value }));
                    setValidationErrors((prev) => ({ ...prev, valid_until: undefined }));
                  }}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-teal-400 transition-colors font-mono"
                />
                <p className="text-[11px] text-slate-400 mt-1">
                  Bắt buộc nhập giờ hết hạn cụ thể do Quản lý xác nhận; hệ thống không tự sinh TTL.
                </p>
                {validationErrors.valid_until && (
                  <p className="text-xs text-rose-400 mt-1">{validationErrors.valid_until}</p>
                )}
              </div>

              {/* Replacement Warning Banner if Current Active Fact Exists for this Tuple */}
              {existingActiveFact && (
                <div className="p-3.5 bg-amber-950/40 border border-amber-500/50 rounded-lg text-xs text-amber-200 space-y-1.5">
                  <div className="flex items-center gap-2 font-semibold text-amber-300">
                    <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400" />
                    <span>Đang có xác nhận hiện hành cho Kho / NCC / Loại xe này. Xác nhận mới sẽ thay thế xác nhận hiện tại.</span>
                  </div>
                  <div className="text-slate-300 pl-6 space-y-0.5 text-[11px]">
                    <p>• Số lượng hiện hành: <strong className="text-white">{existingActiveFact.countDisplay}</strong> ({existingActiveFact.capacityDisplay})</p>
                    <p>• Bắt đầu khả dụng: <strong className="text-white">{existingActiveFact.earliestAvailableAt}</strong></p>
                    <p>• Hiệu lực đến: <strong className="text-white">{existingActiveFact.validUntil}</strong></p>
                  </div>
                </div>
              )}

              {/* Submit Error */}
              {submitError && (
                <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-lg text-xs text-rose-300 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400 mt-0.5" />
                  <span>{submitError}</span>
                </div>
              )}

              {/* Submit Button */}
              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full py-2.5 px-4 rounded-lg bg-teal-600 hover:bg-teal-500 disabled:bg-slate-800 disabled:text-slate-500 font-semibold text-sm text-white transition-colors flex items-center justify-center gap-2 shadow-lg"
              >
                {isSubmitting ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Đang ghi nhận...</span>
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Xác nhận xe khả dụng</span>
                  </>
                )}
              </button>
            </form>
          </div>

          {/* Success Confirmation Card */}
          {successConfirmation && (
            <div className="bg-emerald-950/40 border border-emerald-500/40 rounded-xl p-5 shadow-xl space-y-3">
              <div className="flex items-center gap-2 text-emerald-400 font-bold text-sm">
                <CheckCircle2 className="w-5 h-5" />
                <span>Đã ghi nhận availability</span>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <span className="text-slate-400 block">Kho:</span>
                  <span className="font-semibold text-slate-200">{successConfirmation.warehouseName}</span>
                </div>
                <div>
                  <span className="text-slate-400 block">NCC:</span>
                  <span className="font-semibold text-slate-200">{successConfirmation.supplierName}</span>
                </div>
                <div>
                  <span className="text-slate-400 block">Số xe:</span>
                  <span className="font-mono font-bold text-teal-300">{successConfirmation.availableCount} xe ({GOVERNED_VEHICLE_CLASS})</span>
                </div>
                <div>
                  <span className="text-slate-400 block">Năng lực xe:</span>
                  <span className="font-mono font-bold text-teal-300">{successConfirmation.plannedCapacityKg.toLocaleString("vi-VN")} kg</span>
                </div>
                <div>
                  <span className="text-slate-400 block">Sẵn sàng từ:</span>
                  <span className="font-mono text-slate-300">{new Date(successConfirmation.earliestAvailableAt).toLocaleString("vi-VN")}</span>
                </div>
                <div>
                  <span className="text-slate-400 block">Có hiệu lực đến:</span>
                  <span className="font-mono text-slate-300">{new Date(successConfirmation.validUntil).toLocaleString("vi-VN")}</span>
                </div>
              </div>

              <div className="pt-2 border-t border-emerald-900/60 flex items-center justify-between text-[11px] text-slate-400 font-mono">
                <span>Mã xác nhận: {successConfirmation.safeFactId}</span>
                <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-semibold">
                  {successConfirmation.status}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Right Column: Active Facts Panel (7 Cols) */}
        <div className="lg:col-span-7 space-y-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-xl">
            <div className="p-4 border-b border-slate-800 flex items-center justify-between">
              <div>
                <h2 className="font-semibold text-slate-200 text-sm flex items-center gap-2">
                  <Building2 className="w-4 h-4 text-teal-400" />
                  <span>Dữ liệu xe khả dụng hiện tại (Active Facts)</span>
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Dữ liệu đang có hiệu lực trên hệ thống thực tế (Asia/Ho_Chi_Minh)
                </p>
              </div>

              <button
                type="button"
                onClick={() => void fetchActiveFacts()}
                disabled={isLoadingFacts}
                className="p-1.5 rounded-lg border border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-600 transition-colors"
                title="Làm mới dữ liệu"
              >
                <RefreshCw className={`w-4 h-4 ${isLoadingFacts ? "animate-spin" : ""}`} />
              </button>
            </div>

            {factsError && (
              <div className="p-4 bg-rose-500/10 border-b border-rose-500/20 text-xs text-rose-300 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400" />
                <span>{factsError}</span>
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs text-slate-300">
                <thead className="bg-slate-800/60 uppercase text-slate-400 border-b border-slate-800 font-semibold tracking-wider">
                  <tr>
                    <th className="p-3">Kho</th>
                    <th className="p-3">NCC</th>
                    <th className="p-3">Số xe</th>
                    <th className="p-3">Năng lực (kg)</th>
                    <th className="p-3">Hiệu lực đến</th>
                    <th className="p-3">Trạng thái</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {isLoadingFacts && activeFacts.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="p-6 text-center text-slate-400">
                        <RefreshCw className="w-4 h-4 animate-spin inline mr-2 text-teal-400" />
                        Đang đọc dữ liệu từ server...
                      </td>
                    </tr>
                  ) : activeFacts.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="p-6 text-center text-slate-400 italic">
                        Chưa có live availability fact nào đang hoạt động trên hệ thống.
                        <div className="text-[11px] text-slate-500 mt-1">
                          Trạng thái khả dụng các nhà cung cấp hiện là <span className="font-mono text-slate-300">UNKNOWN</span> (Chưa xác nhận).
                        </div>
                      </td>
                    </tr>
                  ) : (
                    activeFacts.map((fact, idx) => (
                      <tr key={idx} className="hover:bg-slate-800/40 transition-colors">
                        <td className="p-3 font-medium text-slate-200">
                          {fact.warehouseName}
                          <span className="block text-[10px] text-slate-500 font-mono">{fact.warehouseId}</span>
                        </td>
                        <td className="p-3">{fact.supplierName}</td>
                        <td className="p-3 font-mono font-semibold">
                          {fact.countDisplay}
                        </td>
                        <td className="p-3 font-mono">
                          {fact.capacityDisplay}
                        </td>
                        <td className="p-3 font-mono text-[11px] text-slate-400">
                          {fact.validUntil}
                        </td>
                        <td className="p-3">
                          {fact.status === "AVAILABLE_NOW" ? (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                              AVAILABLE_NOW
                            </span>
                          ) : fact.status === "EXPIRED" ? (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/20">
                              EXPIRED
                            </span>
                          ) : fact.status === "SCHEDULED_AVAILABLE" ? (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-blue-500/15 text-blue-300 border border-blue-500/30">
                              SCHEDULED_AVAILABLE
                            </span>
                          ) : (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-800 text-slate-400 border border-slate-700 font-mono">
                              UNKNOWN
                            </span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Negative Control Notice */}
            <div className="p-3.5 bg-slate-950/40 border-t border-slate-800 text-[11px] text-slate-400 flex items-center justify-between">
              <div>
                <span className="font-semibold text-slate-300">Negative Control:</span> Kho Lào Cai / Hoàng Minh không có lịch định kỳ và không có live fact &rarr; Trạng thái <span className="font-mono text-amber-300 font-semibold">UNKNOWN</span> (Không phải 0 xe / 0 kg).
              </div>
              <span className="font-mono text-[10px] text-slate-500 shrink-0 ml-2">UNKNOWN != ZERO</span>
            </div>
          </div>

          {/* Governance Notice Card */}
          <div className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-4 text-xs text-slate-400 space-y-2">
            <div className="font-semibold text-slate-300 flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5 text-teal-400" />
              Nguyên tắc quản trị bằng chứng (Gate 3D.4)
            </div>
            <ul className="list-disc list-inside space-y-1 text-slate-400 text-[11px]">
              <li>Thông tin do Quản lý xác nhận có hiệu lực cao nhất và ghi đè lịch định kỳ trong thời gian hiệu lực.</li>
              <li>Khi hết giờ hiệu lực (<span className="font-mono">valid_until</span>), hệ thống tự động quay về lịch định kỳ của ngày tiếp theo hoặc trạng thái <span className="font-mono">UNKNOWN</span>.</li>
              <li>Hệ thống không tự động gia hạn TTL và không tự động điều xe khi chưa có quyết định phê duyệt.</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
