"use client";

import { FormEvent, useEffect, useState } from "react";
import { LogIn, LogOut, ShieldCheck } from "lucide-react";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { safePostLoginPath } from "@/security/route-policy";

type ViewState = "LOADING" | "SIGNED_OUT" | "SIGNED_IN";
type DataScope = {
  mode: "ALL" | "ASSIGNED" | "UNASSIGNED";
  employeeId: string | null;
  warehouseCount: number;
  zones: string[];
};

function roleLabel(user: User) {
  const role = user.app_metadata?.opspilot_role ?? user.user_metadata?.opspilot_role;
  return typeof role === "string" ? role.toUpperCase() : "OPERATOR";
}

export default function AccountPage() {
  const [view, setView] = useState<ViewState>("LOADING");
  const [user, setUser] = useState<User | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);
  const [dataScope, setDataScope] = useState<DataScope | null>(null);

  useEffect(() => {
    const supabase = createClient();
    void supabase.auth.getUser().then(({ data }) => {
      setUser(data.user ?? null);
      setView(data.user ? "SIGNED_IN" : "SIGNED_OUT");
    });
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setUser(nextSession?.user ?? null);
      setView(nextSession?.user ? "SIGNED_IN" : "SIGNED_OUT");
    });
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) {
      setDataScope(null);
      return;
    }
    void fetch("/api/account/scope", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((payload) => setDataScope(payload))
      .catch(() => setDataScope(null));
  }, [user]);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    setIsError(false);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) {
      setIsError(true);
      setMessage(error.message === "Invalid login credentials" ? "Email hoặc mật khẩu không đúng." : `Không thể đăng nhập: ${error.message}`);
      return;
    }
    setPassword("");
    setMessage("Đăng nhập thành công. Quyền API sẽ được áp dụng theo vai trò tài khoản.");
    window.location.assign(safePostLoginPath(new URLSearchParams(window.location.search).get("next")));
  }

  async function signOut() {
    setBusy(true);
    setMessage("");
    const supabase = createClient();
    const { error } = await supabase.auth.signOut();
    setBusy(false);
    setIsError(Boolean(error));
    setMessage(error ? `Không thể đăng xuất: ${error.message}` : "Đã đăng xuất.");
  }

  return (
    <main id="main-content" className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 lg:py-12">
      <header>
        <p className="text-sm font-semibold text-blue-300">Bảo mật OpsPilot</p>
        <h1 className="mt-1 text-3xl font-bold text-white">Tài khoản vận hành</h1>
        <p className="mt-3 max-w-2xl leading-7 text-slate-400">Đăng nhập bằng tài khoản Supabase do quản trị viên cấp. Vai trò quyết định quyền thao tác; mã nhân viên quyết định vùng, PIC và kho được phép xem.</p>
      </header>

      <section aria-busy={view === "LOADING" || busy} className="mt-8 rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-xl sm:p-7">
        {view === "LOADING" && <p role="status" className="text-slate-300">Đang kiểm tra phiên đăng nhập…</p>}

        {view === "SIGNED_OUT" && (
          <form onSubmit={signIn} className="space-y-5">
            <div className="flex items-start gap-3">
              <ShieldCheck aria-hidden="true" className="mt-0.5 text-blue-400" />
              <div><h2 className="text-xl font-bold">Đăng nhập</h2><p className="mt-1 text-sm text-slate-400">Không chia sẻ mật khẩu hoặc dùng tài khoản chung giữa nhiều người.</p></div>
            </div>
            <div>
              <label htmlFor="account-email" className="mb-2 block text-sm font-semibold">Email</label>
              <input id="account-email" type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} className="min-h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-white outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-400/30" />
            </div>
            <div>
              <label htmlFor="account-password" className="mb-2 block text-sm font-semibold">Mật khẩu</label>
              <input id="account-password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} className="min-h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-white outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-400/30" />
            </div>
            <button type="submit" disabled={busy} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-blue-600 px-5 font-semibold text-white hover:bg-blue-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 disabled:cursor-wait disabled:opacity-60"><LogIn aria-hidden="true" size={18}/>{busy ? "Đang đăng nhập…" : "Đăng nhập"}</button>
          </form>
        )}

        {view === "SIGNED_IN" && user && (
          <div>
            <div className="flex items-start gap-3"><ShieldCheck aria-hidden="true" className="mt-0.5 text-emerald-400"/><div><h2 className="text-xl font-bold">Đã đăng nhập</h2><p className="mt-1 break-all text-slate-300">{user.email}</p></div></div>
            <dl className="mt-6 grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl bg-slate-950 p-4"><dt className="text-sm text-slate-400">Vai trò OpsPilot</dt><dd className="mt-1 font-bold text-blue-200">{roleLabel(user)}</dd></div>
              <div className="rounded-xl bg-slate-950 p-4"><dt className="text-sm text-slate-400">Mã nhân viên</dt><dd className="mt-1 font-bold text-blue-200">{dataScope?.employeeId || "Chưa gán"}</dd></div>
              <div className="rounded-xl bg-slate-950 p-4"><dt className="text-sm text-slate-400">Phạm vi dữ liệu</dt><dd className="mt-1 font-bold text-blue-200">{dataScope?.mode === "ALL" ? "Toàn hệ thống" : dataScope?.mode === "ASSIGNED" ? `${dataScope.warehouseCount} kho được phân công` : "Chưa được phân công"}</dd></div>
              <div className="rounded-xl bg-slate-950 p-4"><dt className="text-sm text-slate-400">Vùng phụ trách</dt><dd className="mt-1 text-sm font-semibold text-slate-200">{dataScope?.zones?.join(", ") || "—"}</dd></div>
            </dl>
            {dataScope?.mode === "UNASSIGNED" && <p role="alert" className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100">Tài khoản chưa có <code>opspilot_employee_id</code>. Dữ liệu vận hành đang được khóa an toàn cho đến khi quản trị viên gán đúng mã nhân viên.</p>}
            <button type="button" onClick={signOut} disabled={busy} className="mt-6 inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-700 px-5 font-semibold hover:border-rose-400 hover:text-rose-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 disabled:cursor-wait disabled:opacity-60"><LogOut aria-hidden="true" size={18}/>{busy ? "Đang đăng xuất…" : "Đăng xuất"}</button>
          </div>
        )}

        {message && <p role={isError ? "alert" : "status"} className={`mt-5 rounded-lg border p-3 text-sm ${isError ? "border-rose-500/40 bg-rose-500/10 text-rose-200" : "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"}`}>{message}</p>}
      </section>

      <aside className="mt-6 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm leading-6 text-amber-100"><strong>Lưu ý triển khai:</strong> chế độ bắt buộc xác thực chỉ được bật sau khi quản trị viên tạo tài khoản và gán <code>app_metadata.opspilot_role</code>. Khi chưa bật, hệ thống giữ tương thích với Pilot hiện tại.</aside>
    </main>
  );
}
