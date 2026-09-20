import { describe, expect, it } from "vitest";
import fs from "node:fs";

describe("dashboard incident order-count semantics", () => {
  it("labels the incident-scoped metric explicitly and does not claim a warehouse total", () => {
    const page = fs.readFileSync("src/app/dashboard/page.tsx", "utf8");
    expect(page).toContain(">Đơn trong case</th>");
    expect(page).toContain("Số đơn bị ảnh hưởng bởi case này; không phải tổng tồn hiện tại của kho.");
    expect(page).not.toContain(">Số đơn</th>");
  });
});
