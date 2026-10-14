import { NextResponse, type NextRequest } from "next/server";

/**
 * Password gate for every page and API route (SPEC 2, 8.1, 8.12).
 *
 * Next.js 16 renamed the `middleware` file convention to `proxy`; this file is
 * the "middleware.ts" the SPEC refers to, using the current convention.
 *
 * Session cookie contract (issued by POST /api/login):
 *   tapedeck_session = "<expiryUnix>.<HMAC-SHA256(expiryUnix, SESSION_SECRET) in lowercase hex>"
 * The HMAC key is the raw UTF-8 bytes of SESSION_SECRET and the message is the
 * expiry decimal string. The login route signs with signSessionCookie() so the
 * two sides can never drift.
 *
 * Behaviour:
 * - Production with any required variable missing (SPEC 8.12): every request
 *   except PWA files, static assets and /api/setup/* is redirected to /setup.
 * - Otherwise (and in development): requests on session-exempt paths pass
 *   through; valid cookie passes; a page redirects to /login and an API route
 *   returns 401.
 */

export const SESSION_COOKIE = "tapedeck_session";

/** 180 days, matching the login route's cookie settings (SPEC 8.1). */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

/** Variables that must all be set before the app is usable in production (SPEC 8.12). */
const REQUIRED_PRODUCTION_VARS = [
  "APP_PASSWORD",
  "SESSION_SECRET",
  "DATABASE_URL",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "AGENT_TOKEN",
  "CRON_SECRET",
] as const;

const STATIC_EXTENSIONS = new Set([
  "js",
  "mjs",
  "css",
  "map",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "avif",
  "ico",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "txt",
  "xml",
  "json",
  "webmanifest",
  "m4a",
  "mp3",
  "wav",
  "opus",
  "webm",
  "wasm",
]);

/**
 * PWA files (manifest, service worker, icons) and static assets, never gated
 * (SPEC 2). Matching on extension is fail-closed: anything without a known
 * static extension falls through to the session check.
 */
export function isStaticOrPwaAsset(pathname: string): boolean {
  if (
    pathname.startsWith("/_next/static/") ||
    pathname.startsWith("/_next/image")
  ) {
    return true;
  }
  const base = pathname.slice(pathname.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false; // no extension (or dotfile) → not a static asset
  return STATIC_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

/**
 * Paths that never need the session cookie (SPEC 2): the login and setup
 * surfaces, endpoints that authenticate with their own bearer token or
 * signature, and PWA/static assets.
 */
export function isSessionExempt(pathname: string): boolean {
  if (isStaticOrPwaAsset(pathname)) return true;
  if (pathname === "/login" || pathname === "/api/login" || pathname === "/setup") {
    return true;
  }
  if (pathname === "/api/cron/keepalive") return true;
  return (
    pathname === "/api/setup" ||
    pathname.startsWith("/api/setup/") ||
    pathname.startsWith("/api/local-storage/") ||
    pathname.startsWith("/api/agent/")
  );
}

/**
 * Paths reachable while production setup is incomplete (SPEC 8.12): PWA files,
 * static assets and /api/setup/*. Everything else (including /login and the
 * API routes that are session-exempt once configured) is sent to /setup.
 */
export function isSetupModeExempt(pathname: string): boolean {
  return (
    isStaticOrPwaAsset(pathname) ||
    pathname === "/setup" ||
    pathname === "/api/setup" ||
    pathname.startsWith("/api/setup/")
  );
}

export function missingRequiredVars(
  env: Record<string, string | undefined>,
): string[] {
  return REQUIRED_PRODUCTION_VARS.filter((name) => !env[name]);
}

const encoder = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Issues the cookie value the login route stores (SPEC 8.1):
 * `<expiryUnix>.<HMAC-SHA256(expiryUnix, secret) hex>`.
 */
export async function signSessionCookie(
  expiryUnix: number,
  secret: string,
): Promise<string> {
  const key = await hmacKey(secret);
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(String(expiryUnix)),
  );
  return `${expiryUnix}.${toHex(mac)}`;
}

/**
 * Checks a session cookie value: well-formed, correctly signed for this
 * secret, and not expired at `nowUnix`. Tampered, foreign-signed or stale
 * cookies all fail closed.
 */
export async function verifySessionCookie(
  value: string | undefined,
  secret: string,
  nowUnix: number,
): Promise<boolean> {
  if (!value || !secret) return false;
  const match = /^(\d+)\.([0-9a-fA-F]{64})$/.exec(value);
  if (!match) return false;
  const expiry = match[1];
  const macHex = match[2];
  if (Number.parseInt(expiry, 10) <= nowUnix) return false;
  // The regex above guarantees exactly 64 hex chars → exactly 32 bytes.
  const macBytes = Uint8Array.from(
    { length: 32 },
    (_, i) => Number.parseInt(macHex.slice(i * 2, i * 2 + 2), 16),
  );
  const key = await hmacKey(secret);
  return crypto.subtle.verify("HMAC", key, macBytes, encoder.encode(expiry));
}

function getSessionCookie(request: Request): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      return part.slice(eq + 1).trim();
    }
  }
  return undefined;
}

function normalizePathname(url: string): string {
  const pathname = new URL(url).pathname;
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

/**
 * The gate decision, factored out of the proxy entry point so it can be tested
 * with a plain Request and an explicit env record.
 */
export async function gate(
  request: Request,
  env: Record<string, string | undefined>,
): Promise<Response> {
  const pathname = normalizePathname(request.url);

  // SPEC 8.12: production build with required variables missing sends every
  // request (except PWA files, static assets and /api/setup/*) to /setup.
  // Development and tests run on stand-ins and never enter this mode.
  const setupIncomplete =
    env.NODE_ENV === "production" && env.TAPEDECK_TEST !== "1" && missingRequiredVars(env).length > 0;
  if (setupIncomplete && !isSetupModeExempt(pathname)) {
    return NextResponse.redirect(new URL("/setup", request.url));
  }

  if (isSessionExempt(pathname)) return NextResponse.next();

  const authenticated = await verifySessionCookie(
    getSessionCookie(request),
    env.SESSION_SECRET ?? "",
    Math.floor(Date.now() / 1000),
  );
  if (authenticated) return NextResponse.next();

  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/login", request.url));
}

export default async function proxy(request: NextRequest): Promise<Response> {
  return gate(request, process.env);
}

export const config = {
  // matcher is an inclusion list: this runs the proxy on every path EXCEPT
  // build output and optimized images. All other PWA/static exemptions are
  // decided in isStaticOrPwaAsset so the logic stays testable.
  matcher: ["/((?!_next/static|_next/image).*)"],
};
