"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { roleCan, roleFromMetadata, type OpsPermission, type OpsRole } from "@/security/roles";

export interface OpsSessionState {
  loading: boolean;
  actor: string;
  userId: string;
  role: OpsRole;
  authenticated: boolean;
  can: (permission: OpsPermission) => boolean;
}

export function useOpsSession(): OpsSessionState {
  const [state, setState] = useState({ loading: true, actor: "", userId: "", role: "OPERATOR" as OpsRole, authenticated: false });

  useEffect(() => {
    const supabase = createClient();
    const applyUser = (user: { id: string; email?: string; app_metadata?: Record<string, unknown>; user_metadata?: Record<string, unknown> } | null) => setState({
      loading: false,
      actor: user?.email || user?.id || "",
      userId: user?.id || "",
      role: user ? roleFromMetadata(user.app_metadata, user.user_metadata) : "OPERATOR",
      authenticated: Boolean(user),
    });
    void supabase.auth.getUser().then(({ data }) => applyUser(data.user));
    const { data } = supabase.auth.onAuthStateChange((_event, session) => applyUser(session?.user ?? null));
    return () => data.subscription.unsubscribe();
  }, []);

  return useMemo(() => ({ ...state, can: (permission: OpsPermission) => state.authenticated && roleCan(state.role, permission) }), [state]);
}
