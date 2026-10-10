import { sql } from "@/lib/db";
import { getStorage } from "@/lib/storage";
import { runFinish } from "./finish";
import { SCHEMA_SQL } from "./schema-sql";
import {
  anthropicCheck,
  databaseCheck,
  deezerCheck,
  itunesCheck,
  soundcloudCheck,
  storageCheck,
  youtubeCheck,
  type FetchJson,
} from "./services";
import { toSetupDb } from "../../../setup/db-surface";

/**
 * POST /api/setup/finish — the "Finish setup" button (SPEC 8.12). Public by
 * design (no session exists yet): the password check is the gate. Runs the
 * schema, applies R2 CORS, checks every service, and reports per-service
 * results in plain language.
 *
 * Route handlers run per request and on the default Node.js runtime
 * (node:crypto, the Postgres drivers) — no segment config needed; this
 * project's `cacheComponents` build rejects `runtime`/`dynamic` exports.
 */

interface FinishBody {
  password?: unknown;
}

export async function POST(request: Request) {
  const body: FinishBody = await request.json().catch(() => ({}));
  const password = typeof body.password === "string" ? body.password : "";

  const db = toSetupDb(sql);
  // The shared fetch wrapper (web/lib/http.ts): uniform timeouts, MSW-ready.
  const fetchJson: FetchJson = (await import("@/lib/http")).httpJson;

  const outcome = await runFinish({
    password,
    env: {
      appPassword: process.env.APP_PASSWORD,
    },
    db,
    schemaSql: SCHEMA_SQL,
    checks: [
      databaseCheck(db),
      {
        name: "storage",
        required: true,
        // Lazily: getStorage() throws in a production build without the R2
        // variables — exactly the state Setup onboards — and runFinish turns
        // that into the plain-language ERROR the page shows.
        run: () => storageCheck(getStorage()).run(),
      },
      youtubeCheck(process.env.YOUTUBE_API_KEY, fetchJson),
      soundcloudCheck(fetchJson),
      anthropicCheck(process.env.ANTHROPIC_API_KEY, fetchJson),
      itunesCheck(fetchJson),
      deezerCheck(fetchJson),
    ],
  });

  switch (outcome.rejected) {
    case "config":
      return Response.json(
        {
          ok: false,
          error:
            "APP_PASSWORD is not set. Add it in Vercel (Settings > Environment Variables), redeploy, then try again.",
        },
        { status: 500 },
      );
    case "password":
      return Response.json({ ok: false, error: "Wrong password." }, { status: 401 });
    case "already-finished":
      return Response.json(
        {
          ok: false,
          error: "Setup is already finished. Go to the login page.",
          services: outcome.services,
        },
        { status: 409 },
      );
    default:
      return Response.json(outcome, { status: 200 });
  }
}
