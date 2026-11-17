# Expense Manager — offline Android app

A personal expense tracker that installs on Android like a normal app, works with no internet, and keeps all data on your phone.

**Features:** expenses with categories and payment method · monthly budget · charts by category and by day · search and filters · recurring payments (rent, EMIs, SIPs, subscriptions) added automatically · backup/restore (.json) · spreadsheet export/import (.csv) · light/dark mode.

---

## Install on your Android phone (one-time, ~5 minutes)

To be installable, the app has to be served from an `https://` address once. GitHub Pages does this for free. After you install it, the app never needs the internet again.

1. Sign in at **github.com** (create a free account if needed).
2. Click **+ → New repository**. Name it `expenses`, choose **Public**, and click **Create repository**.
3. On the new repository page, click **uploading an existing file**. Unzip `expense-manager.zip` on your computer, then drag **everything inside the `expense-manager` folder** into the upload area. Upload the folder's contents, not the folder itself, so that `index.html` is at the top level. Click **Commit changes**.
4. Go to **Settings → Pages**. Under *Branch*, choose **main** and **/ (root)**, then click **Save**.
5. Wait about a minute. Your app address appears at the top of that page, like `https://YOUR-NAME.github.io/expenses/`.
6. On your phone, open that address in **Chrome**. Tap **⋮ → Add to Home screen → Install** (or tap the *Install app* prompt if it appears).

The app is now on your home screen and in your app drawer. It opens full screen and works in airplane mode.

> Your expenses are **not** uploaded to GitHub. GitHub only hosts the app's code. Your data lives inside the app on your phone.

## Keeping your data safe

Because your data lives only on the phone, **export a backup regularly** (Settings → Backup & restore → *Export backup* or *Share backup…* to Google Drive). The app reminds you when your last backup is more than 30 days old.

- **Uninstalling the app** or **clearing Chrome's site data** deletes the data. Back up first.
- **New phone:** install the app, then go to *Settings → Import file…* and choose your backup.
- **From the earlier claude.ai web version:** use its *Export CSV* button for each month, then import those CSV files here.

### Import modes
- **Merge** adds new records and updates matching ones; nothing is deleted. Importing the same file twice doesn't create duplicates.
- **Replace all** deletes everything on the phone first, then restores the file.

## Recurring payments
Set an amount, how often it repeats (daily, weekly, monthly or yearly, every N), a first date and an optional end date. Each time you open the app, any payments that have come due are added as expenses, marked with ↻.
- If the first date is in the past, the payments missed since then are added straight away.
- Monthly payments on the 29th–31st fall on the last day of shorter months.
- Deleting one generated expense doesn't bring it back.
- Pausing stops new payments. Deleting the recurring payment lets you keep or remove its history.

---

## Updating the app later (for whoever adds features)

Design rules that keep upgrades safe:

| What | Where | Rule |
|---|---|---|
| App version | `version.js` **and** `sw.js` | Run `python3 bump_version.py X.Y.Z` on every release. Installed phones only notice an update when `sw.js` changes. |
| Data format | `js/schema.js` → `SCHEMA_VERSION`, `MIGRATIONS` | Changing record shapes? Bump `SCHEMA_VERSION` and **add** `MIGRATIONS[old] = (data) => newData`. Never edit or delete old migrations. |
| Optional new fields | `normalize*` in `js/schema.js` | Just give them a default. No migration needed. Unknown fields are preserved. |
| Storage structure | `js/store.js` → `DB_VERSION` | Only for new object stores/indexes. Add an `if (old < N)` block. |
| New files | `sw.js` → `ASSETS` | List every new file so it works offline. |

What happens on upgrade:
1. The phone downloads the new version in the background, and the app shows **"A new version is ready — Update now"**.
2. On first launch of the new version, data saved in an older format is migrated automatically. A copy of the pre-upgrade data is kept in the database (`preUpgradeBackup_vN`).
3. Backups from **any older version** import into the newest version, replayed through every migration in order. Backups from a *newer* version are refused with a clear "update the app first" message.

To publish an update: replace the changed files in the GitHub repository (Add file → Upload files), commit, and wait a minute. Phones pick it up the next time the app is opened while online.

### Files
```
index.html            page structure
manifest.webmanifest  app name, icons, install settings
sw.js                 offline cache + update handling
version.js            app version
bump_version.py       sets the version in version.js + sw.js
css/styles.css
js/app.js             UI and app logic
js/schema.js          data format, migrations, import/export
js/recurring.js       recurring-payment scheduling
js/store.js           on-device database (IndexedDB)
js/util.js            date & formatting helpers
icons/                app icons
```

To test on a computer: run `python3 -m http.server` in this folder and open http://localhost:8000.
