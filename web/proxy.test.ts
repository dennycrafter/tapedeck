import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  SESSION_COOKIE,
  gate,
  isSessionExempt,
  isStaticOrPwaAsset,
  missingRequiredVars,
  signSessionCookie,
  verifySessionCookie,
} from "./proxy";

const SECRET = "f".repeat(64);
const DAY = 86_400;
/** Real clock second at module load: the gate itself calls Date.now(). */
const NOW = Math.floor(Date.now() / 1000);

/** Fully configured production-style env (all SPEC 8.12 required vars set). */
function configuredEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    NODE_ENV: "development",
    APP_PASSWORD: "correct horse battery staple",
    SESSION_SECRET: SECRET,
    DATABASE_URL: "postgresql://stand-in",
    R2_ACCOUNT_ID: "a".repeat(32),
    R2_ACCESS_KEY_ID: "key",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET: "tapedeck-audio",
    AGENT_TOKEN: "b".repeat(64),
    CRON_SECRET: "c".repeat(64),
    ...overrides,
  };
}

function request(path: string, cookie?: string): Request {
  const headers = new Headers();
  if (cookie !== undefined) headers.set("cookie", cookie);
  return new Request(`http://localhost:3000${path}`, { headers });
}

async function cookieFor(
  expiryUnix: number,
  secret: string = SECRET,
): Promise<string> {
  return `${SESSION_COOKIE}=${await signSessionCookie(expiryUnix, secret)}`;
}

/** True when the gate let the request through (no redirect, no 401). */
function isAllowed(response: Response): boolean {
  return response.status === 200 && response.headers.get("location") === null;
}

/** Flips one hex character of the MAC so the value is well-formed but wrong. */
function tamperMac(value: string): string {
  const [expiry, mac] = value.split(".");
  const flipped = mac.slice(0, 31) + (mac[31] === "0" ? "1" : "0") + mac.slice(32);
  return `${expiry}.${flipped}`;
}

describe("verifySessionCookie", () => {
  it("accepts a cookie signed for the future", async () => {
    const value = await signSessionCookie(NOW + DAY, SECRET);
    expect(await verifySessionCookie(value, SECRET, NOW)).toBe(true);
  });

  it("rejects an expired cookie", async () => {
    const value = await signSessionCookie(NOW - 1, SECRET);
    expect(await verifySessionCookie(value, SECRET, NOW)).toBe(false);
  });

  it("rejects a cookie that expires exactly now (boundary)", async () => {
    const value = await signSessionCookie(NOW, SECRET);
    expect(await verifySessionCookie(value, SECRET, NOW)).toBe(false);
  });

  it("rejects a tampered MAC", async () => {
    expect(
      await verifySessionCookie(tamperMac(await signSessionCookie(NOW + DAY, SECRET)), SECRET, NOW),
    ).toBe(false);
  });

  it("rejects a cookie signed with a different secret", async () => {
    const value = await signSessionCookie(NOW + DAY, "other-secret");
    expect(await verifySessionCookie(value, SECRET, NOW)).toBe(false);
  });

  it("rejects a tampered expiry (HMAC no longer matches)", async () => {
    const value = await signSessionCookie(NOW + DAY, SECRET);
    const [, mac] = value.split(".");
    expect(
      await verifySessionCookie(`${NOW + 2 * DAY}.${mac}`, SECRET, NOW),
    ).toBe(false);
  });

  it("rejects malformed values", async () => {
    for (const bad of [
      undefined,
      "",
      "garbage",
      `${NOW}.`,
      `${NOW}.${"0".repeat(63)}`, // 63 hex chars
      `${NOW}.${"g".repeat(64)}`, // not hex
      `abc.${"0".repeat(64)}`, // non-numeric expiry
      `.${"0".repeat(64)}`,
    ]) {
      expect(await verifySessionCookie(bad, SECRET, NOW)).toBe(false);
    }
  });

  it("rejects an empty secret", async () => {
    const value = await signSessionCookie(NOW + DAY, SECRET);
    expect(await verifySessionCookie(value, "", NOW)).toBe(false);
  });

  it("accepts uppercase hex MACs", async () => {
    const value = await signSessionCookie(NOW + DAY, SECRET);
    const [expiry, mac] = value.split(".");
    expect(
      await verifySessionCookie(`${expiry}.${mac.toUpperCase()}`, SECRET, NOW),
    ).toBe(true);
  });
});

describe("session gate: cookie check", () => {
  it("lets a page through with a valid cookie (match)", async () => {
    const response = await gate(request("/", await cookieFor(NOW + DAY)), {
      NODE_ENV: "development",
      SESSION_SECRET: SECRET,
    });
    expect(isAllowed(response)).toBe(true);
  });

  it("lets an API route through with a valid cookie (match)", async () => {
    const response = await gate(
      request("/api/tracks", await cookieFor(NOW + DAY)),
      { NODE_ENV: "development", SESSION_SECRET: SECRET },
    );
    expect(isAllowed(response)).toBe(true);
  });

  it("redirects a page with no cookie to /login (miss)", async () => {
    const response = await gate(request("/"), {
      NODE_ENV: "development",
      SESSION_SECRET: SECRET,
    });
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3000/login");
  });

  it("returns 401 from an API route with no cookie (miss)", async () => {
    const response = await gate(request("/api/tracks"), {
      NODE_ENV: "development",
      SESSION_SECRET: SECRET,
    });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("redirects a page with an expired cookie to /login", async () => {
    const response = await gate(request("/", await cookieFor(NOW - 1)), {
      NODE_ENV: "development",
      SESSION_SECRET: SECRET,
    });
    expect(response.headers.get("location")).toBe("http://localhost:3000/login");
  });

  it("returns 401 from an API route with a tampered cookie", async () => {
    const tampered = tamperMac(await signSessionCookie(NOW + DAY, SECRET));
    const response = await gate(
      request("/api/tracks", `${SESSION_COOKIE}=${tampered}`),
      { NODE_ENV: "development", SESSION_SECRET: SECRET },
    );
    expect(response.status).toBe(401);
  });

  it("redirects a page with a foreign-signed cookie to /login", async () => {
    const foreign = await cookieFor(NOW + DAY, "attacker-secret");
    const response = await gate(request("/", foreign), {
      NODE_ENV: "development",
      SESSION_SECRET: SECRET,
    });
    expect(response.headers.get("location")).toBe("http://localhost:3000/login");
  });

  it("redirects when SESSION_SECRET is unset (no cookie can verify)", async () => {
    const response = await gate(request("/"), { NODE_ENV: "development" });
    expect(response.headers.get("location")).toBe("http://localhost:3000/login");
  });
});

describe("session gate: exempt paths pass without a cookie (SPEC 2)", () => {
  const exemptPaths = [
    "/login",
    "/login/",
    "/api/login",
    "/setup",
    "/api/setup/finish",
    "/api/setup/anything",
    "/api/cron/keepalive",
    "/api/local-storage/tracks/abc123",
    "/api/agent/status",
    "/manifest.webmanifest",
    "/sw.js",
    "/favicon.ico",
    "/icon-192.png",
    "/apple-touch-icon.png",
    "/_next/static/chunks/main.js",
    "/_next/image?url=x",
    "/test-audio/test1.m4a",
    "/robots.txt",
  ];

  for (const path of exemptPaths) {
    it(`allows ${path}`, async () => {
      const response = await gate(request(path), { NODE_ENV: "development" });
      expect(isAllowed(response)).toBe(true);
    });
  }

  it("still gates paths that merely resemble exempt ones", () => {
    for (const path of [
      "/logina",
      "/api/logina",
      "/api/setuppx",
      "/api/agentx",
      "/api/cron/keepalive-extra",
      "/api/local-storagex",
      "/test-audio", // the page, not the audio file
      "/swjs",
    ]) {
      expect(isSessionExempt(path)).toBe(false);
    }
  });
});

describe("gate: pages redirect, APIs return 401", () => {
  it("redirects non-API pages to /login", async () => {
    for (const path of ["/", "/library", "/playlists/abc", "/test-audio"]) {
      const response = await gate(request(path), { NODE_ENV: "development" });
      expect(response.headers.get("location")).toBe(
        "http://localhost:3000/login",
      );
    }
  });

  it("returns 401 for API routes", async () => {
    for (const path of [
      "/api",
      "/api/tracks",
      "/api/health",
      "/api/playlists/abc",
    ]) {
      const response = await gate(request(path), { NODE_ENV: "development" });
      expect(response.status).toBe(401);
    }
  });
});

describe("production setup mode (SPEC 8.12)", () => {
  it("sends / to /setup when required variables are missing", async () => {
    const response = await gate(request("/"), {
      NODE_ENV: "production",
      SESSION_SECRET: SECRET,
    });
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3000/setup");
  });

  it("sends / to /setup even with a valid session cookie", async () => {
    const response = await gate(request("/", await cookieFor(NOW + DAY)), {
      NODE_ENV: "production",
      SESSION_SECRET: SECRET,
    });
    expect(response.headers.get("location")).toBe("http://localhost:3000/setup");
  });

  it("sends API routes to /setup too (SPEC 8.12: every request)", async () => {
    const response = await gate(request("/api/tracks"), {
      NODE_ENV: "production",
      SESSION_SECRET: SECRET,
    });
    expect(response.headers.get("location")).toBe("http://localhost:3000/setup");
  });

  it("keeps /api/setup/finish, PWA files and static assets reachable", async () => {
    for (const path of [
      "/setup",
      "/api/setup/finish",
      "/manifest.webmanifest",
      "/sw.js",
      "/favicon.ico",
      "/_next/static/chunks/main.js",
    ]) {
      const response = await gate(request(path), {
        NODE_ENV: "production",
        SESSION_SECRET: SECRET,
      });
      expect(isAllowed(response)).toBe(true);
    }
  });

  it("keeps the /setup page itself reachable (no self-redirect loop)", async () => {
    const response = await gate(request("/setup"), {
      NODE_ENV: "production",
      SESSION_SECRET: SECRET,
    });
    expect(isAllowed(response)).toBe(true);
  });

  it("does not enter setup mode in development even with variables missing", async () => {
    const response = await gate(request("/"), { NODE_ENV: "development" });
    // Falls through to the normal session gate: no cookie → /login, not /setup.
    expect(response.headers.get("location")).toBe("http://localhost:3000/login");
  });

  it("gates normally once every required variable is set", async () => {
    const response = await gate(
      request("/"),
      configuredEnv({ NODE_ENV: "production" }),
    );
    expect(response.headers.get("location")).toBe("http://localhost:3000/login");

    const authed = await gate(
      request("/", await cookieFor(NOW + DAY)),
      configuredEnv({ NODE_ENV: "production" }),
    );
    expect(isAllowed(authed)).toBe(true);
  });
});

describe("missingRequiredVars", () => {
  it("returns nothing when everything is set", () => {
    expect(missingRequiredVars(configuredEnv())).toEqual([]);
  });

  it("names every missing variable", () => {
    const env = configuredEnv({
      DATABASE_URL: undefined,
      SESSION_SECRET: undefined,
    });
    expect(missingRequiredVars(env)).toEqual([
      "SESSION_SECRET",
      "DATABASE_URL",
    ]);
  });

  it("treats an empty string as missing", () => {
    const env = configuredEnv({ AGENT_TOKEN: "" });
    expect(missingRequiredVars(env)).toEqual(["AGENT_TOKEN"]);
  });
});

describe("isStaticOrPwaAsset", () => {
  it("treats known static extensions as assets", () => {
    for (const path of [
      "/logo.svg",
      "/styles/main.css",
      "/test-audio/test2.m4a",
      "/fonts/inter.woff2",
    ]) {
      expect(isStaticOrPwaAsset(path)).toBe(true);
    }
  });

  it("never treats pages or extension-less paths as assets", () => {
    for (const path of [
      "/",
      "/library",
      "/api/tracks",
      "/login",
      "/.well-known/change-password",
      "/settings.backup",
    ]) {
      expect(isStaticOrPwaAsset(path)).toBe(false);
    }
  });
});

describe("default proxy wiring", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads process.env at request time: production with missing variables sends / to /setup", async () => {
    for (const name of [
      "APP_PASSWORD",
      "SESSION_SECRET",
      "DATABASE_URL",
      "R2_ACCOUNT_ID",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "R2_BUCKET",
      "AGENT_TOKEN",
      "CRON_SECRET",
    ]) {
      vi.stubEnv(name, "");
    }
    vi.stubEnv("NODE_ENV", "production");
    const { default: proxy } = await import("./proxy");
    const response = await proxy(new NextRequest("http://localhost:3000/"));
    expect(response.headers.get("location")).toBe("http://localhost:3000/setup");
  });

  it("reads process.env at request time: complete variables fall through to the session gate", async () => {
    for (const [name, value] of Object.entries(configuredEnv())) {
      vi.stubEnv(name, value);
    }
    vi.stubEnv("NODE_ENV", "production");
    const { default: proxy } = await import("./proxy");
    const response = await proxy(new NextRequest("http://localhost:3000/"));
    expect(response.headers.get("location")).toBe("http://localhost:3000/login");
  });
});
