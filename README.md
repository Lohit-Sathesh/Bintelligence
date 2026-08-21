# Bintelligence — Smart Waste-Sorting Dustbin

An ESP32-CAM dustbin that photographs whatever is dropped in, sends the image to
a machine-learning server, and tilts a servo tray to drop the item into the
**wet** or **dry** compartment.

The firmware in this repo is only half the system — it depends on the
**garbage-sorter** FastAPI backend, which runs the classification model on a PC.

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
            │  WiFi (same LAN)
            ▼
   ┌───────────────────────────────────────────────────────────────┐
   │  LAPTOP — garbage-sorter (FastAPI + TFLite)                   │
   │                                                               │
   │   POST /predict ──► EfficientNetB0 ──► {"class":"wet"|"dry"}  │
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
| Networking | `WiFi.h`, `HTTPClient.h`, `WiFiServer` (wireless log) |
| Servo | [`madhephaestus/ESP32Servo`](https://github.com/madhephaestus/ESP32Servo) — LEDC-based PWM |
| Log viewer | `wireless_monitor.py` (Python 3 standard library only) |

**Backend (separate `garbage-sorter` repo)**

| Layer | Technology |
|---|---|
| API | FastAPI + Uvicorn |
| Inference | `ai-edge-litert` (TensorFlow Lite runtime) |
| Model | EfficientNetB0 transfer learning, binary sigmoid + 7×7 Grad-CAM heatmap |
| Training | TensorFlow / Keras, Kaggle waste datasets |
| Frontend | Vanilla HTML/CSS/JS dashboard (upload · URL · webcam) |

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
platform = espressif32
board = esp32cam                ; AI-Thinker ESP32-CAM board definition
framework = arduino

lib_deps =
    madhephaestus/ESP32Servo @ ^3.0.0
    bblanchon/ArduinoJson @ ^7.0.4
```

Two things worth knowing:

- **`ArduinoJson` is declared but not currently used.** The firmware parses the
  response with plain `String::indexOf()` rather than a JSON parser. It is
  harmless to leave, and useful if you later want proper parsing.
- **The `^` version ranges are not pinned.** PlatformIO may resolve a newer
  library or platform version on a fresh checkout than the one you originally
  built against, which can change behaviour without any code edit. If you want
  fully reproducible builds, pin exact versions
  (e.g. `madhephaestus/ESP32Servo @ 3.2.0`, `platform = espressif32@6.12.0`).

---

## Setup

### 1. Start the backend

The firmware is useless without it — every classification is an HTTP call.

```bash
cd path/to/garbage-sorter
.venv\Scripts\activate            # Windows
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Wait for `Application startup complete`. Verify at <http://localhost:8000/> —
there is a dashboard for testing images without any hardware.

`--host 0.0.0.0` matters: binding to `127.0.0.1` would make the server
unreachable from the ESP32.

### 2. Configure the firmware

```bash
cp include/config.h.example include/config.h
```

Then edit `include/config.h`:

```c
const char* ssid     = "YOUR_WIFI_SSID";
const char* password = "YOUR_WIFI_PASSWORD";
const char* server_url = "http://<your-PC-IP>:8000/predict";
```

Find your PC's IP with `ipconfig` (Windows) or `ip addr` (Linux). The ESP32 and
the PC **must be on the same WiFi network**.

The IP only needs to be roughly right — it is treated as a *hint*. If it is
stale, the firmware falls back to scanning the subnet (see below).

### 3. Build and flash

```bash
pio run                      # compile
pio run --target upload      # compile + flash
```

Or use the PlatformIO toolbar buttons in VS Code. Remember the `IO0`→`GND`
jumper if you are not using the MB shield.

### 4. Watch it boot

```bash
pio device monitor
```

Expected output:

```
--- Bintelligence: Final Assembly Booting ---
Resetting Servo to Center...
.....
✅ WiFi connected!
My IP: 192.168.1.42
Wireless log: connect to 192.168.1.42 port 23
Probing last known server 192.168.1.100 ... found!
Using server: http://192.168.1.100:8000/predict
✅ Bintelligence Online!
```

---

## Server auto-discovery

Because DHCP (especially on a phone hotspot) reassigns addresses, the firmware
does **not** rely on the hardcoded IP:

1. **Probe the last-known IP** from `config.h` — instant when nothing moved.
2. **Sweep the local /24** for any host answering `/health` on port 8000 —
   takes a few seconds, and finds the server at its new address.
3. **Retry every 30 s** in the background while no server is known, so it
   self-heals if the bin is powered on before the laptop's server finishes
   starting.
4. **Re-discover after 3 consecutive POST failures**, in case the server moves
   while running.

This means an IP change no longer requires reflashing.

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
> printed before `✅ WiFi connected!` are USB-only.

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
| `REDISCOVER_INTERVAL_MS` | `30000` | Background retry interval while no server is known |
| `PROBE_TIMEOUT_MS` | `150` | Per-host timeout during a subnet scan (`config.h`) |

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Servo jerks / stutters | Under-powered or shared supply — give it its own regulated 5–6 V. Also ensure the LEDC timer reservation in `setup()` is present, so the servo and camera do not share timer 0 |
| Servo does not move at all | Check battery voltage **under load**, not at rest; a deeply discharged Li-ion reads fine idle and collapses when the servo starts |
| Nothing in the backend log | The ESP32 never sent a request. Check the serial/wireless log: no `🚨 Garbage Detected!` means the IR sensor is not pulling GPIO13 LOW |
| `❌ Server Error: -1` | Server unreachable — wrong network, firewall, or backend not running |
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
│   ├── config.h             WiFi + server settings   (gitignored — secrets)
│   └── config.h.example     Template to copy
├── src/
│   └── main.cpp             All firmware logic
├── wireless_monitor.py      WiFi serial-log viewer
├── platformio.ini           Board, framework and library config
└── README.md
```

---

## Security note

`include/config.h` stores the WiFi SSID and password **in plaintext** and is
therefore gitignored. If this project was ever committed with real credentials
in it, they remain in the git history even after the file is removed — rotate
the WiFi password, or rewrite history with
[`git filter-repo`](https://github.com/newren/git-filter-repo).
