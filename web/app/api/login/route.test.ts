// Unit tests for POST /api/login and its session helpers (SPEC 8.1, 4.1).
// Covers: success sets the signed cookie, wrong password is 401, 429 after
// 5 wrong tries per 10 minutes, TAPEDECK_TEST/dev defaults, production
// fail-closed, and malformed bodies.
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLoginRateLimiter } from "./rate-limit";
import { POST } from "./route";
import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  buildSessionCookie,
  constantTimeEqual,
  sessionExpiry,
  signExpiry,
} from "./session";

const SECRET = "ab".repeat(32);
const PASSWORD = "correct horse battery staple";
const MINUTE = 60 * 1000;
const T0 = 1_800_000_000_000;

function loginRequest(password: unknown, ip = "203.0.113.7"): Request {
  return new Request("http://localhost/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ password }),
  });
}

function rawRequest(body: string, ip = "203.0.113.7"): Request {
  return new Request("http://localhost/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body,
  });
}

beforeEach(() => {
  resetLoginRateLimiter();
  vi.stubEnv("SESSION_SECRET", SECRET);
  vi.stubEnv("APP_PASSWORD", PASSWORD);
  // Force the non-production branch explicitly; TAPEDECK_TEST off.
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("TAPEDECK_TEST", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/login", () => {
  it("sets the signed 180-day cookie on the right password (SPEC 8.1)", async () => {
    const response = await POST(loginRequest(PASSWORD));
    expect(response.status).toBe(200);

    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain(`Max-Age=${SESSION_MAX_AGE_SECONDS}`);

    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(setCookie);
    if (!match) throw new Error("cookie value missing from Set-Cookie header");
    const [expiry, mac] = match[1].split(".");
    // Expiry is 180 days out (within a second of clock skew).
    expect(Math.abs(Number(expiry) - sessionExpiry())).toBeLessThanOrEqual(1);
    // The MAC is HMAC-SHA256 of the expiry string, keyed by SESSION_SECRET.
    expect(mac).toBe(signExpiry(Number(expiry), SECRET));
  });

  it("rejects a wrong password with 401 and no cookie", async () => {
    const response = await POST(loginRequest("not the password"));
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("treats a non-string password as a wrong attempt", async () => {
    const response = await POST(loginRequest(42));
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("rejects a malformed body with 400", async () => {
    const response = await POST(rawRequest("not json"));
    expect(response.status).toBe(400);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("returns 429 after 5 wrong tries within 10 minutes, even for the right password", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    try {
      for (let i = 0; i < 5; i++) {
        const response = await POST(loginRequest("nope"));
        expect(response.status).toBe(401);
      }
      const blocked = await POST(loginRequest(PASSWORD));
      expect(blocked.status).toBe(429);

      // The block ends 10 minutes after the 5th wrong try.
      vi.setSystemTime(T0 + 10 * MINUTE + 1000);
      const after = await POST(loginRequest(PASSWORD));
      expect(after.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts the tapedeck-dev default when APP_PASSWORD is unset in dev mode (SPEC 4.1)", async () => {
    vi.stubEnv("APP_PASSWORD", "");
    const response = await POST(loginRequest("tapedeck-dev"));
    expect(response.status).toBe(200);
  });

  it("TAPEDECK_TEST mode takes the test password from APP_PASSWORD (SPEC 9.0)", async () => {
    vi.stubEnv("TAPEDECK_TEST", "1");
    vi.stubEnv("APP_PASSWORD", "test-passphrase");
    const response = await POST(loginRequest("test-passphrase"));
    expect(response.status).toBe(200);
  });

  it("fails closed without APP_PASSWORD in a production build (SPEC 8.12)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_PASSWORD", "");
    const response = await POST(loginRequest("anything"));
    expect(response.status).toBe(500);
  });

  it("fails closed without SESSION_SECRET in a production build (SPEC 8.12)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", "");
    const response = await POST(loginRequest(PASSWORD));
    expect(response.status).toBe(500);
  });
});

describe("session helpers", () => {
  it("signExpiry is HMAC-SHA256 over the expiry string, hex", () => {
    expect(signExpiry(123, SECRET)).toBe(
      createHmac("sha256", SECRET).update("123").digest("hex"),
    );
  });

  it("buildSessionCookie emits the exact SPEC 8.1 cookie", () => {
    const cookie = buildSessionCookie(123, SECRET);
    expect(cookie).toBe(
      `tapedeck_session=123.${signExpiry(123, SECRET)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=15552000`,
    );
  });

  it("sessionExpiry is 180 days out", () => {
    expect(sessionExpiry(0)).toBe(SESSION_MAX_AGE_SECONDS);
  });

  it("constantTimeEqual matches equal strings and rejects others", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("", "")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("abc", "")).toBe(false);
  });
});
