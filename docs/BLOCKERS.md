# Blockers

This file records anything that failed after 3 honest fix attempts, or that only the owner can do, such as a missing secret, his iPhone, or his Windows PC (SPEC section 0, rule 3). A blocker never stops the build and never hides a failing check.

Each entry states what failed, why, and the exact steps the owner must take to fix it, written in plain language for a non-technical reader. Resolved entries stay in the file and are marked resolved with the date.

---

## The setup page never opens on a fresh deployment (found 2026-10-10, T0 checkpoint verification — RESOLVED 2026-10-10)

**Resolved 2026-10-10:** Fixed on main by `542bc87` (PR #2) — `isSetupModeExempt` now allows the `/setup` page, with the regression tests from step 3 included. Re-verified independently on a no-variables production build: `/` → 307 `/setup`, `/setup` renders with nine red dots, three 64-character Copy secrets, and no values shown; vitest 194/194, Playwright @T0 9/9, pytest 15/15. See TEST-REPORT.md, "T0 recheck" block. The steps below are kept as written.

**What failed:** When Tapedeck is deployed for the very first time — before any settings exist — the browser can never open the setup page. Visiting `/setup` redirects to `/setup` forever, and the browser gives up with "this page isn't working / too many redirects" (`ERR_TOO_MANY_REDIRECTS`). The three secret values the owner must copy into Vercel (SESSION_SECRET, AGENT_TOKEN, CRON_SECRET) are generated on, and shown only by, that page — so first-time setup cannot be completed in the browser while this is broken. The redirect from `/` to `/setup` works; it is the setup page itself that loops.

**Why it happens:** In `web/proxy.ts`, the function `isSetupModeExempt` decides which addresses stay reachable while setup is incomplete. It exempts the setup API routes (`/api/setup` and anything under `/api/setup/`) plus static files and PWA assets, but it forgot the `/setup` page itself — so the gate sends `/setup` to `/setup`. The existing tests cover `/` and `/api/tracks` in setup mode but never the `/setup` page, which is why this slipped through.

**Exact steps to fix (plain words):**

1. Open `web/proxy.ts` and find the function `isSetupModeExempt`.
2. Add the setup page to its list of allowed addresses — one line: `pathname === "/setup" ||` next to the existing `pathname === "/api/setup"` line.
3. In `web/proxy.test.ts`, find the test named "keeps /api/setup/finish, PWA files and static assets reachable" and add `"/setup"` to its list of addresses, so this can never quietly come back.
4. Rebuild and check with no environment variables set: run `cd web && npm run build && npx next start -p 3000`, then open `http://localhost:3000/` in a browser. It must land on `/setup` and the page must render: every missing variable shows a red dot, three 64-character hex values appear with Copy buttons, and no variable value is displayed.
5. Re-run the checks: `cd web && npx playwright test --grep @T0` (all three projects) and `npx vitest run` — everything must stay green.

**Impact if unfixed:** Every deployment that starts without all required variables loops instead of showing setup, and the owner cannot finish onboarding. The setup API itself stays reachable, so a determined user could still finish via direct API calls, but the guided page — including the generated secrets — is unreachable.

---

## The @live finish check cannot run until the app is deployed with real credentials (found 2026-10-10, T0 checkpoint verification — re-confirmed 2026-10-10, T1 checkpoint verification — OPEN, owner action)

**Not a defect:** nothing is broken. This is the one checklist item that can only run after you deploy the app for real, because it needs your live Supabase and Cloudflare R2 credentials. It is logged here so it is not forgotten; the T0 and T1 verification rounds each deferred it the same way (SPEC 9.0 says it runs after go-live).

**What is pending:** the @live e2e check — "Finish setup creates the tables and R2 `GetBucketCors` returns the 7.2 rules". Against local stand-ins it cannot be meaningful: it needs a real Supabase database and a real R2 bucket.

**Exact steps the owner must take (plain words):**

1. Deploy Tapedeck (Vercel + Supabase + Cloudflare R2) and finish the setup page once, with your real variables.
2. Create the three secrets in Supabase (DATABASE_URL) and Cloudflare (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET) and put them into the deployment's environment variables (SESSION_SECRET, AGENT_TOKEN, CRON_SECRET come from the setup page's Copy buttons).
3. From the `web` folder run `npm run e2e:live`. It must show the finish-setup check creating the tables and `GetBucketCors` returning the CORS rules from SPEC 7.2.
4. Record the result in docs/TEST-REPORT.md (a new dated block) and mark this entry resolved.

**Impact if unfixed:** none for local use — the schema bootstrap and CORS rules are covered by stand-in tests. The risk is only on the first real deployment: if the R2 bucket's CORS rules were wrong, the browser could not fetch audio from the bucket, and this check is what would catch it.
