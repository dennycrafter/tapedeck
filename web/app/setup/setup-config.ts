/**
 * Data for the Setup page (SPEC 8.12): which variables are required and
 * optional, what the optional ones turn on, the short go-live steps from
 * SPEC 5.3, and the three freshly generated secrets. The page shows
 * variable NAMES and their status only — never values (T0 checks).
 */
export const REQUIRED_VARS = [
  "DATABASE_URL",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "APP_PASSWORD",
  "SESSION_SECRET",
  "AGENT_TOKEN",
  "CRON_SECRET",
] as const;

export interface OptionalVar {
  name: string;
  purpose: string;
}

export const OPTIONAL_VARS: OptionalVar[] = [
  { name: "YOUTUBE_API_KEY", purpose: "Turns on YouTube search in the app." },
  { name: "ANTHROPIC_API_KEY", purpose: "Smarter AI title and artist cleanup." },
];

export interface GeneratedSecret {
  name: string;
  purpose: string;
}

/** Generated on the client with crypto.getRandomValues (SPEC 8.12). */
export const GENERATED_SECRETS: GeneratedSecret[] = [
  { name: "SESSION_SECRET", purpose: "Signs your login cookie and offline links." },
  { name: "AGENT_TOKEN", purpose: "Lets your PC downloader talk to the app." },
  { name: "CRON_SECRET", purpose: "Protects the daily database keepalive." },
];

/** The go-live steps from SPEC 5.3, short form. */
export const GO_LIVE_STEPS = [
  "Create the Supabase database (Transaction pooler URI) — DATABASE_URL.",
  "Create the Cloudflare R2 bucket and API token — the three R2 variables and R2_BUCKET = tapedeck-audio.",
  "Optional: YouTube Data API key — search.",
  "Optional: Anthropic API key — AI title cleanup.",
  "Add every variable in Vercel, including the three generated secrets below, then redeploy.",
  "Come back here, type your password, and press Finish setup.",
];
