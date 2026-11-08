# Make your own Tapedeck

This guide is for a friend who wants their own copy of Tapedeck: their own app, their own library, their own free accounts. Nothing is shared with anyone else's copy. It takes about 25 minutes, and no coding.

You end up with:

- an app address like `https://tapedeck-yourname.vercel.app` that works on your iPhone and in Chrome,
- your songs stored in your own Cloudflare storage (free up to 10 GB),
- optionally, a small program on your Windows PC that downloads songs from YouTube and SoundCloud links. Without it you can still upload your own song files (MP3, M4A, WAV, FLAC).

> Tapedeck ships no music. You are responsible for following the terms of the sites you use.

## What you need

All free:

1. A **GitHub** account (github.com). Vercel uses it to keep your copy of the code.
2. A **Vercel** account (vercel.com), made with "Continue with GitHub". It runs the app.
3. A **Supabase** account (supabase.com), made with GitHub too. It holds your library.
4. A **Cloudflare** account (dash.cloudflare.com). It stores the song files. It asks for a card, but stays free under 10 GB.

## Step 1. Your database (Supabase, about 5 minutes)

1. On supabase.com, press "New project". Name it `tapedeck`, choose a database password and save it somewhere, pick the region closest to you, then Create. Wait about 2 minutes.
2. Press "Connect" at the top, then "Transaction pooler", and copy the address shown.
3. In that address, replace `[YOUR-PASSWORD]` with your database password. Keep this line: it is your **DATABASE_URL**.

## Step 2. Your song storage (Cloudflare R2, about 5 minutes)

1. On dash.cloudflare.com, open "R2 Object Storage" and add your card when asked.
2. Press "Create bucket" and name it `tapedeck-audio`.
3. Back on the R2 page, press "Manage API tokens", then "Create API token". Choose the permission **Admin Read & Write** and press Create.
4. Keep three values from that page: the **Access Key ID**, the **Secret Access Key**, and the **Account ID** (shown on the main R2 page).

## Step 3. Your app (Vercel, about 5 minutes)

1. Press this button:

   [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fdennycrafter%2Ftapedeck%2Ftree%2Fmain%2Fweb&project-name=tapedeck&repository-name=tapedeck)

2. Vercel makes a copy of the app in your GitHub account and builds it. Press "Create" or "Deploy" when asked. Wait until it says the deployment is ready.
3. In your new Vercel project, open **Settings**, then **Environment Variables**, and add these, one at a time:

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | the line from Step 1 |
   | `R2_ACCOUNT_ID` | the Account ID from Step 2 |
   | `R2_ACCESS_KEY_ID` | the Access Key ID from Step 2 |
   | `R2_SECRET_ACCESS_KEY` | the Secret Access Key from Step 2 |
   | `R2_BUCKET` | `tapedeck-audio` |
   | `APP_PASSWORD` | a password for your app, 12 characters or more |

   Optional extras: `YOUTUBE_API_KEY` turns on YouTube search in the app, and `ANTHROPIC_API_KEY` cleans up song titles better. How to get them: README, section 2, steps 3 and 4.

4. Open your app's address (shown on the project page). It opens the **Setup** page, which shows three more values with Copy buttons. Add them in Environment Variables the same way: `SESSION_SECRET`, `AGENT_TOKEN` and `CRON_SECRET`.
5. Open **Deployments**, press the "..." next to the newest one, then **Redeploy**, so the app picks up the new values.

## Step 4. Finish setup (1 minute)

1. Open your app again. On the Setup page, every dot should be green.
2. Type your app password and press **Finish setup**. It makes the database tables and the storage settings by itself, then shows the login screen.
3. Log in. You can now add songs by uploading files: press **Add**, then **Upload**.

## Step 5. Your iPhone

1. Open your app's address in Safari.
2. Press Share, then **Add to Home Screen**.
3. Open it from the home screen and log in there (the home screen app has its own login).

## Step 6. Optional: the PC downloader (Windows, about 10 minutes)

This lets you paste YouTube and SoundCloud links: your PC downloads the songs whenever it is on.

1. On github.com/dennycrafter/tapedeck press the green **Code** button, then **Download ZIP**. Unzip it into your Documents folder.
2. Open the unzipped folder, then `agent`, and double-click **install.bat**. It installs what it needs (this takes a few minutes the first time).
3. When it asks for the **setup code**: in your app, open Profile, then Downloader setup, press Copy next to "Setup code", paste it into the installer window (right-click pastes there) and press Enter.
4. The downloader now starts by itself whenever you log in to your PC.

## If something goes wrong

- **The Setup page shows a red dot:** that value is missing or mistyped in Vercel's Environment Variables. Fix it, then Redeploy (Step 3.5).
- **"Finish setup" fails on the database:** check the password inside DATABASE_URL (Step 1.3).
- **Uploads fail with "Check your connection":** check the three R2 values and that the bucket is named `tapedeck-audio`.
- **Songs stay "Waiting for your PC":** the PC downloader is not running. Restart the PC, or run install.bat again.
- **Library gone after a quiet week:** free Supabase projects pause after a week without use. Open supabase.com and press Restore.
