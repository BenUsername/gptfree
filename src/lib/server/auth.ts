import "server-only";

import { authkit } from "@workos-inc/authkit-nextjs";
import { NextRequest, NextResponse } from "next/server";

import { supabase } from "@/lib/server/supabase-server";

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  workosUserId: string;
  hasCommercialConsent: boolean;
}

type ResolvedAuth =
  | { ok: true; user: AuthUser }
  | { ok: false; reason: "unauthenticated" | "profile_sync_failed" };

/**
 * Resolves the AuthKit session into a gptfree_users row. Shared by requireAuth
 * (which turns failures into HTTP responses) and getOptionalAuth (which turns
 * them into null).
 */
async function resolveAuth(request: NextRequest): Promise<ResolvedAuth> {
  try {
    const { session } = await authkit(request);
    if (!session?.user?.email) {
      return { ok: false, reason: "unauthenticated" };
    }

    const {
      email,
      firstName,
      lastName,
      id: workosUserId,
    } = session.user;

    const profilePictureUrl =
      "profilePictureUrl" in session.user &&
      typeof session.user.profilePictureUrl === "string"
        ? session.user.profilePictureUrl
        : null;

    const name = [firstName, lastName].filter(Boolean).join(" ") || null;
    const now = new Date().toISOString();

    const { data: user, error } = await supabase
      .from("gptfree_users")
      .upsert(
        {
          email,
          name,
          first_name: firstName ?? null,
          last_name: lastName ?? null,
          workos_user_id: workosUserId,
          profile_picture_url: profilePictureUrl ?? null,
          avatar_url: profilePictureUrl ?? null,
          last_sign_in_at: now,
          updated_at: now,
        },
        { onConflict: "email" },
      )
      .select("id, email, name, first_name, last_name, workos_user_id, commercial_consent_at")
      .single();

    if (error || !user) {
      console.error("[gptfree auth] Failed to upsert user:", error?.message);
      return { ok: false, reason: "profile_sync_failed" };
    }

    return {
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        firstName: user.first_name,
        lastName: user.last_name,
        workosUserId: user.workos_user_id,
        hasCommercialConsent: Boolean(user.commercial_consent_at),
      },
    };
  } catch {
    return { ok: false, reason: "unauthenticated" };
  }
}

export async function requireAuth(
  request: NextRequest,
): Promise<AuthUser | NextResponse> {
  const resolved = await resolveAuth(request);

  if (resolved.ok) return resolved.user;

  if (resolved.reason === "profile_sync_failed") {
    return NextResponse.json({ error: "Failed to sync user profile" }, {
      status: 500,
    });
  }

  return NextResponse.json({ error: "Authentication required" }, {
    status: 401,
  });
}

/**
 * Like requireAuth, but every failure path (no session, no email, upsert
 * error, thrown exception) yields null so the caller can serve anonymous
 * visitors instead of rejecting them.
 */
export async function getOptionalAuth(
  request: NextRequest,
): Promise<AuthUser | null> {
  const resolved = await resolveAuth(request);
  return resolved.ok ? resolved.user : null;
}

export async function recordVisit(
  user: AuthUser,
  request: NextRequest,
  path = "/",
): Promise<void> {
  const userAgent = request.headers.get("user-agent");

  const { error } = await supabase.from("gptfree_visits").insert({
    user_id: user.id,
    email: user.email,
    path,
    user_agent: userAgent,
  });

  if (error) {
    console.error("[gptfree visits] Failed to record visit:", error.message);
  }
}

export function getInitials(name: string | null, email: string): string {
  if (name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
    }
    return parts[0].slice(0, 2).toUpperCase();
  }

  const local = email.split("@")[0] ?? email;
  return local.slice(0, 2).toUpperCase();
}

export async function recordCommercialConsent(userId: string): Promise<void> {
  const now = new Date().toISOString();

  const { error } = await supabase
    .from("gptfree_users")
    .update({
      commercial_consent_at: now,
      updated_at: now,
    })
    .eq("id", userId);

  if (error) {
    throw new Error(error.message);
  }
}

export function requireCommercialConsent(auth: AuthUser): NextResponse | null {
  if (auth.hasCommercialConsent) return null;

  return NextResponse.json(
    { error: "Commercial data usage consent is required" },
    { status: 403 },
  );
}
