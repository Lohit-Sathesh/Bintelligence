# Bintelligence — Smart Waste-Sorting Dustbin

An ESP32-CAM dustbin that photographs whatever is dropped in, sends the image to
a machine-learning server, and tilts a servo tray to drop the item into the
**wet** or **dry** compartment. An Android app shows what the bin is doing
live and sets up its WiFi, so you never have to reflash it for a new network.

| Part | Folder | Runs on |
|---|---|---|
| Firmware | `src/`, `include/` | ESP32-CAM inside the bin |
| Classifier server + training | `backend/` (formerly the separate **garbage-sorter** repo) | Hugging Face Space (or a PC on the LAN) |
| Mobile app | `mobile/` | Android phone |

---

## How it works

```
   ┌───────────────────────────────────────────────────────────────┐
   │  DUSTBIN (ESP32-CAM)                                          │
   │                                                               │
   │   IR sensor ──► detect item                                   │
   │        │                                                      │
   │        ▼                                                      │
   │   OV2640 camera ──► capture JPEG (QVGA)                       │
   │        │                                                      │
   │        ▼                                                      │
   │   HTTP POST  multipart/form-data                              │
   └────────┬──────────────────────────────────────────────────────┘
            │  HTTPS, over any WiFi with internet
            ▼
   ┌───────────────────────────────────────────────────────────────┐
   │  HUGGING FACE SPACE — garbage-sorter (FastAPI + TFLite)       │
   │                                                               │
   │   POST /predict ──► EfficientNetB0 ──► {"class":"wet"|"dry"}  │
   │   /device/*  ◄── heartbeats, photos, logs ──►  phone app      │
   └────────┬──────────────────────────────────────────────────────┘
            │  JSON response
            ▼
   ┌───────────────────────────────────────────────────────────────┐
   │   Servo tilts tray  ◄── parse "class"                         │
   │   dry → 25°   ·   wet → 155°   ·   rest → 90°                 │
   │   then shake, return to centre, wait for IR to clear          │
   └───────────────────────────────────────────────────────────────┘
```

> **Note on "wet" vs "dry"** — these mean **organic vs recyclable**, not
> moisture. Food scraps and biological waste are `wet`; paper, plastic, metal,
> glass and cardboard are `dry`. Damp paper still classifies as `dry`, because
> the model sorts by material category, not wetness.

---

## Hardware components

| Component | Model / spec | Purpose |
|---|---|---|
| Microcontroller + camera | **AI-Thinker ESP32-CAM** (ESP32-S, OV2640, 4 MB flash, PSRAM) | WiFi, image capture, all control logic |
| Servo | **MG996R** metal-gear, 4.8–7.2 V | Tilts the sorting tray |
| Proximity sensor | **IR obstacle-avoidance module** (active-LOW digital out) | Detects waste entering the bin |
| Programmer | **ESP32-CAM-MB** shield *or* any FTDI / CP2102 USB-TTL adapter | Flashing firmware + USB serial |
| Power | Regulated **5 V** supply for the servo, 5 V for the board | See the power section below |

---

## Wiring

### IR sensor → ESP32-CAM

| IR module | ESP32-CAM |
|---|---|
| `VCC` | `5V` |
| `GND` | `GND` |
| `OUT` | `GPIO13` |

The module must be **active-LOW** (output goes LOW when something is detected) —
that is what `irBlocked()` in [`src/main.cpp`](src/main.cpp) expects. Most cheap
IR obstacle modules behave this way and have a potentiometer to set range.

### Servo → ESP32-CAM

| MG996R wire | Connect to |
|---|---|
| Orange / yellow (signal) | `GPIO14` |
| Red (V+) | **External regulated 5–6 V** — *not* the ESP32's 3.3 V pin |
| Brown (GND) | External supply GND **and** ESP32 `GND` (common ground required) |

### Camera

The OV2640 is soldered to the ESP32-CAM module — no wiring needed. The pin map
lives in [`include/camera_pins.h`](include/camera_pins.h):

| Signal | GPIO | | Signal | GPIO |
|---|---|---|---|---|
| `PWDN` | 32 | | `Y9 / D7` | 35 |
| `RESET` | *(none)* | | `Y8 / D6` | 34 |
| `XCLK` | 0 | | `Y7 / D5` | 39 |
| `SIOD` (SDA) | 26 | | `Y6 / D4` | 36 |
| `SIOC` (SCL) | 27 | | `Y5 / D3` | 21 |
| `VSYNC` | 25 | | `Y4 / D2` | 19 |
| `HREF` | 23 | | `Y3 / D1` | 18 |
| `PCLK` | 22 | | `Y2 / D0` | 5 |

### Flashing connections

| ESP32-CAM | USB-TTL adapter |
|---|---|
| `U0T` (TX) | `RX` |
| `U0R` (RX) | `TX` |
| `GND` | `GND` |
| `5V` | `5V` |
| `IO0` | `GND` — **only while flashing** |

Jumper `IO0`→`GND`, press reset, upload, then **remove the jumper** and reset
again to run normally. The ESP32-CAM-MB shield handles all of this
automatically, so it is much less fiddly than a bare FTDI adapter.

> **GPIO conflict note:** GPIO13 and GPIO14 are also SD-card pins
> (`HS2_DATA3` / `HS2_CLK`) on the ESP32-CAM. That is fine here because the SD
> card is not used, but you cannot add SD storage without moving the IR sensor
> and servo to other pins.

---

## Power — read this before wiring

Power is the single most common cause of failures on this build.

- **The MG996R needs its own regulated 5–6 V supply.** It draws ~1 A while
  moving and can spike to ~2.5 A when stalled. The ESP32-CAM's onboard
  regulator cannot supply that; sharing it causes jitter, brownouts, camera-init
  failures and random reboots.
- **Tie the grounds together.** The servo supply GND and the ESP32 GND must be
  common, or the PWM signal has no reference and the servo behaves erratically.
- **Do not drive the servo straight off a 2S Li-ion pack.** A full 2S pack sits
  at ~8.4 V, above the MG996R's 7.2 V maximum, and sags below its 4.8 V minimum
  as it discharges. Put a **5 V buck converter / UBEC** between the pack and the
  servo so the voltage is stable regardless of charge level.
- **Symptoms of undervolt:** servo jerks or hums instead of moving smoothly; the
  ESP32 connects to WiFi but is unreachable (browns out during transmit spikes);
  random resets under load.

---

## Tech stack

**Firmware (this repo)**

| Layer | Technology |
|---|---|
| Framework | Arduino for ESP32 (`espressif32` platform) |
| Build system | PlatformIO |
| Camera | `esp_camera` (ESP-IDF component bundled with the Arduino core) |
| Networking | `WiFi.h`, `HTTPClient.h` + `WiFiClientSecure` (HTTPS), `WiFiServer` (wireless log) |
| WiFi setup | `WebServer` + `DNSServer` setup hotspot, settings in NVS via `Preferences` |
| Servo | [`madhephaestus/ESP32Servo`](https://github.com/madhephaestus/ESP32Servo) — LEDC-based PWM |
| Log viewer | `wireless_monitor.py` (Python 3 standard library only) |

**Backend (`backend/`, formerly the separate `garbage-sorter` repo)**

| Layer | Technology |
|---|---|
| API | FastAPI + Uvicorn |
| Inference | `ai-edge-litert` (TensorFlow Lite runtime) |
| Model | EfficientNetB0 transfer learning, binary sigmoid + 7×7 Grad-CAM heatmap |
| Training | TensorFlow / Keras, Kaggle waste datasets |
| Frontend | Vanilla HTML/CSS/JS dashboard (upload · URL · webcam) |
| Device telemetry | `app/devices.py` — in-memory heartbeats, sort history, logs, commands |

**Mobile app (`mobile/`)**

| Layer | Technology |
|---|---|
| Framework | Expo SDK 57 · React Native 0.86 · TypeScript · Expo Router |
| WiFi setup | Local Expo module `modules/bin-wifi` (Kotlin, `WifiNetworkSpecifier`) |
| UI | `expo-image`, `react-native-svg`, `@expo/vector-icons`, light/dark themes |

---

## `platformio.ini` explained

```ini
[env:esp32cam]
monitor_dtr = 0                 ; stop the serial monitor auto-resetting the board
monitor_rts = 0                 ;   (DTR/RTS toggling puts ESP32-CAM into bootloader)
monitor_speed = 115200          ; must match Serial.begin(115200)
monitor_filters = esp32_exception_decoder, direct
                                ; decodes crash backtraces into file:line
board_build.f_cpu = 240000000L  ; run the CPU at full 240 MHz
board_build.partitions = huge_app.csv
                                ; 3 MB app slot (no OTA) — TLS + web server
                                ;   + camera outgrow the default 1.2 MB
platform = espressif32
board = esp32cam                ; AI-Thinker ESP32-CAM board definition
framework = arduino

lib_deps =
    madhephaestus/ESP32Servo @ ^3.0.0
    bblanchon/ArduinoJson @ ^7.0.4
```

Two things worth knowing:

- **`ArduinoJson`** builds the heartbeat and the setup-mode API replies. The
  `/predict` result is still matched with `String::indexOf()`.
- **The `^` version ranges are not pinned.** PlatformIO may resolve a newer
  library or platform version on a fresh checkout than the one you originally
  built against, which can change behaviour without any code edit. If you want
  fully reproducible builds, pin exact versions
  (e.g. `madhephaestus/ESP32Servo @ 3.2.0`, `platform = espressif32@6.12.0`).

---

## Setup

### 1. Deploy the classifier server to Hugging Face

A free Hugging Face Space gives the server one fixed `https://` address, so the
bin and the phone can reach it from any network — no laptop, no IP addresses.

1. Create an account at <https://huggingface.co>, then **New → Space**.
   Name it e.g. `waste-classifier`, choose **Docker → Blank**, hardware
   **CPU basic (free)**, visibility **Public**.
2. Upload the contents of `backend/` to the Space. Either drag the files into
   **Files → Add file → Upload files** (at minimum `Dockerfile`, `README.md`,
   `.gitattributes`, `app/` and `webapp/`), or from a terminal:

   ```bash
   pip install -U huggingface_hub
   hf auth login                                   # paste a write token
   cd backend
   hf upload YOUR-USERNAME/waste-classifier . . --repo-type space
   ```
3. Wait for the Space to show **Running**, then open
   `https://YOUR-USERNAME-waste-classifier.hf.space/health` — it should say
   `healthy`. The web dashboard is at the root URL.

> The free tier sleeps after ~48 h without traffic. While the bin is powered
> its heartbeats keep it awake; after a long pause the first request takes
> ~30 s while the Space wakes up.

Running locally still works for development:

```bash
cd backend
.venv\Scripts\activate            # Windows
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

### 2. Configure and flash the firmware

```bash
cp include/config.h.example include/config.h
```

Set `DEFAULT_SERVER_URL` to your Space URL. Everything else can stay as is —
WiFi is set from the app. (`DEFAULT_WIFI_SSID/PASS` are optional first-boot
defaults.)

```bash
pio run --target upload      # compile + flash
```

Remember the `IO0`→`GND` jumper if you are not using the MB shield.

### 3. Install the app

Install the APK on an Android phone (Android 10+ for automatic hotspot
joining) — see [`mobile/README.md`](mobile/README.md) for building it. Set
`extra.defaultServerUrl` in `mobile/app.json` to your Space URL before
building, or enter it later under **Settings**.

### 4. Connect the bin to WiFi

1. In the app, tap **Set up my bin**.
2. Press the bin's **reset button twice, quickly** (within ~3 s). A brand-new
   bin, or one that can't join its saved network, does this by itself. The bin
   opens a hotspot called **`Bintelligence-XXXX`** (password `bintelligence`).
3. Tap **Find my bin** and allow Android to connect to it.
4. Pick your WiFi from the list the bin can see and type the password.
5. The bin saves it, restarts, joins the network and checks in with the
   server. The app shows **“Your bin is online!”** — usually in 20–40 s.

To move the bin to another network later, run the same wizard. If the bin is
still online, the app can switch it into setup mode for you (no reset needed).

No app handy? Join the `Bintelligence-XXXX` hotspot from any phone or laptop
and open <http://192.168.4.1/> for a simple setup form.

> The ESP32 only supports **2.4 GHz** WiFi, and networks that need a login
> page (hotels, some campus WiFi) won't work. Phone hotspots work well.

### 5. Watch it boot

```bash
pio device monitor
```

Expected output:

```
(Press reset again now to open the WiFi setup hotspot.)
--- Bintelligence: Final Assembly Booting ---
Firmware 2.0.0
Device ID: bin-a1b2c3
Resetting Servo to Center...
Connecting to 'HomeWiFi' ....
✅ WiFi connected!
My IP: 192.168.1.42
Wireless log: connect to 192.168.1.42 port 23
Using server: https://your-username-waste-classifier.hf.space
✅ Bintelligence Online!
```

The same log is visible in the app's **Logs** tab.

---

## Mobile app

| Tab | What it shows |
|---|---|
| **Home** | Online/offline status, WiFi + signal, today's wet/dry counts, the latest item with its photo, and quick actions (test tilt wet/dry, restart) |
| **History** | The last 50 sorted items with photos; tap one for the bounding box and probability bars |
| **Test** | Photograph any item (or pick one from the gallery) and classify it — like the web dashboard's tester |
| **Logs** | The bin's live serial log, from anywhere |
| **Settings** | Change WiFi, server URL, setup-hotspot password, forget the bin |

The app never talks to the bin directly except during WiFi setup. Everything
else goes through the server:

```
bin ──► POST /device/heartbeat  (every 15 s: status + new log lines)
bin ──► POST /predict           (X-Device-Id / X-Device-Key → saved as a sort event)
app ──► GET  /device/{id}/status | events | events/{n}/image | logs
app ──► POST /device/{id}/command   → returned to the bin in its next heartbeat
```

Each bin generates a random **pairing key** on first boot. The app learns it
during WiFi setup (over the bin's own password-protected hotspot), and the
server only answers requests that present it. Device state is kept in memory,
so history resets when the Space restarts.

---

## Server discovery (LAN servers only)

With an `https://` (cloud) server the bin simply uses that URL. If the saved
server is a plain `http://` LAN address, the older discovery logic applies,
because DHCP (especially on a phone hotspot) reassigns addresses:

1. **Probe the saved address** — instant when nothing moved.
2. **Sweep the local /24** for any host answering `/health` on port 8000.
3. **Retry every 30 s** in the background while no server is known.
4. **Re-discover after 3 consecutive POST failures**, in case the server moves.

---

## Wireless serial monitor

Once the bin is assembled, USB access is impractical. The firmware mirrors every
log line to **TCP port 23**, with a 1.6 KB history buffer replayed to each new
viewer so boot output is not missed.

```bash
python wireless_monitor.py                 # auto-discover the board
python wireless_monitor.py 192.168.1.42    # connect directly
```

Pure Python standard library — no PuTTY, and no need to enable the Windows
telnet client.

> The log server starts only *after* WiFi connects, so the handful of lines
> printed before `✅ WiFi connected!` are USB-only. The app's **Logs** tab
> works from any network, since log lines travel with the heartbeat.

---

## Tuning

All tunables are constants at the top of [`src/main.cpp`](src/main.cpp):

| Constant | Default | Meaning |
|---|---|---|
| `posCenter` | `90` | Tray resting angle |
| `posDry` / `posWet` | `25` / `155` | Tilt targets. Reduce toward `45`/`135` if the tray hits the housing |
| `TILT_HOLD_MS` | `1200` | Dwell at full tilt before shaking |
| `SHAKE_COUNT` / `SHAKE_DEG` | `2` / `12` | Shake to dislodge clinging waste |
| `IR_DEBOUNCE_MS` | `60` | Beam must stay blocked this long to count as a detection |
| `IR_CLEAR_MS` | `800` | Beam must stay clear this long before re-arming |
| `IR_CLEAR_TIMEOUT_MS` | `15000` | Warn if something stays stuck in the beam |
| `REDISCOVER_INTERVAL_MS` | `30000` | Background retry interval while no server is known (LAN servers) |
| `HEARTBEAT_INTERVAL_MS` | `15000` | How often the bin reports to the server / picks up app commands |
| `WIFI_CONNECT_TIMEOUT_MS` | `30000` | How long to try the saved WiFi before opening the setup hotspot |
| `SETUP_IDLE_TIMEOUT_MS` | `300000` | Close an unused setup hotspot and retry the saved WiFi |
| `WIFI_LOST_REBOOT_MS` | `120000` | Reboot if WiFi stays down this long while running |
| `DRD_WINDOW_MS` | `4000` | Window for the double reset that opens setup mode |
| `PROBE_TIMEOUT_MS` | `150` | Per-host timeout during a subnet scan (`config.h`) |

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Servo jerks / stutters | Under-powered or shared supply — give it its own regulated 5–6 V. Also ensure the LEDC timer reservation in `setup()` is present, so the servo and camera do not share timer 0 |
| Servo does not move at all | Check battery voltage **under load**, not at rest; a deeply discharged Li-ion reads fine idle and collapses when the servo starts |
| Nothing in the backend log | The ESP32 never sent a request. Check the serial/wireless log: no `🚨 Garbage Detected!` means the IR sensor is not pulling GPIO13 LOW |
| `❌ Server Error: -1` | Server unreachable — no internet on this WiFi, Space asleep/building, or (LAN) firewall / backend not running |
| App says **Waiting for your bin** | The bin hasn't sent a heartbeat to this server yet — check it's powered, and that the server URL in the app matches the one given to the bin |
| Setup: “the bin didn't come online” | Wrong password, 5 GHz-only network, weak signal, or a login-page network. The bin reopens its hotspot after ~30 s — run setup again |
| Setup hotspot never appears | Press reset twice faster (both presses within ~3 s), or wait: a bin that can't join its WiFi opens the hotspot after 30 s |
| Boots, connects to WiFi, but unreachable | Classic brownout. Works on USB, fails on battery ⇒ power problem, not software |
| Sorts in an endless loop | The tray is sitting in the IR beam at rest. Reposition the sensor to look across the opening rather than at the tray |
| `❌ Camera init failed!` | Usually insufficient power, or a loose camera ribbon |
| Everything classifies as one class | Model issue, not firmware — test the same image via the dashboard at <http://localhost:8000/> |

---

## Project layout

```
dustbin/
├── include/
│   ├── camera_pins.h        AI-Thinker OV2640 pin map
│   ├── config.h             First-boot defaults       (gitignored — secrets)
│   └── config.h.example     Template to copy
├── src/
│   └── main.cpp             All firmware logic
├── backend/                 Classifier server (FastAPI) — deploy to HF Spaces
│   └── app/devices.py       Heartbeats, sort history, logs, commands
├── mobile/                  Android app (Expo)
│   ├── src/app/             Screens (Expo Router)
│   └── modules/bin-wifi/    Native module that joins the setup hotspot
├── wireless_monitor.py      WiFi serial-log viewer (LAN)
├── platformio.ini           Board, framework and library config
└── README.md
```

---

## Security note

- WiFi credentials set from the app are stored in the ESP32's flash (NVS),
  not in the source. `include/config.h` may still hold optional first-boot
  credentials **in plaintext** and is therefore gitignored.
- The bin uses HTTPS but does **not verify the server certificate**
  (`setInsecure()`), which keeps the firmware simple. Pin the root CA with
  `g_tls.setCACert()` if that matters for your deployment.
- Anyone within WiFi range who knows the setup-hotspot password can read the
  bin's pairing key while it is in setup mode. Change `SETUP_AP_PASSWORD` in
  `config.h` (and in the app's Settings → Advanced) if that matters.

If `config.h` was ever committed with real credentials in it, they remain in the git history even after the file is removed — rotate
the WiFi password, or rewrite history with
[`git filter-repo`](https://github.com/newren/git-filter-repo).
