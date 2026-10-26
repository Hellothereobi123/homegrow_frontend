# HydroOS: Progress Log

Status as of 2026-10-26. Covers everything done so far on the HydroOS React Native app, the Bluetooth LE (BLE) offline fallback, and the Raspberry Pi side.

---

## 1. App features

The app is a React Native (Expo SDK 57, RN 0.86) dashboard for hydroponic systems. Almost all of the UI lives in [`src/app/index.tsx`](src/app/index.tsx).

### Committed

| Commit | What it did |
|---|---|
| `fe0c84a` | Supabase sensor feed: loads readings on launch and refreshes every 5 minutes, with a countdown to the next refresh. If a refresh fails, the last good data stays on screen and systems are marked offline. |
| `9c20225` | Bluetooth button (ᛒ) in the system top bar with a **simulated** connection popup. |
| `f8b28ec` | Countdown shows the time on its own line ("Next refresh" / "m:ss"). |

### Not yet committed

- **Real BLE sync**, replacing the simulated popup (see section 2).
- **All eight sensor parameters** on the dashboard and history:

  | Parameter | Supabase column | Where it shows |
  |---|---|---|
  | Time of recording | `recorded_at` | "Reading recorded HH:MM" line |
  | pH | `ph` | Water Chemistry |
  | EC | `ec` | Water Chemistry |
  | Water temperature (°C) | `water_temp` | Water Chemistry *(new)* |
  | Air temperature | `temperature_c` | Environment (renamed from "Temperature") |
  | Humidity | `humidity` | Environment *(new)* |
  | Light intensity | `light_intensity` | Environment |
  | CO₂ (ppm) | `co2` | Environment *(new)* |

  The new cards use these optimal ranges, which still need confirming for your crops: water 18–22 °C, humidity 50–70 %, CO₂ 800–1,200 ppm.
- **Missing values show "—"**, instead of 0 or "NaN", and are skipped in charts.
- **Timestamp handling:** values are trimmed to millisecond precision, because Android can't parse microsecond timestamps.
- **Current Insights** on the Plant Vision screen, below the "Recent" carousel:
  - `fetchLatestInsight()` reads the newest non-empty `insights` value from `sensor_readings`, ordered by `recorded_at`.
  - `useLatestInsight()` fetches it when the screen opens, then **hourly** (`INSIGHTS_REFRESH_MS`).
  - It currently shows a **dummy insight** (`USE_DUMMY_INSIGHT = true`), because the `insights` column doesn't exist yet. Set the flag to `false` once the column has data.
- The readings refresh interval is set back to 5 minutes (`REFRESH_INTERVAL_MS`).

---

## 2. Bluetooth LE offline fallback

**Goal:** when Wi-Fi or Supabase is unavailable, the phone connects directly to the Raspberry Pi over BLE and pulls the latest readings from the Pi's local SQLite database.

### Protocol: [`ble-protocol.md`](ble-protocol.md)

This is the contract both sides implement:
- **Identity:** service `6e3a1f80-…`, CONTROL characteristic `…f81` (write), DATA characteristic `…f82` (notify). The Pi advertises as `HydroPi-<hostname>`.
- **Exchange:**
  1. The app connects with an MTU of 517.
  2. It subscribes to DATA *before* writing `GET <n>` to CONTROL.
  3. The Pi replies with one header, `n` row messages, and an end marker.
- **Data:** each message is compact JSON. Rows are positional, newest first, and any value may be `null`. `sensors_ok: false` means the Pi's sensor loop has stalled.
- **Read-only by design:** the phone can't send commands to the control loop.

### App side (done, untested against a real Pi)

- **[`src/ble/pi-ble.ts`](src/ble/pi-ble.ts)** holds all the BLE logic:
  - asks for permissions and checks that Bluetooth is on;
  - scans only for the HydroPi service;
  - `fetchRowsOverBle()` connects, subscribes, sends `GET 10`, and checks the header, row indices and end marker;
  - handles `err` messages, times out after 10 seconds, and always disconnects.
- **Bluetooth Sync popup** in `index.tsx`:
  - scans for Pis and syncs on tap, with "Sync again" for the last Pi used;
  - warns when the Pi reports its sensors have stalled;
  - shows errors such as permission denied, Bluetooth off or timeout.
- **How readings are used:** BLE rows go through the same `rowToReading` as Supabase rows and are merged into history without duplicates. The dashboard shows "via Bluetooth" (or "via Bluetooth · stale").
- **Offline prompts:**
  - when the Supabase refresh fails, the top bar shows "Offline, tap ᛒ";
  - if the very first load fails, the error screen offers "Sync from Pi over Bluetooth".
- **Platforms:** BLE only runs on Android. On web and in Expo Go the ᛒ button is hidden and the BLE module never loads.
- **Native setup:**
  - installed `react-native-ble-plx` 3.5, `expo-dev-client` and `buffer`;
  - in `app.json`: added the BLE config plugin (`neverForLocation: true`) and the package name `com.hydroos.automatedhydroponic`.

### Pi side (not finished)

- **Current state:** [`pi/ble_server.py`](pi/ble_server.py) is currently `bless`'s **example server**, not a server that follows the protocol.
- **Earlier draft lost:** an earlier version (SQLite seeding, `GET n` replies, a guard against hanging on Windows, full comments) was overwritten. It was never committed, and it used older UUIDs and columns than `ble-protocol.md`.
- **What the Pi server needs:** follow `ble-protocol.md`, and share the Pi with the sensor and computer-vision processes:
  - SQLite in WAL mode with `busy_timeout`, and a read-only BLE connection;
  - database reads off the BLE event loop;
  - `systemd` services with CPU and memory limits.

  The full plan is at `C:\Users\tharu\.claude\plans\can-you-create-a-gentle-creek.md`.
- **Leftover files:** `temp_pi/` holds an experiment (`temp_server.py` plus its own venv). `pi/requirements.txt` now lists `bless`'s development dependencies.

### Testing BLE on the Windows laptop: conclusion

**`bless` can't host a GATT server on this laptop.** Windows aborts the service advertisement every time (status 3, "Aborted"). That happens even for an empty service and even with `bless`'s own example. Ruled out:

| Check | Result |
|---|---|
| Adapter (Intel Wireless Bluetooth) supports peripheral role, radio on | ✅ |
| Plain (non-GATT) BLE advertisement | ✅ works |
| Intel driver updated (now 24.70.0.4) and laptop restarted | ✅ still aborts |
| Earbuds disconnected, Phone Link closed | ✅ still aborts |
| Windows Bluetooth privacy permissions | ✅ all "Allow" |

**Ways to test the server instead:** the Pi itself, a Mac, or a USB Bluetooth dongle with a different chip.

**Windows Python setup, for reference:** `bless` needs **Python 3.11** on Windows; on 3.12 it can't install cleanly. Use a uv-managed venv at `pi/.venv`. `bless` also needs `pysetupdi`, which is only available from GitHub (`git+https://github.com/gwangyi/pysetupdi`).

---

## 3. Building and running on the phone

**Phone:** Galaxy S25 (SM-S931U). The **development build** is installed, and the app loads its JavaScript from Metro on the laptop.

### One-time phone setup

- Turn on Developer options and **USB debugging**.
- Turn **Auto Blocker off** (Settings → Security and privacy).
- Use the **USB-A to USB-C cable**. The USB-C to USB-C cable dropped the connection during installs.

### Everyday: JavaScript changes only

Terminal 1, to start Metro, and keep it running:

```bash
npx expo start --dev-client
```

Terminal 2:

```bash
adb reverse tcp:8081 tcp:8081
```

```bash
adb shell am start -a android.intent.action.VIEW -d "exp+automatedhydroponicpj5e://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081" com.hydroos.automatedhydroponic
```

### Reinstall the existing build

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Then run the two Terminal 2 commands above.

### Rebuild: after adding native packages or changing `app.json`

```bash
npm run android
```

Then run the two Terminal 2 commands above. `android/` is generated by `npx expo prebuild` and isn't tracked in git.

### Why the extra commands

- **The Wi-Fi blocks phone-to-laptop traffic.** This network blocks connections between devices, so the app must reach Metro through the USB cable. `adb reverse` sets that up, and the deep link tells the app to use `localhost`. On home Wi-Fi or a phone hotspot, `npm run android` alone works.
- **Don't use `--localhost` with Metro.** It makes Metro listen only on IPv6 `[::1]`, and the USB forwarding can't reach that. The result is an "unexpected end of stream" error.

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| White screen | Metro not running, or the app is pointed at the Wi-Fi address | Start Metro, then run the Terminal 2 commands |
| "Unexpected end of stream on localhost:8081" | Metro started with `--localhost` | Restart Metro without it |
| "Unable to resolve Intent" | App isn't installed | Run `adb install -r …app-debug.apk` |
| `adb install` fails, phone goes `offline` | Cable, or Auto Blocker | USB-A to USB-C cable, Auto Blocker off, replug and tap Allow |
| Phone missing from `adb devices` | USB debugging switched off on the phone | Re-enable it, replug, tap Allow |

### Release (standalone) build: currently fails

A release build bundles the JavaScript into the APK, so the app runs without the laptop. That's needed for testing the BLE fallback with Wi-Fi off.

It currently fails because of the Android SDK's **CMake 3.22.1**, with the error `ninja: build.ninja still dirty after 100 tries`. The fix:
1. Android Studio → SDK Manager → SDK Tools → Show Package Details → install CMake **3.31.x**.
2. Add `cmake.dir=C:/Users/tharu/AppData/Local/Android/Sdk/cmake/<version>` to `android/local.properties`.
3. Run `npx expo run:android --variant release`.

---

## 4. Open items

- [ ] **Commit** the current work. None of section 1's "Not yet committed" items, or section 2, are in git.
- [ ] **Pi BLE server:** write a `pi/ble_server.py` that follows `ble-protocol.md`, and test it on the Pi with nRF Connect, then with the app.
- [ ] **Add `water_temp` to `ble-protocol.md`** and the Pi server. Over BLE it currently always shows "—".
- [ ] **Add the `insights` column** in Supabase, then set `USE_DUMMY_INSIGHT = false`.
- [ ] **Install CMake 3.31** and produce a release APK for offline testing.
- [ ] **Confirm the optimal ranges** for water temperature, humidity and CO₂.
- [ ] **Clean up `temp_pi/`**, and decide what `pi/requirements.txt` should contain for the Pi.
- [ ] **Fix the Expo version mismatch:** Expo reports `57.0.24 → ~57.0.30`. Run `npx expo install --check` when convenient.

---

## 5. File map

| Path | Purpose |
|---|---|
| `src/app/index.tsx` | Whole app UI: home, system detail, dashboard, controls, vision, history, modals, Supabase fetches |
| `src/ble/pi-ble.ts` | BLE scan, fetch and protocol handling |
| `ble-protocol.md` | Pi ↔ app BLE contract |
| `app.json` | Expo config, including the BLE plugin and Android package name |
| `pi/` | Pi-side BLE server work (currently the `bless` example) and the Windows test venv |
| `temp_pi/` | Scratch experiment, safe to review and remove |
| `android/` | Generated native project (git-ignored) |
