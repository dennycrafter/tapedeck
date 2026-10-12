# Decisions

This file records every deviation from SPEC.md and every choice the spec left open, one entry at a time (SPEC section 0, rule 2). Nothing in the app is invented silently: if a judgement call was made during the build, it is written down here.

Each entry lists the date, the ticket, the decision, and a one line reason for it, newest first. Entries are never edited after the fact; a later decision that replaces an earlier one is added as a new entry that names the entry it replaces.

- 2026-10-12 (fix before T2): Added a GitHub Actions check (`.github/workflows/ci.yml`) that runs tsc, eslint, Vitest, pytest and Playwright on all three projects for every PR and every push to main. Reason: the new build machine cannot download Playwright's WebKit, so the `iphone` project (which owns the T1 and T3 UI checks) only runs honestly on GitHub's machines; a PR merges only when this check is green.
- 2026-10-12 (fix before T2): `web/app/layout.tsx` types its props explicitly instead of using Next's generated global `LayoutProps<"/">`. Reason: that global only exists after `next typegen` or a build, so `tsc --noEmit` on a fresh clone failed with "Cannot find name 'LayoutProps'".

- 2026-10-10 (T0 test harness) — The agent pytest suite targets Python 3.12 semantics while the build sandbox runs Python 3.13.14: the downloader ships to the owner's Windows PC on Python 3.12 (SPEC 8.3), so tests are written to pass on both and version-specific behavior is handled in code rather than assumed by tests.
