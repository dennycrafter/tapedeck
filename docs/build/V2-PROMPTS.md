# Prompts for Claude Code (v2)

Open a terminal in the `tapedeck` folder, start `claude`, paste one of these.

## Option A: one terminal, the lead runs everything (recommended)

```
You're the lead builder for Tapedeck v2 (repo dennycrafter/tapedeck; clone it here if it isn't).

Read docs/build/BUILD-HANDOFF.md, then docs/build/V2-PLAN.md. The plan is your spec: follow its waves and its "Rules for parallel work" exactly.

1. Wave 0: build T9 yourself on branch t9-foundation. Open the PR, wait for CI to go green, squash merge.
2. Wave 1: spawn three subagents at the same time, one each for T10, T11 and T12. Each works in its own git worktree from fresh main, uses its own e2e ports from the plan's table, opens its own PR, and reports back the PR link plus anything left for me.
3. As each PR comes back: review the diff against the plan yourself, rebase on main if needed, wait for green CI, squash merge one at a time. If a merge makes another branch conflict, rebase that branch and rerun its checks before merging it.
4. Wave 2: same with T13 and T14. For T13, build the import core first, then split the adapters (MusicAPI login, Spotify link, Apple link, PC listing, file upload) across subagents.
5. Only stop to ask me for: MusicAPI keys, anything that needs my phone or PC, or a choice that can't be undone. Everything else: decide, log it in DECISIONS.md under your ticket, keep going.

When it's all merged, give me one line per ticket on what shipped, then the numbered list of checks I need to do on my phone and PC.
```

## Option B: several terminals, one ticket each

Run T9 first in one terminal and wait for it to merge. Then open one terminal per ticket of the next wave and paste this, changing `TNN` and the branch name.

| Ticket | Branch |
|---|---|
| T9 | t9-foundation |
| T10 | t10-trim |
| T11 | t11-catalog |
| T12 | t12-finder |
| T13 | t13-import |
| T14 | t14-speed |

```
Build ticket TNN of Tapedeck v2 (repo dennycrafter/tapedeck).

Read docs/build/BUILD-HANDOFF.md, then docs/build/V2-PLAN.md (your spec), especially the TNN section and "Rules for parallel work". Other sessions are building other tickets at the same time, so stick to those rules.

Work in your own worktree: git fetch origin, then git worktree add ../tapedeck-tNN -b BRANCH origin/main. Use your e2e ports from the plan's table. Use subagents for pieces that don't depend on each other (for example the downloader part and the web part).

Open one PR. Before merging, rebase on main in case another ticket merged first and rerun the checks. Squash merge when CI is green.

Only ask me for keys, things that need my phone or PC, or a choice that can't be undone. Finish with one line on what shipped and any checks I need to do.
```
