# Bintelligence — Android app

Live dashboard and WiFi setup for the Bintelligence smart dustbin. See the
[main README](../README.md) for how the pieces fit together.

## Before building

Set your classifier server in `app.json`:

```json
"extra": { "defaultServerUrl": "https://YOUR-USERNAME-waste-classifier.hf.space" }
```

(It can also be changed later in the app under **Settings**.)

## Build an installable APK

The app contains a small native module (`modules/bin-wifi`) for joining the
bin's setup hotspot, so it runs as its own app — not inside Expo Go.

**Option A — locally (Windows, needs Android Studio installed):**

React Native's C++ build breaks Windows' 260-character path limit when the
project lives deep under `Documents\PlatformIO\Projects\…`, so build from a
copy in a short folder (a `subst` drive does not help — Node resolves it back
to the long path):

```bat
robocopy C:\Users\slohi\Documents\PlatformIO\Projects\dustbin\mobile C:\bb\mobile /E /XD C:\Users\slohi\Documents\PlatformIO\Projects\dustbin\mobile\node_modules C:\Users\slohi\Documents\PlatformIO\Projects\dustbin\mobile\android
cd /d C:\bb\mobile
npm install
npx expo prebuild --platform android --clean
cd android
set JAVA_HOME=C:\Program Files\Android\Android Studio\jbr
gradlew assembleRelease
```

The APK is written to `C:\bb\mobile\android\app\build\outputs\apk\release\app-release.apk`.
Expo SDK 57 wants Node.js 20.19.4 or newer.
Copy it to the phone and open it, or with USB debugging on:
`adb install -r app-release.apk`.

> Use Android Studio's bundled JDK (`jbr`) — Gradle rejects very new JDKs
> such as Java 24.

**Option B — in Expo's cloud (free account, no Android Studio):**

```bash
npx eas-cli@latest login
npx eas-cli@latest build -p android --profile preview
```

When it finishes you get a link / QR code to download the APK.

## Develop

```bash
npx expo run:android     # build a dev build onto a USB-connected phone
npx expo start           # then just restart Metro for JS changes
npm run lint
npm run typecheck
```

## Layout

```
src/app/              Screens (Expo Router)
  (tabs)/index.tsx    Home — live status, today's counts, latest item, actions
  (tabs)/history.tsx  Sorted items with photos
  (tabs)/test.tsx     Classify a photo from the phone
  (tabs)/logs.tsx     Live device log
  (tabs)/settings.tsx Server URL, WiFi, forget bin
  setup.tsx           WiFi setup wizard
  event/[id].tsx      One sorted item: photo, bounding box, probabilities
src/lib/api.ts        Server API (status, events, logs, commands, /predict)
src/lib/provision.ts  Talks to the bin at 192.168.4.1 during setup
modules/bin-wifi/     Kotlin module: join "Bintelligence-XXXX" and bind to it
```
