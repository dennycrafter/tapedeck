// POST /api/login - password screen backend (SPEC 8.1).
// Compares the posted password with APP_PASSWORD in constant time; on a
// match, sets the signed `tapedeck_session` cookie. Wrong attempts are rate
// limited per IP: 429 for 10 minutes after 5 wrong tries in 10 minutes.
import { isRateLimited, clearWrongAttempts, recordWrongAttempt } from "./rate-limit";
import {
  buildSessionCookie,
  constantTimeEqual,
  resolveExpectedPassword,
  resolveSessionSecret,
  sessionExpiry,
} from "./session";

const RATE_LIMIT_BLOCK_SECONDS = 10 * 60;

function jsonResponse(body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

/** Vercel and local proxies put the client IP first in x-forwarded-for. */
function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

function readPassword(body: unknown): unknown {
  if (typeof body === "object" && body !== null && "password" in body) {
    return (body as Record<string, unknown>).password;
  }
  return undefined;
}

export async function POST(request: Request): Promise<Response> {
  const ip = clientIp(request);

  if (isRateLimited(ip)) {
    return jsonResponse(
      { error: "Too many attempts. Try again in 10 minutes." },
      429,
      { "Retry-After": String(RATE_LIMIT_BLOCK_SECONDS) },
    );
  }

  const expectedPassword = resolveExpectedPassword();
  const sessionSecret = await resolveSessionSecret();
  if (expectedPassword === null || sessionSecret === null) {
    // Production build without APP_PASSWORD/SESSION_SECRET: setup is not
    // finished (SPEC 8.12). Fail closed; the middleware sends browsers to
    // /setup.
    return jsonResponse({ error: "Setup incomplete" }, 500);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid request body" }, 400);
  }
  const password = readPassword(body);

  if (typeof password !== "string" || !constantTimeEqual(password, expectedPassword)) {
    recordWrongAttempt(ip);
    return jsonResponse({ error: "Wrong password" }, 401);
  }

  clearWrongAttempts(ip);
  const setCookie = buildSessionCookie(sessionExpiry(), sessionSecret);
  return jsonResponse({ ok: true }, 200, { "Set-Cookie": setCookie });
}
