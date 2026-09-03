export type FollowupDeliverySummaryItem = {
  province: string;
  warehouse: string;
  stage: string;
  coveredCases: number;
  status: "SUCCESS" | "FAILED";
  error?: string;
};

export type RillnetReviewSummaryItem = {
  province: string;
  warehouse: string;
  affectedOrders: number;
  status: "SUCCESS" | "FAILED";
  error?: string;
};

const esc = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function formatFollowupDeliverySummary(items: FollowupDeliverySummaryItem[], completedAt = new Date(), reviews: RillnetReviewSummaryItem[] = []) {
  const provinces = new Map<string, { batches: number; cases: number; success: number; failed: number }>();
  for (const item of items) {
    const row = provinces.get(item.province) || { batches: 0, cases: 0, success: 0, failed: 0 };
    row.batches += 1;
    row.cases += item.coveredCases;
    row[item.status === "SUCCESS" ? "success" : "failed"] += 1;
    provinces.set(item.province, row);
  }
  const totalCases = items.reduce((sum, item) => sum + item.coveredCases, 0);
  const success = items.filter((item) => item.status === "SUCCESS").length;
  const failed = items.length - success;
  const rows = [...provinces.entries()].sort(([a], [b]) => a.localeCompare(b, "vi"))
    .map(([province, row]) => `${esc(province)}: ${row.batches} batch / ${row.cases} case · ✅ ${row.success} · ❌ ${row.failed}`);
  const failures = items.filter((item) => item.status === "FAILED").slice(0, 10)
    .map((item) => `• ${esc(item.province)} · ${esc(item.warehouse)} · ${esc(item.stage)}: ${esc(item.error || "Không rõ lỗi")}`);
  const reviewRows = reviews.map((item) =>
    `${item.status === "SUCCESS" ? "✅" : "❌"} ${esc(item.province)} · ${esc(item.warehouse)}: 1 case · ${item.affectedOrders} đơn ảnh hưởng`
  );
  const reviewFailures = reviews.filter((item) => item.status === "FAILED" && item.error).slice(0, 10)
    .map((item) => `• ${esc(item.province)} · ${esc(item.warehouse)}: ${esc(item.error || "Không rõ lỗi")}`);
  return [
    "<b>BÁO CÁO GỬI PUSH VẬN HÀNH</b>",
    `Hoàn tất: ${completedAt.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}`,
    "",
    "<b>1. RILLNET REVIEW MỚI</b>",
    ...(reviewRows.length ? reviewRows : ["Không có review mới được gửi."]),
    "",
    "<b>2. FOLLOW-UP ĐÃ GỬI</b>",
    "Chỉ tính batch nhắc follow-up; không bao gồm Rillnet review ở mục 1.",
    `Tổng follow-up: <b>${items.length} batch / ${totalCases} case</b> · ✅ ${success} · ❌ ${failed}`,
    "",
    ...(rows.length ? rows : ["Không có follow-up mới được gửi."]),
    ...((failures.length || reviewFailures.length) ? ["", "<b>Lỗi cần kiểm tra</b>", ...reviewFailures, ...failures] : []),
  ].join("\n");
}
