"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { useOpsSession } from "@/app/_components/useOpsSession";

export default function PlannerCompatibilityPage() {
  const router = useRouter();
  const session = useOpsSession();

  useEffect(() => {
    if (!session.loading && session.role !== "ADMIN") {
      router.replace("/reviews");
    }
  }, [router, session.loading, session.role]);

  if (session.loading || session.role !== "ADMIN") {
    return (
      <main id="main-content" className="mx-auto max-w-4xl px-4 py-10 text-slate-200">
        <p role="status">Đang chuyển tới hàng đợi cần phê duyệt…</p>
      </main>
    );
  }

  return (
    <main id="main-content" className="mx-auto max-w-4xl space-y-6 px-4 py-8 text-slate-100 sm:px-6">
      <header className="border-b border-slate-800 pb-5">
        <p className="text-sm font-semibold text-violet-300">Quản trị viên tổng</p>
        <h1 className="mt-1 text-3xl font-bold">Kế hoạch xử lý</h1>
        <p className="mt-2 text-sm text-slate-400">
          Màn hình tương thích để rà soát luồng xử lý. Người vận hành làm việc trong từng hồ sơ sự cố.
        </p>
      </header>

      <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="text-lg font-bold">Tóm tắt sự cố</h2>
        <p className="mt-3 leading-7 text-slate-300">
          Thông tin phân tích đã có được trình bày trong từng hồ sơ sự cố để bảo đảm bối cảnh và bằng chứng đi kèm.
        </p>
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="text-lg font-bold">Hành động đề xuất</h2>
        <p className="mt-3 text-sm text-slate-400">Chưa có hành động đủ cụ thể để thực hiện.</p>
      </section>

      <Link
        href="/reviews"
        className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-violet-600 px-4 font-semibold text-white hover:bg-violet-500"
      >
        Mở sự cố cần phê duyệt
        <ArrowRight aria-hidden="true" size={17} />
      </Link>
    </main>
  );
}
