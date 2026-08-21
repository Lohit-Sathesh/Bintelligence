#include "esp_camera.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include <ESP32Servo.h>
#include "config.h"
#include "camera_pins.h"

// --- Hardware Pins ---
const int IR_PIN = 13;

// --- Wireless Serial Log ---
// Mirrors every log line to both USB serial and a TCP socket on port 23, so the
// board can be monitored over WiFi once it is sealed into the bin. A small ring
// buffer is replayed to each new client so boot output is not missed.
#define LOG_PORT 23
#define LOG_HISTORY 1600

class NetLog : public Print {
  WiFiServer _server{LOG_PORT};
  WiFiClient _client;
  char _hist[LOG_HISTORY];
  size_t _len = 0;

  void remember(const uint8_t *b, size_t n) {
    for (size_t i = 0; i < n; i++) {
      if (_len < LOG_HISTORY) {
        _hist[_len++] = (char)b[i];
      } else {                                  // drop oldest half, keep recent
        memmove(_hist, _hist + LOG_HISTORY / 2, LOG_HISTORY / 2);
        _len = LOG_HISTORY / 2;
        _hist[_len++] = (char)b[i];
      }
    }
  }

public:
  void begin(unsigned long baud) { Serial.begin(baud); }

  void startServer() {
    _server.begin();
    _server.setNoDelay(true);
  }

  // Accept a new viewer and replay recent history to them.
  void poll() {
    if (_server.hasClient()) {
      if (_client && _client.connected()) _client.stop();
      _client = _server.available();
      _client.setNoDelay(true);
      _client.write((const uint8_t *)_hist, _len);
      _client.print("\r\n--- live ---\r\n");
    }
  }

  size_t write(uint8_t c) override { return write(&c, 1); }

  size_t write(const uint8_t *b, size_t n) override {
    Serial.write(b, n);
    remember(b, n);
    if (_client && _client.connected()) _client.write(b, n);
    return n;
  }
};

NetLog Log;

// --- Servo Settings ---
Servo myServo;
const int posCenter = 90;
// Steep enough that waste actually slides off instead of resting on a shallow
// slope. Reduce toward 45/135 if the tray hits the housing at these angles —
// driving the servo into a hard stop makes it stall, buzz and draw heavy current.
const int posDry = 25;    // ~65 deg from centre
const int posWet = 155;   // ~65 deg from centre

const int TILT_HOLD_MS = 1200;   // dwell at full tilt before shaking
const int SHAKE_COUNT  = 2;      // shakes to dislodge sticky/damp waste
const int SHAKE_DEG    = 12;     // shake amplitude
const int SETTLE_MS    = 600;    // final dwell before returning to centre

// Tilts fully to `target`, shakes to shed clinging waste, then returns to
// centre. Shake always moves back toward centre so the tray never travels
// past its end stop.
void tiltAndDump(int target) {
  myServo.write(target);
  delay(TILT_HOLD_MS);

  const int shakeToward = (target < posCenter) ? SHAKE_DEG : -SHAKE_DEG;
  for (int i = 0; i < SHAKE_COUNT; i++) {
    myServo.write(target + shakeToward);
    delay(180);
    myServo.write(target);
    delay(180);
  }

  delay(SETTLE_MS);
  Log.println(">>> RETURNING TO CENTER");
  myServo.write(posCenter);
  delay(900);
}

// --- IR Sensor Gating ---
// The sensor is active-LOW. The tray sweeps through its field of view while
// sorting, so a plain level check re-triggers forever. Instead we debounce the
// detection and then refuse to re-arm until the beam has genuinely cleared.
const uint32_t IR_DEBOUNCE_MS      = 60;     // beam must stay blocked this long
const uint32_t IR_CLEAR_MS         = 800;    // ...and stay clear this long to re-arm
const uint32_t IR_CLEAR_TIMEOUT_MS = 15000;  // give up waiting (something is stuck)

inline bool irBlocked() { return digitalRead(IR_PIN) == LOW; }

// True only if the beam stays blocked for the whole debounce window, so a
// momentary glint or servo vibration cannot start a sort.
bool confirmedDetection() {
  if (!irBlocked()) return false;
  uint32_t start = millis();
  while (millis() - start < IR_DEBOUNCE_MS) {
    if (!irBlocked()) return false;
    delay(5);
  }
  return true;
}

// Blocks until the beam has been continuously clear for IR_CLEAR_MS.
// Returns false on timeout, meaning something is still sitting in the beam.
bool waitForClear() {
  uint32_t start = millis();
  uint32_t clearSince = 0;
  while (millis() - start < IR_CLEAR_TIMEOUT_MS) {
    if (irBlocked()) {
      clearSince = 0;            // still blocked, restart the clear timer
    } else {
      if (clearSince == 0) clearSince = millis();
      if (millis() - clearSince >= IR_CLEAR_MS) return true;
    }
    delay(10);
  }
  return false;
}

// --- Server Discovery ---
// Resolved at boot (and re-resolved after repeated failures) so the classifier
// server can move to a new IP without reflashing the board.
String g_predictUrl = "";
int g_failCount = 0;
const int MAX_FAILS_BEFORE_REDISCOVER = 3;

// Returns true if `ip` answers HEALTH_PATH with a healthy response.
bool probeHost(IPAddress ip) {
  WiFiClient client;
  if (!client.connect(ip, SERVER_PORT, PROBE_TIMEOUT_MS)) return false;

  client.print(String("GET ") + HEALTH_PATH + " HTTP/1.1\r\n" +
               "Host: " + ip.toString() + "\r\n" +
               "Connection: close\r\n\r\n");

  String resp = "";
  uint32_t start = millis();
  while (client.connected() && millis() - start < 700) {
    while (client.available()) resp += (char)client.read();
    if (resp.indexOf("healthy") != -1) break;
    delay(2);
  }
  client.stop();
  return resp.indexOf("healthy") != -1;
}

// Extracts the dotted-quad host out of the configured server_url, so the
// last-known address can be probed before falling back to a full scan.
bool lastKnownIP(IPAddress &out) {
  String u = String(server_url);
  int start = u.indexOf("//");
  if (start < 0) return false;
  start += 2;
  int end = u.indexOf(':', start);
  if (end < 0) end = u.indexOf('/', start);
  if (end < 0) end = u.length();
  return out.fromString(u.substring(start, end));
}

// Probes the last-known address, then sweeps the local /24 subnet.
// Returns a full predict URL, or "" if nothing was found.
String discoverServer() {
  IPAddress cached;
  if (lastKnownIP(cached)) {
    Log.printf("Probing last known server %s ... ", cached.toString().c_str());
    if (probeHost(cached)) {
      Log.println("found!");
      return String("http://") + cached.toString() + ":" + SERVER_PORT + PREDICT_PATH;
    }
    Log.println("no response.");
  }

  IPAddress self = WiFi.localIP();
  Log.printf("Scanning %d.%d.%d.0/24 for the classifier server ...\n",
                self[0], self[1], self[2]);

  for (int host = 1; host <= 254; host++) {
    if (host == self[3]) continue;   // skip ourselves
    IPAddress candidate(self[0], self[1], self[2], host);
    if (probeHost(candidate)) {
      Log.printf("\n Server found at %s\n", candidate.toString().c_str());
      return String("http://") + candidate.toString() + ":" + SERVER_PORT + PREDICT_PATH;
    }
    if (host % 32 == 0) Log.print(".");   // progress heartbeat
  }

  Log.println("\n No server found on this subnet.");
  return "";
}

void setup() {
  Log.begin(115200);
  delay(1000);
  Log.println("\n--- Bintelligence: Final Assembly Booting ---");

  // 1. Setup Pins
  pinMode(IR_PIN, INPUT);
  // Reserve LEDC timers 1-3 for the servo so it never shares timer 0,
  // which esp_camera_init() below claims for the XCLK signal — sharing
  // it corrupts the servo's PWM output and causes jerky movement.
  ESP32PWM::allocateTimer(1);
  ESP32PWM::allocateTimer(2);
  ESP32PWM::allocateTimer(3);
  myServo.setPeriodHertz(50);
  myServo.attach(SERVO_PIN, 500, 2400);
  
  // 2. Initial Reset
  Log.println("Resetting Servo to Center...");
  myServo.write(posCenter);
  delay(1000); 

  // 3. Initialize Camera
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size = FRAMESIZE_QVGA;
  config.jpeg_quality = 12;
  config.fb_count = 1;

  if (esp_camera_init(&config) != ESP_OK) {
    Log.println("❌ Camera init failed!");
    ESP.restart();
  }

  // 4. Connect WiFi
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Log.print(".");
  }
  Log.println("\n✅ WiFi connected!");
  Log.print("My IP: ");
  Log.println(WiFi.localIP());

  // 5. Start the wireless log server so the board can be monitored over WiFi
  Log.startServer();
  Log.print("Wireless log: connect to ");
  Log.print(WiFi.localIP());
  Log.printf(" port %d\n", LOG_PORT);

  // 6. Locate the classification server
  g_predictUrl = discoverServer();
  if (g_predictUrl.length()) {
    Log.println("Using server: " + g_predictUrl);
    Log.println("✅ Bintelligence Online!");
  } else {
    Log.println("⚠️  Server not found — retrying in the background.");
  }
}

void classifyAndSort() {
  // If the server was never found (or moved), try to (re)locate it first.
  if (g_predictUrl.length() == 0) {
    g_predictUrl = discoverServer();
    if (g_predictUrl.length() == 0) {
      Log.println("❌ Still no server reachable — skipping.");
      return;
    }
    Log.println("Using server: " + g_predictUrl);
  }

  camera_fb_t * fb = esp_camera_fb_get();
  if (!fb) return;

  HTTPClient http;
  http.begin(g_predictUrl);

  String boundary = "--------------------------" + String(millis(), HEX);
  http.addHeader("Content-Type", "multipart/form-data; boundary=" + boundary);

  String head = "--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"image.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n";
  String tail = "\r\n--" + boundary + "--\r\n";
  
  uint32_t totalLen = head.length() + fb->len + tail.length();
  uint8_t * buffer = (uint8_t *)malloc(totalLen);
  
  if (buffer) {
    memcpy(buffer, head.c_str(), head.length());
    memcpy(buffer + head.length(), fb->buf, fb->len);
    memcpy(buffer + head.length() + fb->len, tail.c_str(), tail.length());

    int httpResponseCode = http.POST(buffer, totalLen);

    if (httpResponseCode == 200) {
      g_failCount = 0;
      String response = http.getString();
      Log.println("Result: " + response);

      // --- CRITICAL MOVEMENT SEQUENCE ---
      if (response.indexOf("\"class\":\"dry\"") != -1) {
        Log.println(">>> TILTING RIGHT (DRY)");
        tiltAndDump(posDry);
      }
      else if (response.indexOf("\"class\":\"wet\"") != -1) {
        Log.println(">>> TILTING LEFT (WET)");
        tiltAndDump(posWet);
      }
      else {
        Log.println("⚠️  No class in response — staying centered.");
      }
    } 
    else {
      Log.printf("❌ Server Error: %d\n", httpResponseCode);
      // A moved server shows up as repeated connection failures. After a few,
      // drop the cached URL so the next detection triggers a fresh discovery.
      if (++g_failCount >= MAX_FAILS_BEFORE_REDISCOVER) {
        Log.println("Repeated failures — will re-discover the server.");
        g_predictUrl = "";
        g_failCount = 0;
      }
    }
    free(buffer);
  }

  http.end();
  esp_camera_fb_return(fb);
}

// How often to retry discovery while no server is known. Without this the board
// stays disconnected until a detection occurs, so powering the bin on before the
// laptop's server finishes starting would leave it idle indefinitely.
const uint32_t REDISCOVER_INTERVAL_MS = 30000;
uint32_t g_lastDiscoveryAttempt = 0;

void loop() {
  Log.poll();   // accept a wireless log viewer, replaying recent history

  // Background retry: self-heal whenever the server appears, whichever device
  // booted first, without needing a reset or a garbage detection.
  if (g_predictUrl.length() == 0 &&
      millis() - g_lastDiscoveryAttempt >= REDISCOVER_INTERVAL_MS) {
    g_lastDiscoveryAttempt = millis();
    Log.println("Retrying server discovery ...");
    g_predictUrl = discoverServer();
    if (g_predictUrl.length()) {
      Log.println("Using server: " + g_predictUrl);
      Log.println("✅ Bintelligence Online!");
    }
  }

  if (confirmedDetection()) {
    Log.println("🚨 Garbage Detected!");

    classifyAndSort();

    // Re-arm only once the beam is genuinely clear. This is what stops the
    // tray sweeping past the sensor from starting an endless sort loop.
    Log.println("Waiting for sensor to clear ...");
    if (waitForClear()) {
      Log.println("System ready.");
    } else {
      Log.println("⚠️  Sensor still blocked after 15s — check for waste stuck");
      Log.println("    on the tray, or reposition the sensor away from it.");
    }
  }
  delay(20);
}
