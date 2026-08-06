export interface StructuredNotification {
  title: string;
  warehouseName: string;
  reasonName: string;
  currentCount: number;
  baselineCount: number;
  progressPercent: number;
  assessment: string;
  riskScore: number;
  riskLevel: string;
  summary: string;
  state: string;
}

export class NotificationFormatter {
  static toTelegramMarkdown(notif: StructuredNotification): string {
    const icon = notif.riskLevel === "critical" ? "🔴" : notif.riskLevel === "high" ? "🟠" : "🟡";
    return [
      `*${icon} ${notif.title}*`,
      `📍 *Kho:* ${notif.warehouseName}`,
      `⚠️ *Loại sự cố:* ${notif.reasonName}`,
      `📦 *Số đơn ảnh hưởng:* ${notif.currentCount} (Gốc: ${notif.baselineCount})`,
      `📊 *Tiến độ xử lý:* ${notif.progressPercent > 0 ? "+" : ""}${notif.progressPercent}% (${notif.assessment})`,
      `🔥 *Điểm rủi ro:* ${notif.riskScore}/100 [${notif.riskLevel.toUpperCase()}]`,
      `🔄 *Trạng thái:* \`${notif.state}\``,
      ``,
      `📝 *Đánh giá OpsPilot:*`,
      `${notif.summary}`,
    ].join("\n");
  }

  static toPlainText(notif: StructuredNotification): string {
    return [
      `[${notif.title}]`,
      `Kho: ${notif.warehouseName}`,
      `Sự cố: ${notif.reasonName}`,
      `Đơn ảnh hưởng: ${notif.currentCount}/${notif.baselineCount}`,
      `Tiến độ: ${notif.progressPercent}% (${notif.assessment})`,
      `Rủi ro: ${notif.riskScore}/100`,
      `Trạng thái: ${notif.state}`,
      `Nội dung: ${notif.summary}`,
    ].join("\n");
  }

  static toHtml(notif: StructuredNotification): string {
    return `
      <div style="font-family: sans-serif; padding: 16px; border: 1px solid #e2e8f0; border-radius: 8px;">
        <h3 style="margin-top: 0; color: #1e293b;">${notif.title}</h3>
        <p><strong>Kho:</strong> ${notif.warehouseName}</p>
        <p><strong>Sự cố:</strong> ${notif.reasonName}</p>
        <p><strong>Số đơn:</strong> ${notif.currentCount} (Gốc: ${notif.baselineCount})</p>
        <p><strong>Tiến độ:</strong> ${notif.progressPercent}% (${notif.assessment})</p>
        <p><strong>Trạng thái:</strong> <code>${notif.state}</code></p>
        <blockquote style="background: #f8fafc; border-left: 4px solid #3b82f6; padding: 8px 12px; margin: 0;">
          ${notif.summary}
        </blockquote>
      </div>
    `;
  }
}
