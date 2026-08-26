import { describe, expect, it } from "vitest";
import { journeyFor, type IncidentOrderJourneySource } from "@/app/incidents/[incidentId]/orderJourney";

describe("incident order journey", () => {
  it("shows the Rillnet pickup, transit and delivery warehouses for GY8N9V8T", () => {
    const points = journeyFor({
      order_code: "GY8N9V8T",
      warehouse_id: "21160000",
      warehouse_name: "Kho Giao Hàng Nặng Việt Trì-Phú Thọ",
      source_status: "delivering",
      order_created_at: "2026-08-14T09:43:39.806Z",
      source_updated_at: "2026-08-23T10:08:31.000Z",
      pick_warehouse_id: "1327",
      deliver_warehouse_id: "21160000",
      end_pick_at: "2026-08-20T14:52:47.058Z",
      warehouse_log: [{ current_warehouse_id: 21652000, updated_date: { $date: "2026-08-23T00:47:27.966Z" }, return_warehouse_id: 1327 }],
    }, {
      "1327": "Kho KH lớn HCM",
      "21652000": "Kho Chuyển Tiếp Phú Thọ 01",
      "21160000": "Kho Giao Hàng Nặng Việt Trì-Phú Thọ",
    }, []);

    expect(points.map((point) => [point.label, point.detail, point.done])).toEqual([
      ["Lên đơn", undefined, true],
      ["Kho lấy", "Kho KH lớn HCM", true],
      ["Kho trung chuyển", "Kho Chuyển Tiếp Phú Thọ 01", true],
      ["Kho giao", "Kho Giao Hàng Nặng Việt Trì-Phú Thọ", true],
      ["Hoàn tất giao", "Chưa hoàn tất", false],
    ]);
  });
  it("reads the actual Rillnet warehouse_log schema and keeps the transit warehouse", () => {
    const order: IncidentOrderJourneySource = {
      order_code: "GY8K9UQ9",
      warehouse_id: "22680000",
      warehouse_name: "(LCH) Tân Phong",
      source_status: "delivered",
      order_created_at: "2026-08-19T10:11:02.701Z",
      source_updated_at: "2026-08-23T03:27:16.475Z",
      pick_warehouse_id: "22958000",
      deliver_warehouse_id: "22680000",
      end_pick_at: "2026-08-20T13:35:44.820Z",
      end_success_at: "2026-08-23T03:27:16.475Z",
      warehouse_log: [{ current_warehouse_id: 20818000, updated_date: { $date: "2026-08-21T23:47:46.339Z" } }],
    };
    const points = journeyFor(order, {
      "22958000": "Kho B2B Hưng Yên - Hưng Yên",
      "20818000": "Kho Chuyển Tiếp Lào Cai",
      "22680000": "Bưu Cục 131 Lê Duẩn-Tân Phong-Lai Châu",
    }, []);
    expect(points.map((point) => point.label)).toEqual(["Lên đơn", "Kho lấy", "Kho trung chuyển", "Kho giao", "Hoàn tất giao"]);
    expect(points.find((point) => point.label === "Kho trung chuyển")).toMatchObject({ detail: "Kho Chuyển Tiếp Lào Cai", at: "2026-08-21T23:47:46.339Z", done: true });
    expect(points.every((point) => point.done)).toBe(true);
    expect(points.find((point) => point.slowest)).toMatchObject({
      label: "Kho trung chuyển",
      detail: "Kho Chuyển Tiếp Lào Cai",
      durationFromPreviousHours: 34.2,
    });
  });

  it("does not place a stale delivery snapshot before a newer transit log", () => {
    const points = journeyFor({
      order_code: "GY8K9U44_CPTT",
      warehouse_id: "22328000",
      warehouse_name: "Kho B2B - Đài Tư - Hà Nội",
      source_status: "transporting",
      order_created_at: "2026-08-22T03:49:48.538Z",
      source_updated_at: "2026-08-23T04:07:19.000Z",
      pick_warehouse_id: "22680000",
      deliver_warehouse_id: "22328000",
      end_pick_at: "2026-08-22T03:49:50.276Z",
      warehouse_log: [{ current_warehouse_id: 1121, updated_date: { $date: "2026-08-24T07:44:52.445Z" } }],
    }, {
      "1121": "Kho Trung Chuyển Hà Nội 02",
      "22328000": "Kho B2B - Đài Tư - Hà Nội",
      "22680000": "Bưu Cục 131 Lê Duẩn-Tân Phong-Lai Châu",
    }, [{ warehouse_id: "22328000", warehouse_name: "Kho B2B - Đài Tư - Hà Nội", source_updated_at: "2026-08-23T04:07:19.000Z" }]);

    expect(points.find((point) => point.label === "Kho trung chuyển")).toMatchObject({ done: true, current: true, at: "2026-08-24T07:44:52.445Z" });
    expect(points.find((point) => point.label === "Kho giao")).toMatchObject({ done: false, at: undefined, current: false });
    expect(points.find((point) => point.slowest)).toMatchObject({ label: "Kho trung chuyển", durationFromPreviousHours: 51.9 });
  });
});
