import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Finish-setup orchestration (SPEC 8.12), kept free of imports from the
 * sibling-owned `web/lib/*` adapters so it can be unit-tested against a real
 * in-memory PGlite (VERIFIED DONE for T0c-w4). `route.ts` wires the real
 * adapters in; tests inject stand-ins.
 *
 * Contract from SPEC 7.2 and 8.12: the setup is complete when the `settings`
 * table exists (the schema's seed row is its marker). Finish checks the
 * password constant-time, applies supabase/schema.sql if the settings table
 * does not exist, applies the R2 CORS rules, checks every service like
 * /api/health does, and returns per-service results.
 */

export type ServiceStatus = "OK" | "NOT_SET" | "ERROR";

export interface ServiceResult {
  name: string;
  status: ServiceStatus;
  /** Plain-language line shown on the Setup page (SPEC 8.12). */
  detail: string;
}

export interface ServiceCheck {
  name: string;
  /** Required services gate the outcome; optional ones only report. */
  required: boolean;
  run: () => Promise<ServiceResult>;
}

/** Database surface Finish setup needs (implemented over `web/lib/db.ts`). */
export interface SetupDb {
  settingsExists(): Promise<boolean>;
  /** Execute the whole schema file; the adapter handles statement splitting. */
  applySchema(schemaSql: string): Promise<void>;
  /** Throw when the database is unreachable or the settings row is gone. */
  ping(): Promise<void>;
}

export interface FinishEnv {
  appPassword?: string;
}

/**
 * Why a call was refused. "config": a required variable is missing.
 * "password": the submitted password does not match APP_PASSWORD.
 * "already-finished": setup completed earlier; the schema is in place and
 * every service passes, so there is nothing left to do (second call rejected).
 */
export type Rejection = "config" | "password" | "already-finished";

export interface FinishInput {
  password: string;
  env: FinishEnv;
  db: SetupDb;
  checks: ServiceCheck[];
  schemaSql: string;
}

export interface FinishOutcome {
  ok: boolean;
  rejected: Rejection | null;
  schemaApplied: boolean;
  services: ServiceResult[];
}

function errorDetail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Constant-time comparison (SPEC 8.12). Both sides are hashed first so
 * timingSafeEqual gets equal-length input and the length difference between
 * the submitted and real password leaks no information.
 */
export function passwordMatches(submitted: string, real: string): boolean {
  const submittedHash = createHash("sha256").update(submitted).digest();
  const realHash = createHash("sha256").update(real).digest();
  return timingSafeEqual(submittedHash, realHash);
}

export async function runFinish(input: FinishInput): Promise<FinishOutcome> {
  const { password, env, db, checks, schemaSql } = input;

  if (!env.appPassword) {
    return {
      ok: false,
      rejected: "config",
      schemaApplied: false,
      services: [],
    };
  }
  if (!passwordMatches(password, env.appPassword)) {
    return {
      ok: false,
      rejected: "password",
      schemaApplied: false,
      services: [],
    };
  }

  let settingsExists: boolean;
  try {
    settingsExists = await db.settingsExists();
  } catch (cause) {
    return {
      ok: false,
      rejected: null,
      schemaApplied: false,
      services: [
        {
          name: "database",
          status: "ERROR",
          detail: `Could not reach the database: ${errorDetail(cause)}`,
        },
      ],
    };
  }

  let schemaApplied = false;
  if (!settingsExists) {
    try {
      await db.applySchema(schemaSql);
      schemaApplied = true;
    } catch (cause) {
      return {
        ok: false,
        rejected: null,
        schemaApplied: false,
        services: [
          {
            name: "database",
            status: "ERROR",
            detail: `Could not create the database tables: ${errorDetail(cause)}`,
          },
        ],
      };
    }
  }

  const services: ServiceResult[] = [];
  for (const check of checks) {
    try {
      services.push(await check.run());
    } catch (cause) {
      services.push({
        name: check.name,
        status: "ERROR",
        detail: errorDetail(cause),
      });
    }
  }

  const requiredOk = checks.every((check, index) => {
    return !check.required || services[index].status === "OK";
  });
  const noErrors = services.every((service) => service.status !== "ERROR");

  // Setup already completed: refuse a second run instead of redoing work
  // (the /setup page redirects to /login in this state, so a caller here is
  // off the happy path). Only refuse when everything truly passes — a failed
  // service check must stay retryable, since the owner fixes the failing
  // variable and presses the button again.
  if (settingsExists && requiredOk && noErrors) {
    return { ok: false, rejected: "already-finished", schemaApplied, services };
  }

  return { ok: requiredOk, rejected: null, schemaApplied, services };
}
