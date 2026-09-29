import { repairOperationalText } from "./operationalText";

export function usableApprovalText(value: unknown): string | null {
  const text = repairOperationalText(value).trim();
  if (!text || text === "—" || /(?:not valid json|json parse|schema error|provider\/model error|ai response)/i.test(text)) {
    return null;
  }
  return text;
}

export function actionableApprovalRecommendation(value: unknown): string | null {
  const text = usableApprovalText(value);
  if (!text || /^(?:ưu tiên|tiếp tục theo dõi|xử lý sớm|kiểm tra tình hình).*$/i.test(text)) {
    return null;
  }
  return text;
}
