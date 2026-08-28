"use client";

import { useEffect, useMemo, useState } from "react";
import { MapPinned, RefreshCw, Save, Send, UsersRound, X } from "lucide-react";

type Group = { id: string; telegram_chat_id: string; title: string; status: string; created_at: string };
type Member = { id: string; group_id: string; telegram_user_id: string; display_name: string; username: string | null; warehouse_name: string | null; warehouse_names?: string[]; zone_names?: string[]; pilot_role: "OPERATOR" | "MANAGER"; status: "PENDING" | "ACTIVE" | "SUSPENDED"; first_seen_at: string; last_seen_at: string };
type Warehouse = { warehouseId: string; warehouseName: string; zone: string };
type Draft = { warehouseNames: string[]; zoneNames: string[]; pilot_role: Member["pilot_role"]; status: Member["status"] };
type Topic = { id: string; group_id: string; message_thread_id: number; topic_title: string; province_name: string | null; is_escalation: boolean; status: "PENDING" | "ACTIVE" | "SUSPENDED" };
type TopicDraft = { provinceName: string; isEscalation: boolean; status: Topic["status"] };
type PilotData = { groups: Group[]; members: Member[]; topics: Topic[]; warehouseOptions: Warehouse[]; zoneOptions: string[]; provinceOptions: string[] };

function memberDraft(member: Member): Draft {
  return { warehouseNames: member.warehouse_names?.length ? member.warehouse_names : member.warehouse_name ? [member.warehouse_name] : [], zoneNames: member.zone_names || [], pilot_role: member.pilot_role, status: member.status };
}

function isAnonymousTelegramActor(member: Member) {
  return member.username === "GroupAnonymousBot" || member.telegram_user_id === "1087968824";
}

export default function TelegramPilotAdminPage() {
  const [data, setData] = useState<PilotData>({ groups: [], members: [], topics: [], warehouseOptions: [], zoneOptions: [], provinceOptions: [] });
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [topicDrafts, setTopicDrafts] = useState<Record<string, TopicDraft>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const load = async () => {
    setBusy(true);
    const response = await fetch("/api/admin/telegram-pilot", { cache: "no-store" });
    const body = await response.json();
    setBusy(false);
    if (!response.ok) { setMessage(body.message || body.error || "Không thể tải Telegram pilot."); return; }
    setData({ groups: body.groups || [], members: body.members || [], topics: body.topics || [], warehouseOptions: body.warehouseOptions || [], zoneOptions: body.zoneOptions || [], provinceOptions: body.provinceOptions || [] });
    setDrafts(Object.fromEntries((body.members || []).map((member: Member) => [member.id, memberDraft(member)])));
    setTopicDrafts(Object.fromEntries((body.topics || []).map((topic: Topic) => [topic.id, { provinceName: topic.province_name || "", isEscalation: topic.is_escalation, status: topic.status }])));
  };
  useEffect(() => { void load(); }, []);
  const groupNames = useMemo(() => new Map(data.groups.map((group) => [group.id, group.title || group.telegram_chat_id])), [data.groups]);
  const activeGroups = useMemo(() => data.groups.filter((group) => group.status !== "SUSPENDED"), [data.groups]);
  const visibleMembers = useMemo(() => data.members.filter((member) => !isAnonymousTelegramActor(member)), [data.members]);
  const pendingMembers = useMemo(() => visibleMembers.filter((member) => member.status === "PENDING"), [visibleMembers]);
  const configuredMembers = useMemo(() => visibleMembers.filter((member) => member.status === "ACTIVE"), [visibleMembers]);
  const historicalMemberCount = useMemo(() => visibleMembers.filter((member) => member.status === "SUSPENDED").length, [visibleMembers]);
  const patch = (id: string, update: Partial<Draft>) => setDrafts((current) => ({ ...current, [id]: { ...(current[id] || { warehouseNames: [], zoneNames: [], pilot_role: "OPERATOR", status: "PENDING" }), ...update } }));
  const patchTopic = (id: string, update: Partial<TopicDraft>) => setTopicDrafts((current) => ({ ...current, [id]: { ...(current[id] || { provinceName: "", isEscalation: false, status: "PENDING" }), ...update } }));
  const save = async (member: Member) => {
    const draft = drafts[member.id];
    if (!draft || (!draft.warehouseNames.length && !draft.zoneNames.length)) { setMessage("Chọn ít nhất một vùng hoặc một kho phụ trách trước khi kích hoạt thành viên."); return; }
    setBusy(true);
    const response = await fetch("/api/admin/telegram-pilot", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ memberId: member.id, warehouseNames: draft.warehouseNames, zoneNames: draft.zoneNames, pilotRole: draft.pilot_role, status: draft.status }) });
    const body = await response.json();
    setBusy(false);
    const dispatch = body.pilotDispatch as { scanned?: number; sent?: number; coveredCases?: number; skipped?: number; deferred?: number; failed?: number; details?: Array<{ reason?: string }> } | null | undefined;
    const dispatchNote = dispatch ? ` Đã quét ${dispatch.scanned || 0} case Miền Bắc 3: gửi ${dispatch.sent || 0} tin cho ${dispatch.coveredCases || 0} case, còn chờ lượt sau ${dispatch.deferred || 0}, bỏ qua ${dispatch.skipped || 0}, lỗi ${dispatch.failed || 0}.${dispatch.sent ? " Kiểm tra group Telegram." : dispatch.details?.[0]?.reason ? ` Lý do đầu tiên: ${dispatch.details[0].reason}.` : ""}` : "";
    setMessage(response.ok ? `Đã lưu phạm vi: ${draft.zoneNames.length} vùng, ${draft.warehouseNames.length} kho riêng cho ${member.display_name || "thành viên"}.${dispatchNote}` : body.message || body.error || "Lưu mapping thất bại.");
    if (response.ok) void load();
  };
  const saveTopic = async (topic: Topic) => {
    const draft = topicDrafts[topic.id];
    if (!draft || (!draft.provinceName && !draft.isEscalation)) { setMessage("Chọn tỉnh hoặc đánh dấu topic Escalation trước khi kích hoạt."); return; }
    setBusy(true);
    const response = await fetch("/api/admin/telegram-pilot", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ topicId: topic.id, provinceName: draft.provinceName, isEscalation: draft.isEscalation, status: draft.status }) });
    const body = await response.json();
    setBusy(false);
    setMessage(response.ok ? "Đã lưu định tuyến topic. Tin nhắc mới sẽ đi đúng topic đã kích hoạt." : body.message || body.error || "Lưu topic thất bại.");
    if (response.ok) void load();
  };
  const scopeChips = (values: string[], kind: "vùng" | "kho", onRemove: (value: string) => void) => <div className="mt-2 flex flex-wrap gap-2" aria-label={`Các ${kind} đã chọn`}>{values.map((value) => <span key={value} className={`inline-flex min-h-8 items-center gap-1 rounded-full border px-2 text-xs ${kind === "vùng" ? "border-violet-500/40 bg-violet-500/10 text-violet-100" : "border-teal-500/40 bg-teal-500/10 text-teal-100"}`}>{kind === "vùng" ? "Vùng: " : "Kho: "}{value}<button type="button" aria-label={`Bỏ ${kind} ${value}`} onClick={() => onRemove(value)} className="inline-flex min-h-6 min-w-6 items-center justify-center rounded-full hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-300"><X aria-hidden="true" size={13}/></button></span>)}</div>;
  const memberCards = (members: Member[]) => <div className="mt-3 space-y-3">{members.map((member) => {
    const draft = drafts[member.id] || memberDraft(member);
    const remainingZones = data.zoneOptions.filter((zone) => !draft.zoneNames.includes(zone));
    const remainingWarehouses = data.warehouseOptions.filter((warehouse) => !draft.warehouseNames.includes(warehouse.warehouseName));
    const hasScope = draft.zoneNames.length > 0 || draft.warehouseNames.length > 0;
    return <article key={member.id} className="grid gap-4 rounded-xl border border-slate-800 bg-slate-900 p-4 lg:grid-cols-[minmax(190px,1.15fr)_minmax(370px,2fr)_150px_150px_auto] lg:items-end">
      <div><p className="font-semibold">{member.display_name || "Chưa có tên hiển thị"}</p><p className="mt-1 text-xs text-slate-500">{member.username ? `@${member.username} · ` : ""}{groupNames.get(member.group_id) || "Group chưa xác định"}</p><p className="mt-1 font-mono text-xs text-slate-600">Telegram ID: {member.telegram_user_id}</p></div>
      <div className="space-y-3">
        <div><label className="text-sm font-medium" htmlFor={`zone-add-${member.id}`}>Vùng phụ trách <span className="text-teal-300">(gán nhanh)</span></label><select id={`zone-add-${member.id}`} value="" onChange={(event) => { if (event.target.value) patch(member.id, { zoneNames: [...draft.zoneNames, event.target.value] }); }} className="mt-1 min-h-11 w-full rounded-lg border border-violet-500/40 bg-slate-950 px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-300"><option value="">Thêm vùng: Miền Bắc 1, Miền Bắc 2…</option>{remainingZones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}</select>{scopeChips(draft.zoneNames, "vùng", (zone) => patch(member.id, { zoneNames: draft.zoneNames.filter((value) => value !== zone) }))}</div>
        <div><label className="text-sm font-medium" htmlFor={`warehouse-add-${member.id}`}>Kho riêng <span className="text-slate-400">(ngoại lệ, không bắt buộc)</span></label><select id={`warehouse-add-${member.id}`} value="" onChange={(event) => { if (event.target.value) patch(member.id, { warehouseNames: [...draft.warehouseNames, event.target.value] }); }} className="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-300"><option value="">Thêm kho từ danh mục…</option>{remainingWarehouses.map((warehouse) => <option key={warehouse.warehouseId} value={warehouse.warehouseName}>{warehouse.warehouseName} · {warehouse.zone}</option>)}</select>{scopeChips(draft.warehouseNames, "kho", (warehouse) => patch(member.id, { warehouseNames: draft.warehouseNames.filter((value) => value !== warehouse) }))}{!hasScope && <p className="mt-2 text-xs text-amber-200">Chọn ít nhất một vùng hoặc một kho để kích hoạt.</p>}</div>
      </div>
      <label className="text-sm font-medium">Vai trò<select value={draft.pilot_role} onChange={(event) => patch(member.id, { pilot_role: event.target.value as Member["pilot_role"] })} className="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3"><option value="OPERATOR">Nhân viên</option><option value="MANAGER">Manager</option></select></label>
      <label className="text-sm font-medium">Trạng thái<select value={draft.status} onChange={(event) => patch(member.id, { status: event.target.value as Member["status"] })} className="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3"><option value="PENDING">Chờ mapping</option><option value="ACTIVE">Kích hoạt</option><option value="SUSPENDED">Tạm dừng</option></select></label>
      <button type="button" onClick={() => void save(member)} disabled={busy || !hasScope} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[#00a19a] px-4 font-bold text-black disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-300"><Save aria-hidden="true" size={17}/>{member.status === "ACTIVE" ? "Cập nhật" : "Lưu & kích hoạt"}</button>
    </article>;
  })}</div>;
  return <main id="main-content" className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6">
    <header className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-sm font-semibold text-teal-300">TG-01 · GROUP ENROLLMENT</p><h1 className="mt-1 flex items-center gap-3 text-3xl font-bold"><UsersRound/>Telegram Pilot</h1><p className="mt-2 max-w-3xl text-slate-400">Group chỉ dùng để giao tiếp và ghi nhận phản hồi. Gán vùng để một nhân viên nhận việc cho toàn bộ kho trong vùng; thêm kho riêng chỉ cho ngoại lệ.</p></div><button type="button" onClick={() => void load()} disabled={busy} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-teal-800 px-4 font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-300"><RefreshCw aria-hidden="true" size={17}/>{busy ? "Đang xử lý…" : "Làm mới"}</button></header>
    {message && <p role="status" className="mt-5 rounded-lg border border-teal-700 bg-teal-950/40 p-3 text-sm">{message}</p>}
    <section className="mt-6 grid gap-4 lg:grid-cols-3"><article className="rounded-xl border border-slate-800 bg-slate-900 p-5"><p className="text-xs font-bold uppercase tracking-wide text-teal-300">1. Thêm bot vào group</p><p className="mt-2 text-sm text-slate-300">Bật webhook trước khi dùng. Bot chỉ nhận đăng ký từ group/supergroup.</p></article><article className="rounded-xl border border-slate-800 bg-slate-900 p-5"><p className="text-xs font-bold uppercase tracking-wide text-teal-300">2. Nhân viên gõ /join</p><p className="mt-2 text-sm text-slate-300">Hệ thống ghi nhận Telegram ID; không đoán theo tên hoặc username.</p></article><article className="rounded-xl border border-slate-800 bg-slate-900 p-5"><p className="text-xs font-bold uppercase tracking-wide text-teal-300">3. Gán phạm vi</p><p className="mt-2 text-sm text-slate-300">Chọn vùng trước để gán nhanh; thêm kho lẻ nếu nhân viên phụ trách ngoại lệ.</p></article></section>
    <section className="mt-6 rounded-xl border border-slate-800 bg-slate-900 p-5"><h2 className="font-bold">Group đang hoạt động ({activeGroups.length})</h2><div className="mt-3 space-y-2">{activeGroups.length ? activeGroups.map((group) => <div key={group.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm"><span className="font-semibold">{group.title || "Telegram group"}</span><span className="font-mono text-xs text-slate-400">chat {group.telegram_chat_id}</span></div>) : <p className="rounded-lg border border-dashed border-slate-700 p-4 text-sm text-slate-400">Chưa có group. Thêm bot, cấu hình webhook, rồi để một thành viên gõ <code>/join</code>.</p>}</div>{data.groups.length > activeGroups.length && <p className="mt-3 text-xs text-slate-500">Các group lịch sử đã tạm dừng được giữ trong audit nhưng không dùng để nhận tin nhắc.</p>}</section>
    <section className="mt-6 rounded-xl border border-violet-500/30 bg-violet-500/5 p-5"><div className="flex flex-wrap items-baseline justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-wide text-violet-200">TG-07 · Forum topic routing</p><h2 className="mt-1 font-bold text-violet-50">Topic Miền Bắc 3 ({data.topics.length})</h2></div><p className="max-w-xl text-xs leading-5 text-violet-100/80">Telegram không cho bot liệt kê topic cũ. Trong từng topic, gửi <code>/join Tên tỉnh</code> (ví dụ <code>/join Lào Cai</code>), rồi bấm Làm mới và gán phạm vi bên dưới.</p></div>{data.topics.length ? <div className="mt-4 space-y-3">{data.topics.map((topic) => { const draft = topicDrafts[topic.id] || { provinceName: "", isEscalation: false, status: "PENDING" }; return <article key={topic.id} className="grid gap-3 rounded-lg border border-violet-500/25 bg-slate-950/60 p-4 lg:grid-cols-[minmax(180px,1fr)_minmax(180px,1fr)_150px_auto] lg:items-end"><div><p className="font-semibold text-slate-100">{topic.topic_title || `Topic #\${topic.message_thread_id}`}</p><p className="mt-1 font-mono text-xs text-slate-500">thread {topic.message_thread_id}</p></div><label className="text-sm font-medium">Định tuyến<select value={draft.isEscalation ? "__ESCALATION__" : draft.provinceName} onChange={(event) => { const value = event.target.value; patchTopic(topic.id, { provinceName: value === "__ESCALATION__" ? "" : value, isEscalation: value === "__ESCALATION__" }); }} className="mt-1 min-h-11 w-full rounded-lg border border-violet-500/40 bg-slate-950 px-3"><option value="">Chọn tỉnh Miền Bắc 3…</option>{data.provinceOptions.map((province) => <option key={province} value={province}>{province}</option>)}<option value="__ESCALATION__">Chưa xác định / Escalation</option></select></label><label className="text-sm font-medium">Trạng thái<select value={draft.status} onChange={(event) => patchTopic(topic.id, { status: event.target.value as Topic["status"] })} className="mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3"><option value="PENDING">Chờ mapping</option><option value="ACTIVE">Kích hoạt</option><option value="SUSPENDED">Tạm dừng</option></select></label><button type="button" onClick={() => void saveTopic(topic)} disabled={busy || (!draft.provinceName && !draft.isEscalation)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-violet-500 px-4 text-sm font-bold text-white hover:bg-violet-400 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-200"><Save aria-hidden="true" size={17}/>Lưu topic</button></article>; })}</div> : <p className="mt-4 rounded-lg border border-dashed border-violet-500/40 p-4 text-sm text-violet-100/80">Chưa có topic nào được bot nhận diện. Gửi <code>/join Lào Cai</code>, <code>/join Điện Biên</code>… ngay trong từng topic rồi làm mới trang này.</p>}</section>
    <section className="mt-6"><div className="flex items-baseline justify-between gap-4"><h2 className="font-bold">Thành viên chờ mapping ({pendingMembers.length})</h2><p className="text-xs text-slate-500">Quyền và phạm vi dựa trên Telegram ID đã lưu.</p></div>{memberCards(pendingMembers)}{!pendingMembers.length && <p className="mt-3 rounded-xl border border-dashed border-slate-700 p-5 text-center text-sm text-slate-400">Không còn thành viên chờ mapping.</p>}</section>
    <section className="mt-6"><div className="flex items-baseline justify-between gap-4"><h2 className="font-bold">Thành viên đang hoạt động ({configuredMembers.length})</h2><p className="text-xs text-teal-300">Gán vùng áp dụng cho mọi kho thuộc vùng khi gửi work order.</p></div>{memberCards(configuredMembers)}{historicalMemberCount > 0 && <p className="mt-3 text-xs text-slate-500">{historicalMemberCount} bản ghi lịch sử đã tạm dừng được giữ cho audit và không thể nhận tin nhắc.</p>}</section>
    <section className="mt-6 rounded-xl border border-amber-500/30 bg-amber-500/5 p-5"><h2 className="flex items-center gap-2 font-bold text-amber-100"><MapPinned aria-hidden="true" size={18}/>Nguyên tắc phạm vi</h2><p className="mt-2 text-sm leading-6 text-amber-50/80">Một nhân viên có thể có nhiều vùng và kho riêng. Nếu work order thuộc kho trong vùng đã gán, người đó sẽ xuất hiện trong danh sách nhận việc; không cần map từng kho.</p></section>
  </main>;
}
