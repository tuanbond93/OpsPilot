"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Activity, Bell, BookOpen, CheckSquare2, Gauge, ListChecks, Menu, Scale, Settings, ShieldCheck, UserRound, X } from "lucide-react";
import { useOpsSession } from "@/app/_components/useOpsSession";

const items = [
  { href: "/dashboard", label: "Điều hành", icon: Gauge, mobile: true },
  { href: "/incidents", label: "Sự cố", icon: Activity, mobile: true },
  { href: "/reviews", label: "Cần phê duyệt", icon: CheckSquare2, mobile: true },
  { href: "/followups", label: "Kết quả", icon: ListChecks, mobile: true },
  { href: "/decisions", label: "Quyết định", icon: Scale, mobile: false },
  { href: "/notifications", label: "Thông báo", icon: Bell, mobile: false },
  { href: "/pilot-quality", label: "Chất lượng Pilot", icon: ShieldCheck, mobile: false },
  { href: "/guide", label: "Hướng dẫn", icon: BookOpen, mobile: false },
  { href: "/account", label: "Tài khoản", icon: UserRound, mobile: false },
  { href: "/admin/users", label: "Quản trị", icon: Settings, mobile: false, adminOnly: true },
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
  useEffect(() => setOpen(false), [pathname]);
  const active = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const visibleItems = items.filter((item) => !("adminOnly" in item && item.adminOnly) || role === "ADMIN");
  const primary = visibleItems.filter((item) => item.mobile);
  const accountPage = pathname.startsWith("/account");

  return <>
    <header className="sticky top-0 z-40 border-b border-teal-950 bg-black/95 shadow-[0_1px_0_rgba(0,161,154,.15)] backdrop-blur supports-[backdrop-filter]:bg-black/88">
      <div className="mx-auto flex min-h-[4.25rem] max-w-[1600px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-8"><Brand/>
        {!accountPage && <nav aria-label="Điều hướng sản phẩm" className="hidden min-w-0 flex-1 lg:block"><ul className="flex items-center justify-end gap-1">{items.map(({href,label,icon:Icon}) => <li key={href}><Link href={href} aria-current={active(href) ? "page" : undefined} className={`inline-flex min-h-11 items-center gap-2 whitespace-nowrap rounded-lg px-3 text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-300 ${active(href) ? "bg-[#00a19a] text-black" : "text-slate-300 hover:bg-teal-950 hover:text-white"}`}><Icon aria-hidden="true" size={17}/><span>{label}</span>{href === "/account" && authenticated && <span className="rounded-full border border-teal-600/50 px-1.5 py-0.5 text-[9px] text-teal-200">{role}</span>}</Link></li>)}</ul></nav>}
        {!accountPage && <button type="button" aria-label={open ? "Đóng trình đơn" : "Mở trình đơn"} aria-expanded={open} aria-controls="mobile-product-menu" onClick={() => setOpen((value) => !value)} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-teal-900 text-teal-100 hover:bg-teal-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-300 lg:hidden">{open ? <X aria-hidden="true"/> : <Menu aria-hidden="true"/>}</button>}
      </div>
    </header>

    {open && <><button type="button" aria-label="Đóng trình đơn" onClick={() => setOpen(false)} className="fixed inset-0 z-40 cursor-default bg-black/70 lg:hidden"/><div id="mobile-product-menu" role="dialog" aria-modal="true" aria-label="Tất cả chức năng" className="fixed inset-x-3 bottom-[calc(5.25rem+env(safe-area-inset-bottom))] z-50 max-h-[70dvh] overflow-y-auto rounded-2xl border border-teal-800/70 bg-[#071311] p-3 shadow-2xl shadow-black/70 lg:hidden"><p className="px-3 pb-2 pt-1 text-xs font-semibold uppercase tracking-[.16em] text-teal-300">Tất cả chức năng</p><nav aria-label="Tất cả chức năng"><ul className="grid grid-cols-2 gap-2">{items.map(({href,label,icon:Icon}) => <li key={href}><Link href={href} aria-current={active(href) ? "page" : undefined} className={`flex min-h-14 items-center gap-3 rounded-xl border px-3 text-sm font-semibold ${active(href) ? "border-teal-400 bg-[#00a19a] text-black" : "border-teal-950 bg-black/50 text-slate-200"}`}><Icon aria-hidden="true" size={19}/><span>{label}</span></Link></li>)}</ul></nav>{authenticated && <p className="px-3 pt-3 text-xs text-slate-400">Vai trò hiện tại: <strong className="text-teal-200">{role}</strong></p>}</div></>}

    {!accountPage && <nav aria-label="Điều hướng nhanh trên di động" className="fixed inset-x-0 bottom-0 z-40 border-t border-teal-900 bg-black/96 px-2 pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_28px_rgba(0,0,0,.45)] backdrop-blur lg:hidden"><ul className="mx-auto grid max-w-md grid-cols-4 gap-2">{primary.map(({href,label,icon:Icon}) => <li key={href}><Link href={href} aria-current={active(href) ? "page" : undefined} className={`flex min-h-[4.75rem] flex-col items-center justify-center gap-1 rounded-xl px-1 text-[11px] font-semibold ${active(href) ? "text-teal-200" : "text-slate-400"}`}><span className={`grid h-8 w-12 place-items-center rounded-full ${active(href) ? "bg-teal-500/20" : ""}`}><Icon aria-hidden="true" size={20}/></span><span>{label}</span></Link></li>)}</ul></nav>}
  </>;
}
