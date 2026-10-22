# Plate

A calorie and macro tracker with a barcode scanner. One codebase, shipped two ways:
an installable web app, and an Android APK.

No account, no server, no analytics. Everything you log stays in the browser (or the
app) on your own device.

---

## What it does

**Targets.** Enter height, weight, age, activity and goal. Plate works out your
resting burn (Mifflin–St Jeor), your maintenance calories, and a daily target with a
protein/carb/fat/fibre split.

**Logging.** Four routes into the diary:

- **Scan a barcode** with the camera. Products are looked up in
  [Open Food Facts](https://world.openfoodfacts.org), a free database of roughly three
  million items. Scanned products are saved locally, so the second scan needs no network.
- **Search** a built-in table of ~105 foods, weighted toward Jamaican home cooking —
  rice and peas, ackee and saltfish, festival, bammy, curry goat, cornmeal porridge.
  This works with no connection at all.
- **Type the barcode number** when the camera won't cooperate.
- **Enter the numbers by hand** off the pack. Saved foods reappear in search.

**Eat more or eat less.** Plate says which, in three places: a verdict on the day that
shifts with the clock, a weekly read-out of average intake against target, and a weight
trend that compares your real rate of change to your planned one.

**Meal plans.** Built from the food table and solved to land on your calorie *and*
protein targets, with a shopping list. Runs offline. Jamaican, mixed or light, with a
vegetarian switch.

### Guardrails

Targets are clamped rather than taken literally:

- Never below 1,200 kcal (women) or 1,500 kcal (men).
- Deficits capped at 25% of maintenance; surpluses at 20%.
- Loss capped at roughly 1% of bodyweight a week, gain at 0.5 kg.
- Protein keyed to a reference weight rather than raw bodyweight, so a heavier person
  doesn't get a target no real plate can meet.
- Goal weights below a healthy BMI are refused, and a warning shows instead.

It isn't medical advice, and the app says so.

---

## Repository layout

```
web/            The app. Plain HTML, CSS and JavaScript — no build step, no framework.
  index.html
  app.js        Targets, diary, coaching, scanner, Open Food Facts, meal planner
  foods.js      The built-in food table
  styles.css
  sw.js         Service worker — caches the shell so it opens offline
  manifest.webmanifest
  icons/
android/        A WebView host for web/. Gradle project, no Android Studio required.
.github/workflows/
  pages.yml     Deploys web/ to GitHub Pages on every push to main
  android.yml   Builds the APK on every push to main, and on each release
```

The Android app is not a separate implementation — `android.yml` copies `web/` into the
APK's assets at build time. Change `web/`, and both versions change.

---

## Running it

### As a web app

Nothing to install. Open the Pages URL, then use **Add to Home Screen** (Share menu in
Safari, ⋮ menu in Chrome). It gets an icon and opens full screen.

To run it locally, serve the folder over http — opening `index.html` as a file will
disable the camera and the service worker:

```bash
cd web && python3 -m http.server 8000
# then open http://localhost:8000
```

### As an Android app

Download the APK from the latest run of the **Build Android APK** workflow under the
Actions tab (expand the run, grab the `plate-debug-apk` artifact). Allow installing from
unknown sources, and install it.

To build locally instead, open `android/` in Android Studio after copying the web app in:

```bash
mkdir -p android/app/src/main/assets
cp -r web/. android/app/src/main/assets/
rm -f android/app/src/main/assets/sw.js
```

Then **Build → Build APK**. From the command line, `cd android && gradle assembleDebug`
(the wrapper isn't committed; run `gradle wrapper` once if you want it).

---

## Setting up the repository

1. **Pages** — Settings → Pages → Source: **GitHub Actions**. The next push to `main`
   publishes it.
2. **Signed release APKs** (optional) — a debug APK installs fine for personal use. For
   a signed one, add four repository secrets and publish a GitHub release:
   `KEYSTORE_B64` (your keystore, base64-encoded), `KEYSTORE_PASSWORD`, `KEY_ALIAS`,
   `KEY_PASSWORD`. Without them the release job is skipped and the debug APK is still built.

---

## Notes on how it's built

**Why a WebView rather than a native app.** The whole app is one HTML page and about
1,500 lines of JavaScript. A native rewrite would duplicate the maths, the food table and
the planner for no user-visible gain.

**Why assets are served over https inside the APK.** `getUserMedia` only runs in a secure
context, and `file://` is not one — the camera would be dead. `WebViewAssetLoader` serves
the assets from `https://appassets.androidplatform.net`, which is.

**The barcode fallback.** Chrome and Android WebView have a built-in `BarcodeDetector`.
Safari and Firefox don't, so CI fetches ZXing into `vendor/` at deploy time and the app
loads it only when needed. If that step fails the app still works — it falls back to
typing the number.

**Browser storage.** `localStorage`, wrapped in try/catch throughout, with export and
restore in the You tab. Clearing site data wipes the diary, so take a backup now and then.

---

## Credit and licence

Product data comes from [Open Food Facts](https://world.openfoodfacts.org) and is licensed
under the [Open Database License](https://opendatacommons.org/licenses/odbl/1-0/).

Energy and macro figures in the built-in food table are typical published values for each
food. They are estimates, and home cooking varies — the trend over weeks is what to read,
not any single day.
