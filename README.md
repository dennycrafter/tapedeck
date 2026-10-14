# Tapedeck

**Start here: [docs/HANDOFF.md](docs/HANDOFF.md)** (what was built, and your steps to go live).

## 1. What Tapedeck is

Tapedeck is a personal music app. You paste a YouTube or SoundCloud link (or search YouTube in the app), a small program on your Windows PC downloads the audio, and the song plays on your iPhone (installed to the home screen) and in Chrome on your PC.
It has your own playlists, liked songs and favourite albums, plays in the background with the phone locked, and works offline for songs you download.
No ads, no subscription: the only accounts are free tiers you create yourself.

> **Personal use note:** Tapedeck ships no music. You are responsible for following the terms of the sites you use.

## 2. One-time setup (go live)

Try it on your computer first: `cd web`, `npm install`, `npm run dev`, open http://localhost:3000, password `tapedeck-dev`. It runs on built-in stand-ins, no accounts needed.

When you are ready to use it for real (about 20 minutes):

1. **Supabase.** supabase.com > sign in with GitHub > "New project", name `tapedeck`, choose a database password (save it), region "East US", Create, wait about 2 minutes. Click "Connect" at the top > "Transaction pooler" > copy the URI and put your database password where it says `[YOUR-PASSWORD]`. This is `DATABASE_URL`.
2. **Cloudflare R2.** dash.cloudflare.com > sign up > R2 Object Storage. It asks for a card: add it (it stays free under 10 GB). "Create bucket", name `tapedeck-audio`. Back on the R2 page: "Manage API tokens" > "Create API token" > permission **Admin Read & Write** > Create. Copy Access Key ID (`R2_ACCESS_KEY_ID`), Secret Access Key (`R2_SECRET_ACCESS_KEY`) and the Account ID on the R2 page (`R2_ACCOUNT_ID`).
3. **YouTube key (optional, turns on search).** console.cloud.google.com > "Select a project" > "New project" `tapedeck` > search "YouTube Data API v3" > Enable > "Credentials" > "Create credentials" > "API key". This is `YOUTUBE_API_KEY`.
4. **Anthropic key (optional, smarter title cleanup).** console.anthropic.com > API Keys > Create key. This is `ANTHROPIC_API_KEY`.
5. **Vercel.** vercel.com > "Add New" > Project > import `dennycrafter/tapedeck` > Root Directory `web` > Deploy. Then Settings > Environment Variables: add `DATABASE_URL`, the three R2 values, `R2_BUCKET` = `tapedeck-audio`, the optional keys, and `APP_PASSWORD` (your own password, 12 or more characters). Open the app: the Setup page shows three generated secrets with Copy buttons; add them as `SESSION_SECRET`, `AGENT_TOKEN`, `CRON_SECRET`. Deployments > "..." > Redeploy.
6. Open the app again, type your password on the Setup page and press "Finish setup". It creates the database tables and the storage settings by itself, then takes you to the login screen.

The three secrets are generated for you on the Setup page. If you run your own copy and want to make one yourself, paste this into Windows Command Prompt:

```
py -c "import secrets;print(secrets.token_hex(32))"
```

## 3. PC downloader

1. Download this repo (green "Code" button > Download ZIP) and unzip it to `C:\Users\<you>\Documents\tapedeck`, or clone it there.
2. Double-click `agent\install.bat`. It installs Python, Deno and FFmpeg if needed, sets the downloader to start when you log in, and opens a Notepad window.
3. In the app, open Profile > "Downloader setup". Copy `APP_URL` and `AGENT_TOKEN` into the Notepad window, save, and close it.

From then on the downloader runs in the background whenever your PC is on and you are logged in.

## 4. iPhone

1. Open the app's address in Safari.
2. Share > Add to Home Screen.
3. Open it from the home screen and log in there (the home screen app has its own login, separate from Safari).

## 5. Daily use

- Add songs from anywhere (phone or PC). They download the next time your PC is on.
- Before a flight, download playlists or albums ("Download" on the page) so they play offline.
- "Save to Files" in a song's menu saves the file itself (on the iPhone, pick "Save to Files" in the share sheet).

## 6. Apple Music (optional)

1. In the app, Profile > Settings > turn on "Also add to Apple Music on my PC". (Or use "Add to Apple Music" in a single song's menu.)
2. Keep Apple Music open on the PC. New songs are added to its library by themselves.
3. To get them onto the iPhone, sync it with the Apple Devices app on the PC (cable or Wi-Fi). This part is not automatic without an Apple Music subscription.

## 7. Not working?

- **Songs stuck on "Waiting for your PC":** is the PC on and logged in? Check `agent\logs\downloader.log`.
- **Downloads failing after they worked before:** YouTube changed something. Restart the PC so the downloader updates yt-dlp.
- **"Search limit reached":** that is YouTube's free daily limit. Paste links instead until tomorrow.
- **Library gone:** the free Supabase project pauses after a week without use. Open Supabase and restore it.
- **Audio stops when the phone is locked:** open the app from the home screen icon, not from Safari.

---

MIT licence, see [LICENSE](LICENSE). Developer notes: [SPEC.md](SPEC.md) (the build spec), `docs/` (decisions, test results, UI review), `web/` (the app), `agent/` (the PC downloader).
