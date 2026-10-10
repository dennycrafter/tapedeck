// Session cookie signing and secret/password resolution for /api/login.
// SPEC 8.1: cookie value is `<expiryUnix>.<HMAC-SHA256(expiryUnix, SESSION_SECRET) hex>`,
// HttpOnly, Secure, SameSite=Lax, 180-day expiry.
// SPEC 4.1: in development the password defaults to `tapedeck-dev` and
// SESSION_SECRET is read-or-generated from `.data/dev-secrets.json`, so the
// app runs with zero secrets. TAPEDECK_TEST=1 (SPEC 9.0) gets the same
// stand-in behavior, taking the test password from APP_PASSWORD when set.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const SESSION_COOKIE_NAME = "tapedeck_session";
export const SESSION_MAX_AGE_SECONDS = 180 * 24 * 60 * 60; // 180 days (SPEC 8.1)

const DEV_DEFAULT_PASSWORD = "tapedeck-dev"; // SPEC 4.1
const DEV_SECRETS_PATH = path.join(".data", "dev-secrets.json"); // SPEC 4.1

/** HMAC-SHA256 of the expiry as unix seconds, hex-encoded, keyed by the secret. */
export function signExpiry(expiryUnix: number, secret: string): string {
  return createHmac("sha256", secret).update(String(expiryUnix)).digest("hex");
}

/** Full Set-Cookie header value for a session that expires at `expiryUnix`. */
export function buildSessionCookie(expiryUnix: number, secret: string): string {
  const value = `${expiryUnix}.${signExpiry(expiryUnix, secret)}`;
  return [
    `${SESSION_COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
  ].join("; ");
}

/** Session expiry 180 days out, in unix seconds. */
export function sessionExpiry(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000) + SESSION_MAX_AGE_SECONDS;
}

/**
 * Constant-time password compare. Both sides are hashed first so
 * timingSafeEqual always gets equal-length buffers (it throws otherwise)
 * and the password length never leaks through timing.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}

function isDevMode(): boolean {
  return process.env.TAPEDECK_TEST === "1" || process.env.NODE_ENV !== "production";
}

/**
 * The password to compare against (SPEC 4.1): APP_PASSWORD when set; in
 * development and TAPEDECK_TEST runs it defaults to `tapedeck-dev`; in a
 * production build without it, setup is not finished (SPEC 8.12), so fail
 * closed with null.
 */
export function resolveExpectedPassword(): string | null {
  const fromEnv = process.env.APP_PASSWORD;
  if (fromEnv) return fromEnv;
  return isDevMode() ? DEV_DEFAULT_PASSWORD : null;
}

/**
 * The secret that signs the session cookie (SPEC 4.1): SESSION_SECRET when
 * set; in development and TAPEDECK_TEST runs, read-or-generate the shared
 * `.data/dev-secrets.json` so the login route and the middleware sign with
 * the same value; in a production build without it, fail closed with null.
 */
export async function resolveSessionSecret(): Promise<string | null> {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv) return fromEnv;
  if (!isDevMode()) return null;
  return readOrGenerateDevSecret();
}

async function readOrGenerateDevSecret(): Promise<string> {
  const filePath = path.join(process.cwd(), DEV_SECRETS_PATH);
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    const existing = (parsed as Record<string, unknown>)["SESSION_SECRET"];
    if (typeof existing === "string" && existing.length > 0) return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // Unreadable or corrupt file: warn loudly, then regenerate it.
      console.warn(
        "[login] could not read dev secrets file, regenerating:",
        error instanceof Error ? error.message : error,
      );
    }
  }
  const secret = randomBytes(32).toString("hex");
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify({ SESSION_SECRET: secret }, null, 2)}\n`, "utf8");
  } catch (error) {
    // Dev convenience only: an unwritable file still leaves a working
    // in-process secret, it just rotates on restart.
    console.warn(
      "[login] could not persist dev secrets file:",
      error instanceof Error ? error.message : error,
    );
  }
  return secret;
}
