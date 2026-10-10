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
