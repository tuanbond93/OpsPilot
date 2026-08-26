import { safePostLoginPath } from "@/security/route-policy";

export function apiAccessMessage(status: number, payload?: Record<string, unknown>, fallback = "Yêu cầu không thành công.") {
  if (status === 401) return "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.";
  if (status === 403) return "Tài khoản hiện tại không có quyền thực hiện thao tác này.";
  const message = payload?.message ?? payload?.error;
  return typeof message === "string" && message ? message : fallback;
}

export function handleApiAccess(response: Response, payload?: Record<string, unknown>, fallback?: string) {
  if (response.ok) return;
  if (response.status === 401 && typeof window !== "undefined") {
    const current = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`/account?next=${encodeURIComponent(safePostLoginPath(current))}`);
  }
  throw new Error(apiAccessMessage(response.status, payload, fallback));
}
