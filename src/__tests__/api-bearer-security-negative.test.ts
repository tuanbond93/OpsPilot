import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetUser = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: () =>
    Promise.resolve({
      auth: {
        getUser: (token?: string) => mockGetUser(token),
      },
    }),
}));

import { authorizeApiRequest, resetRateLimitsForTests } from "@/security/api-security";
import { validateVehicleAvailabilityInput } from "@/domain/near-term-capacity/multi-option/sources/vehicle-availability-service";

describe("OpsPilot Gate 3D.4 — Bearer Auth Negative & Role Enforcement Security Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTH_ENFORCEMENT_ENABLED = "true";
    resetRateLimitsForTests();
  });

  afterEach(() => {
    delete process.env.AUTH_ENFORCEMENT_ENABLED;
    resetRateLimitsForTests();
  });

  // 1. NO_AUTH -> 401
  it("1. NO_AUTH: missing Bearer token and session cookies returns 401 AUTHENTICATION_REQUIRED", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: "Auth session missing" } });

    const req = new NextRequest("http://localhost:3000/api/internal/governed-sources/vehicle-availability", {
      method: "POST",
    });

    const res = await authorizeApiRequest(req, "VIEW_SYSTEM");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(401);
      const body = await res.response.json();
      expect(body.error).toBe("AUTHENTICATION_REQUIRED");
    }
  });

  // 2. RANDOM_BEARER -> 401
  it("2. RANDOM_BEARER: arbitrary/random Bearer token rejected with 401 AUTHENTICATION_REQUIRED", async () => {
    mockGetUser.mockImplementation((token?: string) => {
      if (token === "random_untrusted_bearer_token_xyz") {
        return Promise.resolve({ data: { user: null }, error: { message: "Invalid token signature" } });
      }
      return Promise.resolve({ data: { user: null }, error: { message: "Auth session missing" } });
    });

    const req = new NextRequest("http://localhost:3000/api/internal/governed-sources/vehicle-availability", {
      method: "POST",
      headers: {
        authorization: "Bearer random_untrusted_bearer_token_xyz",
      },
    });

    const res = await authorizeApiRequest(req, "VIEW_SYSTEM");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(401);
      const body = await res.response.json();
      expect(body.error).toBe("AUTHENTICATION_REQUIRED");
    }
    expect(mockGetUser).toHaveBeenCalledWith("random_untrusted_bearer_token_xyz");
  });

  // 3. MALFORMED_BEARER -> 401
  it("3. MALFORMED_BEARER: malformed non-JWT bearer string rejected with 401 AUTHENTICATION_REQUIRED", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: "Malformed token" } });

    const req = new NextRequest("http://localhost:3000/api/internal/governed-sources/vehicle-availability", {
      method: "POST",
      headers: {
        authorization: "Bearer not-a-jwt.at.all",
      },
    });

    const res = await authorizeApiRequest(req, "VIEW_SYSTEM");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(401);
      const body = await res.response.json();
      expect(body.error).toBe("AUTHENTICATION_REQUIRED");
    }
    expect(mockGetUser).toHaveBeenCalledWith("not-a-jwt.at.all");
  });

  // 4. EXPIRED_TOKEN -> 401
  it("4. EXPIRED_TOKEN: cryptographically signed but expired token rejected with 401 AUTHENTICATION_REQUIRED", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: "JWT expired" } });

    const req = new NextRequest("http://localhost:3000/api/internal/governed-sources/vehicle-availability", {
      method: "POST",
      headers: {
        authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.expired.token",
      },
    });

    const res = await authorizeApiRequest(req, "VIEW_SYSTEM");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(401);
      const body = await res.response.json();
      expect(body.error).toBe("AUTHENTICATION_REQUIRED");
    }
  });

  // 5. LOW_PRIVILEGE_VALID_USER -> 403
  it("5. LOW_PRIVILEGE_VALID_USER: valid user with role VIEWER/OPERATOR rejected with 403 PERMISSION_DENIED", async () => {
    mockGetUser.mockResolvedValue({
      data: {
        user: {
          id: "u-viewer-01",
          email: "viewer@ops.vn",
          app_metadata: { role: "VIEWER" },
          user_metadata: {},
        },
      },
      error: null,
    });

    const req = new NextRequest("http://localhost:3000/api/internal/governed-sources/vehicle-availability", {
      method: "POST",
      headers: {
        authorization: "Bearer valid_viewer_jwt",
      },
    });

    // Requesting MANAGE_DECISION or MANAGE_SYSTEM requires higher role than VIEWER
    const res = await authorizeApiRequest(req, "MANAGE_DECISION");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(403);
      const body = await res.response.json();
      expect(body.error).toBe("PERMISSION_DENIED");
      expect(body.requiredPermission).toBe("MANAGE_DECISION");
    }
  });

  // 6. BODY_ROLE_SPOOF -> 403
  it("6. BODY_ROLE_SPOOF: request body role self-promotion is blocked with 403 ROLE_MISMATCH", () => {
    const validServerIdentity = {
      userId: "u-ops-mgr",
      actor: "manager@ops.vn",
      role: "MANAGER" as const,
      userMetadata: { opspilot_operational_role: "OPERATIONS_MANAGER" },
      appMetadata: {},
    };

    // Body attempts to claim a mismatched or promoted role
    const spoofedInput = {
      warehouse_id: "21161000",
      supplier_name: "Hoàng Minh",
      vehicle_class: "TRUCK_1_9T",
      available_count: 1,
      earliest_available_at: "2026-09-19T07:00:00+07:00",
      valid_until: "2026-09-19T14:00:00+07:00",
      supplier_role: "WAREHOUSE_LEAD", // Mismatch with authenticated OPERATIONS_MANAGER
    };

    const res = validateVehicleAvailabilityInput(spoofedInput, {
      isCron: false,
      identity: validServerIdentity,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(403);
      expect(res.error).toContain("ROLE_MISMATCH");
    }
  });

  // 7. SERVICE_CREDENTIAL_AS_MANAGER -> 403
  it("7. SERVICE_CREDENTIAL_AS_MANAGER: service credential cannot impersonate human manager (403 FORBIDDEN_IMPERSONATION)", () => {
    const serviceInput = {
      warehouse_id: "21161000",
      supplier_name: "Hoàng Minh",
      vehicle_class: "TRUCK_1_9T",
      available_count: 1,
      earliest_available_at: "2026-09-19T07:00:00+07:00",
      valid_until: "2026-09-19T14:00:00+07:00",
      supplied_by: "telegram:human_ops_lead", // Attempting to impersonate human Telegram actor under CRON
      supplier_role: "OPERATIONS_MANAGER",
    };

    const res = validateVehicleAvailabilityInput(serviceInput, {
      isCron: true,
      identity: null,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(403);
      expect(res.error).toContain("FORBIDDEN_IMPERSONATION");
    }
  });

  // 8. VALID_MANAGER -> authorized
  it("8. VALID_MANAGER: valid OPERATIONS_MANAGER bearer token succeeds with server-derived identity", async () => {
    mockGetUser.mockResolvedValue({
      data: {
        user: {
          id: "u-ops-mgr-01",
          email: "manager@ops.vn",
          app_metadata: { opspilot_role: "MANAGER" },
          user_metadata: { opspilot_operational_role: "OPERATIONS_MANAGER" },
        },
      },
      error: null,
    });

    const req = new NextRequest("http://localhost:3000/api/internal/governed-sources/vehicle-availability", {
      method: "POST",
      headers: {
        authorization: "Bearer valid_ops_manager_jwt",
      },
    });

    const res = await authorizeApiRequest(req, "VIEW_SYSTEM");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.identity?.userId).toBe("u-ops-mgr-01");
      expect(res.identity?.actor).toBe("manager@ops.vn");
      expect(res.identity?.role).toBe("MANAGER");
    }
  });
});
