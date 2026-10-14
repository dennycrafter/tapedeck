# UI review (T5)

Self-review of every screen against the SPEC section 10 design rules, from screenshots taken with made-up songs at 1440px (desktop) and 390px (iPhone 13). The screenshots are in [`docs/screenshots/`](screenshots/) as `desktop-<screen>.jpg` and `phone-<screen>.jpg`. The seeded songs, playlists and favourites were removed afterwards.

## The rules

| # | Rule (SPEC 10) |
|---|---|
| R1 | Dark only, the SPEC colour tokens |
| R2 | Corners: boxes and covers 8px, buttons and inputs 6px; pills only for status |
| R3 | Four greys only; inputs sit on the page background |
| R4 | Accent only on the one main action of the screen |
| R5 | System font for text; Saira only for big numbers |
| R6 | Pop-ups and menus: surface-2, 1px outline, light shadow |
| R7 | Lists like an inbox: one box, thin dividers, row anatomy, status as a dot plus muted text |
| R8 | Blank cover: surface-2 square with a muted music note |
| R9 | No video, visualiser or moving background; Now playing may use the cover blurred at 0.15 |
| R10 | Add opens a floating window (outside click, X or Escape closes; toast on success) |
| R11 | Max width 1760px, gutter clamp(16px, 2.6vw, 40px), no sideways scroll on phones, safe areas |
| R12 | Visible focus outlines, aria labels on icon buttons, Escape closes every modal, desktop shortcuts |
| R13 | No en or em dashes in any UI text |
| R14 | Per-device choices in localStorage, wrapped in try/catch |

## Per screen

Every rule passes on every screen. "Fixed" means it failed in the first round of screenshots and was fixed, then re-shot.

| Screen | R1 | R2 | R3 | R4 | R5 | R6 | R7 | R8 | R9 | R10 | R11 | R12 | R13 | R14 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Login | pass | pass | pass | pass (Unlock) | pass | n/a | n/a | n/a | pass | n/a | pass | pass | pass | n/a |
| Home | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | pass | n/a |
| Search | pass | pass | pass | pass | pass | n/a | pass | pass | pass | n/a | pass | pass (`/` focuses it) | pass | n/a |
| Library: Songs | pass | pass | pass | pass | pass | pass (sort menu) | pass | pass | pass | n/a | pass | pass | pass | pass (sort remembered) |
| Library: Liked, Playlists, Albums, Artists, Recently played, Downloaded | pass | pass | pass | pass | pass | n/a | pass | pass | pass | n/a | fixed (open tab scrolled out of view on phones) | pass | pass | n/a |
| Playlist | pass | pass | pass | pass (big Play) | pass | pass | pass | pass | pass | n/a | pass | pass (drag by keyboard too) | pass | n/a |
| Album | pass | pass | pass | pass (big Play) | pass | pass | pass | pass | pass | n/a | pass | pass | pass | n/a |
| Artist | pass | pass | pass | pass (big Play) | pass | pass | pass | pass | pass | n/a | pass | pass | pass | n/a |
| Now playing | pass | pass | pass | pass (play/pause) | pass (time in Saira) | pass | n/a | pass | pass (cover blurred, 0.15) | n/a | pass | pass (Escape, swipe down) | pass | pass (shuffle, repeat, volume) |
| Queue | pass | pass | pass | pass | pass | pass | pass | pass | pass | n/a | pass | pass (Escape) | pass | n/a |
| Add window | pass | pass | pass | pass (Add) | pass | pass | n/a | n/a | pass | pass | pass | pass | pass | n/a |
| Profile | pass | pass | pass | pass (no accent) | pass (stats in Saira) | pass | pass | n/a | pass | n/a | fixed ("0.1 of 10 GB" wrapped on phones) | pass | pass | n/a |

## Fixed during the review

1. **Library tabs on phones:** the open tab could sit off screen in the sideways tab strip (for example "Artists"). It now scrolls into view.
2. **Profile storage on phones:** "0.1 of 10 GB" wrapped onto two lines in the half-width cell. The number stays big; "of 10 GB" is small muted text next to it.
3. **Console errors on the password screen:** the app asked for the library before you logged in (a 401 in the console). The login, setup, test-audio and offline pages no longer load the library.
4. **Display font:** Saira is self-hosted (`@fontsource/saira`) instead of loaded from Google, so it works offline and makes no outside requests.

## Notes

- **R4 and the player:** SPEC 10 names both the big Play button on playlist, album and artist pages and the player's play/pause as accent buttons. With a song loaded, both are visible on those pages. The automated check (at most one accent per page) runs with nothing playing.
- **Automated checks** (`web/e2e/t5-ui.spec.ts`, `web/e2e/t5-lighthouse.spec.ts`): no sideways scroll at phone width, no en or em dashes in rendered text, at most one accent element, no console errors, on every page and every project; Lighthouse accessibility 100 on Home and 100 on Library.
