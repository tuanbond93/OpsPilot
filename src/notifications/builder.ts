import type { NotificationActionRow } from "../engine/action-queue";
import { NotificationFormatter, type StructuredNotification } from "./formatter";

export class NotificationBuilder {
  /**
   * Converts a NotificationAction into a formatted structured notification
   */
  static build(action: NotificationActionRow): StructuredNotification {
    const payload = action.payload || {};

    const warehouseName = String(payload.warehouse || payload.warehouseName || "Kho chưa xác định");
    const reasonName = String(payload.reason || payload.reasonName || "Sự cố vận hành");
    const currentCount = Number(payload.currentCount || payload.affectedOrderCount || 0);
    const baselineCount = Number(payload.baselineCount || currentCount || 0);
    const progressPercent = Number(payload.progressPercent || 0);
    const assessment = String(payload.progressAssessment || payload.assessment || "monitoring");
    const riskScore = Number(payload.riskScore || 50);
    const riskLevel = String(payload.riskLevel || (riskScore >= 75 ? "critical" : riskScore >= 50 ? "high" : "medium"));
    const summary = String(payload.rootCauseSummary || payload.summary || "Sự cố đang được hệ thống theo dõi.");

    let title = "Thông Báo Vận Hành";
    if (action.action_type === "FIRST_PUSH") title = "⚡ PUSH LẦN 1 - CẢNH BÁO TỒN ĐỌNG";
    if (action.action_type === "SECOND_PUSH") title = "🔥 PUSH LẦN 2 - TỒN ĐỌNG CHƯA GIẢM";
    if (action.action_type === "ESCALATION") title = "🚨 ESCALATION - YÊU CẦU QUẢN LÝ XỬ LÝ";
    if (action.action_type === "ROOTCAUSE_SUMMARY") title = "📋 PHÂN TÍCH NGUYÊN NHÂN GỐC RỄ";
    if (action.action_type === "WARNING") title = "⚠️ CẢNH BÁO VẬN HÀNH";

    return {
      title,
      warehouseName,
      reasonName,
      currentCount,
      baselineCount,
      progressPercent,
      assessment,
      riskScore,
      riskLevel,
      summary,
      state: action.status,
    };
  }

  static buildMarkdownText(action: NotificationActionRow): string {
    const notif = this.build(action);
    return NotificationFormatter.toTelegramMarkdown(notif);
  }
}
