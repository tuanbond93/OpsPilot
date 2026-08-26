import Link from "next/link";
import { CheckCircle2, ClipboardCheck, Search, ShieldCheck } from "lucide-react";

export function OperatorStartHere({ incidents, reviews, followups }: { incidents:number;reviews:number;followups:number }) {
 const steps=[
  {title:"1. Chọn sự cố cần kiểm tra",detail:`Có ${incidents} sự cố đang hoạt động. Mở sự cố có ưu tiên cao, kiểm tra kho và mã đơn trước.`,href:"/incidents",cta:"Mở danh sách sự cố",icon:Search},
  {title:"2. Đối chiếu bằng chứng",detail:"Xác nhận đơn lâu nhất, trạng thái đơn và điều kiện rule. Nhãn hệ thống chưa phải nguyên nhân thực tế.",href:"/guide#incident",cta:"Xem cách kiểm tra",icon:ShieldCheck},
  {title:"3. Duyệt đề xuất AI",detail:`Có ${reviews} kết quả chờ duyệt. Chỉ duyệt khi dữ liệu và bằng chứng còn mới, khớp thực tế.`,href:"/reviews",cta:"Mở hàng đợi duyệt",icon:ClipboardCheck},
  {title:"4. Theo dõi kết quả",detail:`Có ${followups} follow-up đang chờ. Phản hồi sai lệch tại trang Phản hồi Pilot.`,href:"/followups",cta:"Mở theo dõi",icon:CheckCircle2},
 ];
 return <section aria-labelledby="start-heading" className="rounded-2xl border border-blue-500/30 bg-gradient-to-br from-blue-500/10 to-slate-900 p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-wider text-blue-300">Bắt đầu từ đây</p><h2 id="start-heading" className="mt-1 text-xl font-bold">Trong 5 phút đầu, hãy làm theo 4 bước</h2><p className="mt-1 text-sm text-slate-400">OpsPilot phát hiện tín hiệu và đề xuất; người vận hành xác minh nguyên nhân và quyết định.</p></div><Link href="/guide" className="inline-flex min-h-11 items-center rounded-lg border border-blue-400/40 px-4 text-sm font-semibold text-blue-200">Mở sổ tay đầy đủ</Link></div><ol className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">{steps.map(({title,detail,href,cta,icon:Icon})=><li key={title} className="flex flex-col rounded-xl border border-slate-700 bg-slate-950/70 p-4"><Icon aria-hidden="true" className="text-blue-300" size={20}/><h3 className="mt-3 font-bold">{title}</h3><p className="mt-2 flex-1 text-sm leading-6 text-slate-400">{detail}</p><Link href={href} className="mt-4 inline-flex min-h-11 items-center text-sm font-semibold text-blue-300 hover:text-blue-200">{cta} →</Link></li>)}</ol></section>
}
