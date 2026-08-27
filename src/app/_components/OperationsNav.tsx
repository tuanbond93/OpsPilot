"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Activity, Bell, BellRing, BookOpen, CheckSquare2, ChevronDown, Gauge, ListChecks, Menu, Scale, Settings, ShieldCheck, Truck, UserRound, UsersRound, X } from "lucide-react";
import { useOpsSession } from "@/app/_components/useOpsSession";

const items = [
  { href: "/dashboard", label: "Điều hành", icon: Gauge, mobile: true },
  { href: "/incidents", label: "Sự cố", icon: Activity, mobile: true },
  { href: "/reviews", label: "Cần phê duyệt", icon: CheckSquare2, mobile: true },
  { href: "/followups", label: "Kết quả", icon: ListChecks, mobile: true },
  { href: "/decisions", label: "Quyết định", icon: Scale, mobile: false },
  { href: "/b2b-consolidation", label: "Ghép chuyến B2B", icon: Truck, mobile: false },
  { href: "/notifications", label: "Thông báo", icon: Bell, mobile: false },
  { href: "/pilot-quality", label: "Chất lượng Pilot", icon: ShieldCheck, mobile: false },
  { href: "/guide", label: "Hướng dẫn", icon: BookOpen, mobile: false },
  { href: "/account", label: "Tài khoản", icon: UserRound, mobile: false },
  { href: "/admin/users", label: "Quản trị", icon: Settings, mobile: false, adminOnly: true },
  { href: "/admin/telegram-pilot", label: "Telegram Pilot", icon: UsersRound, mobile: false, adminOnly: true },
  { href: "/telegram-work-orders", label: "Nhắc việc TG", icon: BellRing, mobile: false },
] as const;

function Brand() {
  return <Link href="/dashboard" aria-label="OpsPilot - Giao Hàng Nặng" className="flex min-h-11 shrink-0 items-center gap-3 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-300">
    <span aria-hidden="true" className="h-8 w-1 rounded-full bg-[#00a19a] shadow-[0_0_16px_rgba(0,161,154,.6)]"/>
    <span><span className="block font-heading text-sm font-bold tracking-tight text-white">OpsPilot</span><span className="block text-[9px] font-semibold uppercase tracking-[0.11em] text-teal-300">Giao Hàng Nặng</span></span>
  </Link>;
}

export function OperationsNav() {
  const pathname = usePathname();
  const { role, authenticated } = useOpsSession();
  const [open, setOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const toolsMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setOpen(false); setMoreOpen(false); }, [pathname]);
  useEffect(() => {
    if (!moreOpen) return;
    const closeOutside = (event: PointerEvent) => { if (!toolsMenuRef.current?.contains(event.target as Node)) setMoreOpen(false); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setMoreOpen(false); };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => { document.removeEventListener("pointerdown", closeOutside); document.removeEventListener("keydown", closeOnEscape); };
  }, [moreOpen]);
  const active = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const visibleItems = items.filter((item) => !("adminOnly" in item && item.adminOnly) || role === "ADMIN");
  const primary = visibleItems.filter((item) => item.mobile);
  const desktopPrimary = visibleItems.filter((item) => ["/dashboard", "/incidents", "/reviews", "/followups", "/decisions"].includes(item.href));
  const desktopTools = visibleItems.filter((item) => ["/b2b-consolidation", "/pilot-quality", "/guide", "/admin/users", "/admin/telegram-pilot", "/telegram-work-orders"].includes(item.href));
  const toolsActive = desktopTools.some((item) => active(item.href));
  const accountPage = pathname.startsWith("/account");

  return <>
    <header className="sticky top-0 z-40 border-b border-teal-950 bg-black/95 shadow-[0_1px_0_rgba(0,161,154,.15)] backdrop-blur supports-[backdrop-filter]:bg-black/88">
      <div className="mx-auto flex min-h-[4.25rem] max-w-[1600px] items-center justify-between gap-5 px-4 sm:px-6 xl:px-8"><Brand/>
        {!accountPage && <div className="hidden min-w-0 flex-1 items-center justify-end gap-3 xl:flex">
          <nav aria-label="Điều hướng vận hành chính" className="min-w-0"><ul className="flex items-center justify-end gap-1">{desktopPrimary.map(({href,label,icon:Icon}) => <li key={href}><Link href={href} aria-current={active(href) ? "page" : undefined} className={`inline-flex min-h-11 items-center gap-2 whitespace-nowrap rounded-lg px-3 text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-300 ${active(href) ? "bg-[#00a19a] text-black shadow-[0_0_18px_rgba(0,161,154,.18)]" : "text-slate-300 hover:bg-teal-950 hover:text-white"}`}><Icon aria-hidden="true" size={17}/><span>{label}</span></Link></li>)}</ul></nav>
          <span aria-hidden="true" className="h-7 w-px bg-slate-800"/>
          <Link href="/notifications" aria-label="Thông báo" aria-current={active("/notifications") ? "page" : undefined} className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-300 ${active("/notifications") ? "border-teal-400 bg-teal-500/15 text-teal-200" : "border-slate-800 text-slate-300 hover:border-teal-800 hover:bg-teal-950 hover:text-white"}`}><Bell aria-hidden="true" size={18}/></Link>
          <div ref={toolsMenuRef} className="relative z-50">
            <button type="button" aria-expanded={moreOpen} aria-controls="desktop-tools-menu" onClick={() => setMoreOpen((value) => !value)} className={`inline-flex min-h-11 items-center gap-2 rounded-lg border px-3 text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-300 ${toolsActive || moreOpen ? "border-teal-500/60 bg-teal-500/10 text-teal-100" : "border-slate-800 text-slate-300 hover:border-teal-800 hover:bg-teal-950 hover:text-white"}`}><Menu aria-hidden="true" size={17}/><span>Công cụ</span><ChevronDown aria-hidden="true" size={15} className={`transition-transform ${moreOpen ? "rotate-180" : ""}`}/></button>
            {moreOpen && <div id="desktop-tools-menu" className="absolute right-0 top-[calc(100%+.65rem)] w-72 rounded-xl border border-teal-900/80 bg-[#071311] p-2 shadow-2xl shadow-black/70"><p className="px-3 pb-2 pt-1 text-[11px] font-bold uppercase tracking-[.16em] text-teal-300">Công cụ & quản trị</p><nav aria-label="Công cụ và quản trị"><ul className="space-y-1">{desktopTools.map(({href,label,icon:Icon}) => <li key={href}><Link href={href} aria-current={active(href) ? "page" : undefined} className={`flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-300 ${active(href) ? "bg-[#00a19a] text-black" : "text-slate-200 hover:bg-teal-950 hover:text-white"}`}><Icon aria-hidden="true" size={18}/><span>{label}</span></Link></li>)}</ul></nav></div>}
          </div>
          <Link href="/account" aria-current={active("/account") ? "page" : undefined} className={`inline-flex min-h-11 items-center gap-2 rounded-lg border px-3 text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-300 ${active("/account") ? "border-teal-400 bg-teal-500/15 text-teal-100" : "border-slate-800 text-slate-300 hover:border-teal-800 hover:bg-teal-950 hover:text-white"}`}><UserRound aria-hidden="true" size={17}/><span>Tài khoản</span>{authenticated && <span className="rounded-full border border-teal-600/50 px-1.5 py-0.5 text-[9px] text-teal-200">{role}</span>}</Link>
        </div>}
        {!accountPage && <button type="button" aria-label={open ? "Đóng trình đơn" : "Mở trình đơn"} aria-expanded={open} aria-controls="mobile-product-menu" onClick={() => setOpen((value) => !value)} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-teal-900 text-teal-100 hover:bg-teal-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-300 xl:hidden">{open ? <X aria-hidden="true"/> : <Menu aria-hidden="true"/>}</button>}
      </div>
    </header>

    {open && <><button type="button" aria-label="Đóng trình đơn" onClick={() => setOpen(false)} className="fixed inset-0 z-40 cursor-default bg-black/70 xl:hidden"/><div id="mobile-product-menu" role="dialog" aria-modal="true" aria-label="Tất cả chức năng" className="fixed inset-x-3 bottom-[calc(5.25rem+env(safe-area-inset-bottom))] z-50 max-h-[70dvh] overflow-y-auto rounded-2xl border border-teal-800/70 bg-[#071311] p-3 shadow-2xl shadow-black/70 xl:hidden"><p className="px-3 pb-2 pt-1 text-xs font-semibold uppercase tracking-[.16em] text-teal-300">Tất cả chức năng</p><nav aria-label="Tất cả chức năng"><ul className="grid grid-cols-2 gap-2">{visibleItems.map(({href,label,icon:Icon}) => <li key={href}><Link href={href} aria-current={active(href) ? "page" : undefined} className={`flex min-h-14 items-center gap-3 rounded-xl border px-3 text-sm font-semibold ${active(href) ? "border-teal-400 bg-[#00a19a] text-black" : "border-teal-950 bg-black/50 text-slate-200"}`}><Icon aria-hidden="true" size={19}/><span>{label}</span></Link></li>)}</ul></nav>{authenticated && <p className="px-3 pt-3 text-xs text-slate-400">Vai trò hiện tại: <strong className="text-teal-200">{role}</strong></p>}</div></>}

    {!accountPage && <nav aria-label="Điều hướng nhanh trên di động" className="fixed inset-x-0 bottom-0 z-40 border-t border-teal-900 bg-black/96 px-2 pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_28px_rgba(0,0,0,.45)] backdrop-blur xl:hidden"><ul className="mx-auto grid max-w-md grid-cols-4 gap-2">{primary.map(({href,label,icon:Icon}) => <li key={href}><Link href={href} aria-current={active(href) ? "page" : undefined} className={`flex min-h-[4.75rem] flex-col items-center justify-center gap-1 rounded-xl px-1 text-[11px] font-semibold ${active(href) ? "text-teal-200" : "text-slate-400"}`}><span className={`grid h-8 w-12 place-items-center rounded-full ${active(href) ? "bg-teal-500/20" : ""}`}><Icon aria-hidden="true" size={20}/></span><span>{label}</span></Link></li>)}</ul></nav>}
  </>;
}
