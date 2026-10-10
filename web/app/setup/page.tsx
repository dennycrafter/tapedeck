import { Suspense } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { sql } from "@/lib/db";
import SetupClient from "./SetupClient";
import { settingsTableExists } from "./db-surface";
import { OPTIONAL_VARS, REQUIRED_VARS } from "./setup-config";

/**
 * /setup — first-run setup, before the owner goes live (SPEC 8.12). Only
 * exists in production builds: development and tests use the stand-ins from
 * SPEC 4.1 and this page never shows. Reachable without a password by
 * design; it displays variable NAMES and status only, never values.
 *
 * The content below is uncached request-time work (env reads, database
 * check) inside a Suspense boundary — this project's `cacheComponents`
 * build rejects `dynamic = "force-dynamic"` and prerenders anything
 * reachable without one, which would bake build-time variable state into
 * the HTML and lie to the owner.
 */

export const metadata = {
  title: "Setup · Tapedeck",
};

async function SetupContent() {
  // Defer to request time so the dots reflect the deployed environment,
  // never the build environment.
  await connection();

  if (process.env.NODE_ENV !== "production") {
    // Development and tests run on stand-ins; there is nothing to set up.
    redirect("/login");
  }

  const required = REQUIRED_VARS.map((name) => ({
    name,
    present: Boolean(process.env[name]),
  }));
  const optional = OPTIONAL_VARS.map(({ name, purpose }) => ({
    name,
    purpose,
    present: Boolean(process.env[name]),
  }));
  const allSet = required.every((variable) => variable.present);

  if (allSet) {
    if (await settingsTableExists(sql).catch(() => false)) {
      // Setup is finished and every required variable is set (SPEC 8.12).
      redirect("/login");
    }
  }

  return <SetupClient required={required} optional={optional} allSet={allSet} />;
}

export default function SetupPage() {
  return (
    <Suspense fallback={null}>
      <SetupContent />
    </Suspense>
  );
}
