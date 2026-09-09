import { authkitMiddleware } from "@workos-inc/authkit-nextjs";
import type { NextRequest, NextFetchEvent } from "next/server";

const authkitMiddlewareHandler = authkitMiddleware();

export default async function middleware(
  request: NextRequest,
  event: NextFetchEvent,
) {
  const { pathname } = request.nextUrl;

  // AuthKit owns these paths (sign-in redirect, callback) and Next owns its own
  // assets, so they must never pick up extra checks here.
  if (
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/login") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon")
  ) {
    return authkitMiddlewareHandler(request, event);
  }

  // Nothing is gated at the edge: the app is anonymous-first. Every API route
  // guards itself with requireAuth (401) or opts into getOptionalAuth, so the
  // middleware only hydrates the session for signed-in visitors.
  return authkitMiddlewareHandler(request, event);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|favicon.png|favicon.jpeg|icon|apple-icon).*)",
  ],
};
