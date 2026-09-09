import "server-only";

import { createHmac } from "node:crypto";
import type { NextRequest } from "next/server";

import { supabase } from "@/lib/server/supabase-server";

/** Messages an anonymous IP may send per UTC day. */
export const ANON_DAILY_MESSAGE_LIMIT = 25;

export const ANON_LIMIT_MESSAGE =
  `You've reached the free anonymous limit of ${ANON_DAILY_MESSAGE_LIMIT} messages for today. Sign in to keep chatting and to save your conversations.`;

export const ANON_LIMIT_UNAVAILABLE_MESSAGE =
  "Anonymous chat is temporarily unavailable. Please sign in or try again later.";

function usageSalt(): string | null {
  // A dedicated salt is preferred; the service role key is a server-only
  // secret that already exists, so it keeps hashes non-reversible without
  // requiring a new env var to be provisioned first.
  return process.env.ANON_IP_SALT || process.env.SUPABASE_SERVICE_ROLE_KEY || null;
}

/**
 * Derives a stable, non-reversible identifier for the caller. Raw IPs are
 * never returned or stored.
 */
export function getClientIpHash(request: NextRequest): string | null {
  const forwardedFor = request.headers.get("x-forwarded-for");
  const ip =
    forwardedFor?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "";

  if (!ip) return null;

  const salt = usageSalt();
  if (!salt) {
    console.error("[gptfree anon-usage] No ANON_IP_SALT configured");
    return null;
  }

  return createHmac("sha256", salt).update(ip).digest("hex");
}

export type AnonUsageResult =
  | { allowed: true; count: number }
  | { allowed: false; reason: "over_limit" | "unavailable" };

/**
 * Atomically increments today's counter for this IP and reports whether the
 * request is still within the daily cap. Fails closed: an unmeasurable
 * request is refused rather than handed a free pass to the provider keys.
 */
export async function recordAnonUsage(
  request: NextRequest,
): Promise<AnonUsageResult> {
  const ipHash = getClientIpHash(request);
  if (!ipHash) {
    return { allowed: false, reason: "unavailable" };
  }

  const day = new Date().toISOString().slice(0, 10);

  const { data, error } = await supabase.rpc("gptfree_bump_anon_usage", {
    p_ip_hash: ipHash,
    p_day: day,
  });

  if (error || typeof data !== "number") {
    console.error(
      "[gptfree anon-usage] Failed to record usage:",
      error?.message ?? "unexpected response",
    );
    return { allowed: false, reason: "unavailable" };
  }

  if (data > ANON_DAILY_MESSAGE_LIMIT) {
    return { allowed: false, reason: "over_limit" };
  }

  return { allowed: true, count: data };
}
