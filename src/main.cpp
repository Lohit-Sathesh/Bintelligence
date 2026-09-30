#include "esp_camera.h"
#include "esp_mac.h"
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <ESP32Servo.h>
#include "config.h"
#include "camera_pins.h"

#define FW_VERSION "2.0.0"

// --- Hardware Pins ---
const int IR_PIN = 13;

// --- Wireless Serial Log ---
// Mirrors every log line to both USB serial and a TCP socket on port 23, so the
// board can be monitored over WiFi once it is sealed into the bin. A small ring
// buffer is replayed to each new client so boot output is not missed.
// Lines are also queued for upload with the heartbeat, so the mobile app can
// show the log from anywhere.
#define LOG_PORT 23
#define LOG_HISTORY 1600
#define LOG_PENDING 2048

class NetLog : public Print {
  WiFiServer _server{LOG_PORT};
  WiFiClient _client;
  char _hist[LOG_HISTORY];
  size_t _len = 0;
  char _pend[LOG_PENDING];
  size_t _plen = 0;

  // Appends to a fixed buffer, dropping the oldest half when full.
  static void append(char *buf, size_t &len, size_t cap, const uint8_t *b, size_t n) {
    for (size_t i = 0; i < n; i++) {
      if (len >= cap) {
        memmove(buf, buf + cap / 2, cap / 2);
        len = cap / 2;
      }
      buf[len++] = (char)b[i];
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

  // Hands every complete queued line to `fn` and removes it from the upload
  // queue. An unfinished last line stays queued until its newline arrives.
  template <typename F> void drainLines(F fn) {
    size_t start = 0;
    for (size_t i = 0; i < _plen; i++) {
      if (_pend[i] != '\n') continue;
      size_t end = i;
      if (end > start && _pend[end - 1] == '\r') end--;
      if (end > start) fn(String(_pend + start, end - start));
      start = i + 1;
    }
    memmove(_pend, _pend + start, _plen - start);
    _plen -= start;
  }

  size_t write(uint8_t c) override { return write(&c, 1); }

  size_t write(const uint8_t *b, size_t n) override {
    Serial.write(b, n);
    append(_hist, _len, LOG_HISTORY, b, n);
    append(_pend, _plen, LOG_PENDING, b, n);
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

// --- Saved Settings ---
// WiFi credentials, server URL and the pairing key live in flash (NVS), so the
// phone app can change them without a reflash. config.h only supplies defaults.
Preferences prefs;
String g_ssid, g_pass;
String g_server;             // configured base URL, e.g. https://x.hf.space
String g_key;                // random per-bin secret shared with the app
String g_deviceId;           // "bin-a1b2c3", from the MAC address
String g_apName;             // "Bintelligence-B2C3"
bool   g_justProvisioned = false;

void loadSettings() {
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  char buf[24];
  snprintf(buf, sizeof(buf), "bin-%02x%02x%02x", mac[3], mac[4], mac[5]);
  g_deviceId = buf;
  snprintf(buf, sizeof(buf), "Bintelligence-%02X%02X", mac[4], mac[5]);
  g_apName = buf;

  // First boot after flashing: seed from config.h so the bin keeps working on
  // the network it used before, even before the app has been used.
  if (!prefs.isKey("ssid") && strlen(DEFAULT_WIFI_SSID) > 0) {
    prefs.putString("ssid", DEFAULT_WIFI_SSID);
    prefs.putString("pass", DEFAULT_WIFI_PASS);
  }
  g_ssid   = prefs.getString("ssid", "");
  g_pass   = prefs.getString("pass", "");
  g_server = prefs.getString("server", DEFAULT_SERVER_URL);
  g_justProvisioned = prefs.getBool("prov", false);

  g_key = prefs.getString("key", "");
  if (g_key.length() == 0) {
    for (int i = 0; i < 3; i++) {
      snprintf(buf, sizeof(buf), "%08x", esp_random());
      g_key += buf;
    }
    prefs.putString("key", g_key);
  }
}

// Accepts "https://host", "https://host/" or a pasted ".../predict" URL.
String normalizeServer(String url) {
  url.trim();
  if (url.endsWith("/predict")) url.remove(url.length() - 8);
  while (url.endsWith("/")) url.remove(url.length() - 1);
  return url;
}

// --- Double-Reset Detection ---
// GPIO0 is the camera clock, so there is no free button to request setup
// mode. Instead, pressing reset twice within DRD_WINDOW_MS opens the setup
// hotspot. A flag is set on boot and cleared once the window has passed.
const uint32_t DRD_WINDOW_MS = 4000;
bool g_drdArmed = false;

bool checkDoubleReset() {
  // Only count a real reset/power press — not a brownout from the servo or
  // our own ESP.restart(), which would otherwise look like a double press.
  esp_reset_reason_t r = esp_reset_reason();
  bool manual = (r == ESP_RST_POWERON || r == ESP_RST_EXT);
  bool hit = manual && prefs.getBool("drd", false);
  prefs.putBool("drd", !hit);
  g_drdArmed = !hit;
  if (g_drdArmed) Log.println("(Press reset again now to open the WiFi setup hotspot.)");
  return hit;
}

void serviceDoubleReset() {
  if (g_drdArmed && millis() > DRD_WINDOW_MS) {
    prefs.putBool("drd", false);
    g_drdArmed = false;
  }
}

void rebootNow() {
  prefs.putBool("drd", false);
  delay(200);
  ESP.restart();
}

// --- Setup Mode (WiFi provisioning hotspot) ---
// The bin opens its own WiFi network. The phone app (or any browser, via the
// page at "/") sends the home WiFi details, which are saved before a reboot.
const uint32_t WIFI_CONNECT_TIMEOUT_MS = 30000;
const uint32_t SETUP_IDLE_TIMEOUT_MS   = 5UL * 60 * 1000;  // then retry saved WiFi

WebServer web(80);
DNSServer dns;
String g_scanJson = "[]";
uint32_t g_rebootAt = 0;

void scanNetworks() {
  Log.println("Scanning for WiFi networks ...");
  int n = WiFi.scanNetworks();
  JsonDocument doc;
  JsonArray arr = doc.to<JsonArray>();
  for (int i = 0; i < n; i++) {
    String ssid = WiFi.SSID(i);
    if (ssid.length() == 0) continue;
    bool dup = false;
    for (JsonObject o : arr) {
      if (ssid == o["ssid"].as<const char *>()) {       // keep the strongest AP
        if (WiFi.RSSI(i) > o["rssi"].as<int>()) o["rssi"] = WiFi.RSSI(i);
        dup = true;
        break;
      }
    }
    if (dup) continue;
    JsonObject o = arr.add<JsonObject>();
    o["ssid"] = ssid;
    o["rssi"] = WiFi.RSSI(i);
    o["secure"] = WiFi.encryptionType(i) != WIFI_AUTH_OPEN;
  }
  WiFi.scanDelete();
  g_scanJson = "";
  serializeJson(doc, g_scanJson);
  Log.printf("Found %d networks.\n", arr.size());
}

String htmlEscape(String s) {
  s.replace("&", "&amp;");
  s.replace("<", "&lt;");
  s.replace(">", "&gt;");
  s.replace("\"", "&quot;");
  return s;
}

void sendJson(int code, JsonDocument &doc) {
  String out;
  serializeJson(doc, out);
  web.send(code, "application/json", out);
}

void handleInfo() {
  JsonDocument doc;
  doc["device_id"] = g_deviceId;
  doc["key"] = g_key;
  doc["fw"] = FW_VERSION;
  doc["mode"] = "setup";
  doc["ssid"] = g_ssid;
  doc["server"] = g_server;
  doc["last_error"] = prefs.getString("lasterr", "");
  sendJson(200, doc);
}

void handleScan() {
  if (web.hasArg("refresh")) scanNetworks();
  web.send(200, "application/json", g_scanJson);
}

void handleProvision() {
  String ssid, pass, server;
  if (web.hasArg("ssid")) {                        // HTML form post
    ssid = web.arg("ssid");
    pass = web.arg("password");
    server = web.arg("server");
  } else {                                         // JSON from the app
    JsonDocument in;
    if (deserializeJson(in, web.arg("plain"))) {
      web.send(400, "application/json", "{\"ok\":false,\"error\":\"Invalid JSON\"}");
      return;
    }
    ssid = in["ssid"] | "";
    pass = in["password"] | "";
    server = in["server"] | "";
  }
  ssid.trim();
  server = normalizeServer(server);

  const char *err = nullptr;
  if (ssid.length() == 0 || ssid.length() > 32) err = "WiFi name must be 1-32 characters";
  else if (pass.length() > 0 && (pass.length() < 8 || pass.length() > 63)) err = "Password must be 8-63 characters";
  else if (server.length() && !server.startsWith("http://") && !server.startsWith("https://"))
    err = "Server URL must start with http:// or https://";
  if (err) {
    JsonDocument out;
    out["ok"] = false;
    out["error"] = err;
    sendJson(400, out);
    return;
  }

  prefs.putString("ssid", ssid);
  prefs.putString("pass", pass);
  if (server.length()) prefs.putString("server", server);
  prefs.putBool("prov", true);
  prefs.remove("lasterr");
  Log.printf("Saved WiFi '%s' — rebooting to connect.\n", ssid.c_str());

  if (web.hasArg("ssid")) {
    web.send(200, "text/html",
             "<meta name=viewport content='width=device-width'><body style='font-family:sans-serif;padding:24px'>"
             "<h2>Saved!</h2><p>The bin is restarting and will join <b>" + htmlEscape(ssid) +
             "</b>. You can reconnect your phone to your normal WiFi now.</p>");
  } else {
    JsonDocument out;
    out["ok"] = true;
    out["device_id"] = g_deviceId;
    sendJson(200, out);
  }
  g_rebootAt = millis() + 1500;   // let the response reach the phone first
}

// Minimal no-app fallback, reachable at http://192.168.4.1/
void handleRoot() {
  JsonDocument nets;
  deserializeJson(nets, g_scanJson);
  String opts;
  for (JsonObject o : nets.as<JsonArray>()) {
    opts += "<option value=\"" + htmlEscape(o["ssid"].as<String>()) + "\">";
  }
  String page =
    "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
    "<title>Bintelligence setup</title><style>"
    "body{font-family:sans-serif;background:#f1f5f2;margin:0;padding:24px;color:#1b2b22}"
    "form{background:#fff;border-radius:16px;padding:20px;max-width:420px;margin:auto;box-shadow:0 4px 16px #0001}"
    "label{display:block;margin:14px 0 6px;font-weight:600}"
    "input{width:100%;box-sizing:border-box;padding:12px;border:1px solid #cdd8d0;border-radius:10px;font-size:16px}"
    "button{margin-top:20px;width:100%;padding:14px;border:0;border-radius:10px;background:#1f9d55;color:#fff;font-size:16px;font-weight:600}"
    "</style><form method=post action=/provision><h2>&#9851; " + g_apName + "</h2>"
    "<label>WiFi name</label><input name=ssid list=nets required value=\"" + htmlEscape(g_ssid) + "\"><datalist id=nets>" + opts + "</datalist>"
    "<label>Password</label><input name=password type=password>"
    "<label>Server URL</label><input name=server value=\"" + htmlEscape(g_server) + "\">"
    "<button>Save &amp; connect</button></form>";
  web.send(200, "text/html", page);
}

// Blocks while the setup hotspot is up. Reboots after a successful provision;
// returns after `idleTimeoutMs` without any request (0 = never) so a bin whose
// router was only briefly down goes back to trying its saved network.
void runSetupMode(uint32_t idleTimeoutMs) {
  Log.println("\n📶 SETUP MODE");
  WiFi.disconnect(true);
  WiFi.mode(WIFI_AP_STA);            // STA half is needed to scan
  delay(100);
  scanNetworks();
  WiFi.softAP(g_apName.c_str(), SETUP_AP_PASSWORD);
  delay(100);
  IPAddress ip = WiFi.softAPIP();
  Log.printf("Join WiFi '%s' (password '%s'), then use the app or open http://%s/\n",
             g_apName.c_str(), SETUP_AP_PASSWORD, ip.toString().c_str());

  dns.start(53, "*", ip);            // any hostname → us (captive portal)
  static bool routesAdded = false;   // setup mode can repeat; register once
  if (!routesAdded) {
    routesAdded = true;
    web.on("/", HTTP_GET, handleRoot);
    web.on("/info", HTTP_GET, handleInfo);
    web.on("/scan", HTTP_GET, handleScan);
    web.on("/provision", HTTP_POST, handleProvision);
    // Answer Android's connectivity check so it keeps using this network
    // instead of routing the app's requests over mobile data.
    web.on("/generate_204", HTTP_GET, [] { web.send(204); });
    web.on("/gen_204", HTTP_GET, [] { web.send(204); });
    web.onNotFound([] {
      web.sendHeader("Location", "http://192.168.4.1/");
      web.send(302);
    });
  }
  web.begin();

  uint32_t lastActivity = millis();
  uint32_t lastClients = 0;
  while (true) {
    dns.processNextRequest();
    web.handleClient();
    serviceDoubleReset();

    uint32_t clients = WiFi.softAPgetStationNum();
    if (clients != lastClients) {
      Log.printf("Setup hotspot: %u device(s) connected\n", clients);
      lastClients = clients;
    }
    if (clients > 0) lastActivity = millis();   // never time out mid-setup

    if (g_rebootAt && (int32_t)(millis() - g_rebootAt) >= 0) rebootNow();
    if (idleTimeoutMs && millis() - lastActivity > idleTimeoutMs) break;
    delay(5);
  }

  Log.println("Setup timed out — retrying saved WiFi.");
  web.stop();
  dns.stop();
  WiFi.softAPdisconnect(true);
}

bool connectWiFi() {
  Log.printf("Connecting to '%s' ", g_ssid.c_str());
  WiFi.mode(WIFI_STA);
  WiFi.setHostname(g_deviceId.c_str());
  WiFi.begin(g_ssid.c_str(), g_pass.c_str());
  uint32_t start = millis();
  wl_status_t st = WiFi.status();
  while (st != WL_CONNECTED && millis() - start < WIFI_CONNECT_TIMEOUT_MS) {
    delay(250);
    serviceDoubleReset();
    if ((millis() - start) % 2000 < 250) Log.print(".");
    st = WiFi.status();
  }
  if (st == WL_CONNECTED) {
    prefs.remove("lasterr");
    return true;
  }
  // Shown to the app next time it opens the setup hotspot.
  prefs.putString("lasterr", st == WL_NO_SSID_AVAIL ? "not_found" : "failed");
  Log.printf("\n❌ Could not join '%s' (%s)\n", g_ssid.c_str(),
             st == WL_NO_SSID_AVAIL ? "network not found" : "wrong password?");
  return false;
}

// --- Server Access ---
// g_base is the server actually in use. For an https:// (cloud) server it is
// simply g_server. For a plain http:// LAN server, it is found by probing the
// configured address and then sweeping the local /24, as before.
String g_base = "";
int g_failCount = 0;
const int MAX_FAILS_BEFORE_REDISCOVER = 3;

WiFiClientSecure g_tls;   // shared by all HTTPS calls — one TLS session in RAM
WiFiClient g_plain;

bool beginHttp(HTTPClient &http, const String &url) {
  http.setReuse(true);
  if (url.startsWith("https://")) return http.begin(g_tls, url);
  return http.begin(g_plain, url);
}

inline bool serverIsLan() { return g_server.startsWith("http://"); }

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

// Extracts the dotted-quad host out of the configured server URL, so the
// last-known address can be probed before falling back to a full scan.
bool lastKnownIP(IPAddress &out) {
  int start = g_server.indexOf("//");
  if (start < 0) return false;
  start += 2;
  int end = g_server.indexOf(':', start);
  if (end < 0) end = g_server.indexOf('/', start);
  if (end < 0) end = g_server.length();
  return out.fromString(g_server.substring(start, end));
}

String lanBase(IPAddress ip) {
  return String("http://") + ip.toString() + ":" + SERVER_PORT;
}

// Probes the last-known address, then sweeps the local /24 subnet.
// Returns a base URL, or "" if nothing was found.
String discoverServer() {
  if (!serverIsLan()) return g_server;

  IPAddress cached;
  if (lastKnownIP(cached)) {
    Log.printf("Probing last known server %s ... ", cached.toString().c_str());
    if (probeHost(cached)) {
      Log.println("found!");
      return lanBase(cached);
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
      return lanBase(candidate);
    }
    if (host % 32 == 0) Log.print(".");   // progress heartbeat
  }

  Log.println("\n No server found on this subnet.");
  return "";
}

// --- Status & Heartbeat ---
const char *g_state = "idle";   // idle | sorting | blocked
const uint32_t HEARTBEAT_INTERVAL_MS = 15000;
uint32_t g_lastHeartbeat = 0;
bool g_heartbeatOk = true;

void runCommand(const String &cmd) {
  Log.println("📱 App command: " + cmd);
  if (cmd == "tilt_wet") {
    Log.println(">>> TEST TILT LEFT (WET)");
    tiltAndDump(posWet);
  } else if (cmd == "tilt_dry") {
    Log.println(">>> TEST TILT RIGHT (DRY)");
    tiltAndDump(posDry);
  } else if (cmd == "restart") {
    rebootNow();
  } else if (cmd == "setup_mode") {
    prefs.putBool("setup", true);
    rebootNow();
  }
}

void sendHeartbeat() {
  if (g_base.length() == 0) return;

  JsonDocument doc;
  doc["device_id"] = g_deviceId;
  doc["fw"] = FW_VERSION;
  doc["ssid"] = WiFi.SSID();
  doc["rssi"] = WiFi.RSSI();
  doc["ip"] = WiFi.localIP().toString();
  doc["uptime_s"] = millis() / 1000;
  doc["free_heap"] = ESP.getFreeHeap();
  doc["state"] = g_state;
  doc["provisioned"] = g_justProvisioned;
  JsonArray logs = doc["logs"].to<JsonArray>();
  Log.drainLines([&](const String &line) { logs.add(line); });

  String body;
  serializeJson(doc, body);

  HTTPClient http;
  if (!beginHttp(http, g_base + "/device/heartbeat")) return;
  http.setConnectTimeout(8000);
  http.setTimeout(8000);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Key", g_key);
  int code = http.POST(body);
  String resp = code == 200 ? http.getString() : "";
  http.end();

  // Only log transitions, so a server outage doesn't flood the log.
  if (code != 200) {
    if (g_heartbeatOk) Log.printf("⚠️  Heartbeat failed (%d)\n", code);
    g_heartbeatOk = false;
    return;
  }
  if (!g_heartbeatOk) Log.println("Heartbeat restored.");
  g_heartbeatOk = true;

  if (g_justProvisioned) {
    g_justProvisioned = false;
    prefs.putBool("prov", false);
  }

  JsonDocument reply;
  if (deserializeJson(reply, resp)) return;
  for (JsonVariant c : reply["commands"].as<JsonArray>()) runCommand(c.as<String>());
}

void setup() {
  Log.begin(115200);
  prefs.begin("bin", false);
  bool forceSetup = checkDoubleReset();   // as early as possible after reset
  delay(1000);
  Log.println("\n--- Bintelligence: Final Assembly Booting ---");
  Log.println("Firmware " FW_VERSION);

  loadSettings();
  if (prefs.getBool("setup", false)) {        // requested from the app
    prefs.putBool("setup", false);
    forceSetup = true;
  }
  Log.println("Device ID: " + g_deviceId);

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
    rebootNow();
  }

  // 4. Connect WiFi — or open the setup hotspot if there is no saved network,
  //    it cannot be joined, or the user asked for setup (double reset / app).
  while (true) {
    if (forceSetup || g_ssid.length() == 0) {
      runSetupMode(g_ssid.length() ? SETUP_IDLE_TIMEOUT_MS : 0);
      forceSetup = false;
    }
    if (connectWiFi()) break;
    forceSetup = true;
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
  g_tls.setInsecure();   // no certificate pinning — see README
  g_base = discoverServer();
  if (g_base.length()) {
    Log.println("Using server: " + g_base);
    Log.println("✅ Bintelligence Online!");
    sendHeartbeat();
    g_lastHeartbeat = millis();
  } else {
    Log.println("⚠️  Server not found — retrying in the background.");
  }
}

void classifyAndSort() {
  // If the server was never found (or moved), try to (re)locate it first.
  if (g_base.length() == 0) {
    g_base = discoverServer();
    if (g_base.length() == 0) {
      Log.println("❌ Still no server reachable — skipping.");
      return;
    }
    Log.println("Using server: " + g_base);
  }

  // With a single frame buffer the driver hands back a frame captured when the
  // previous one was returned — possibly long before this item arrived.
  // Discard it so the photo shows what is on the tray now.
  camera_fb_t * fb = esp_camera_fb_get();
  if (fb) esp_camera_fb_return(fb);
  fb = esp_camera_fb_get();
  if (!fb) return;

  HTTPClient http;
  if (!beginHttp(http, g_base + PREDICT_PATH)) {
    esp_camera_fb_return(fb);
    return;
  }
  http.setConnectTimeout(10000);
  http.setTimeout(20000);   // a cloud server may take a while to respond

  String boundary = "--------------------------" + String(millis(), HEX);
  http.addHeader("Content-Type", "multipart/form-data; boundary=" + boundary);
  http.addHeader("X-Device-Id", g_deviceId);
  http.addHeader("X-Device-Key", g_key);

  String head = "--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"image.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n";
  String tail = "\r\n--" + boundary + "--\r\n";

  uint32_t totalLen = head.length() + fb->len + tail.length();
  uint8_t * buffer = (uint8_t *)malloc(totalLen);

  if (buffer) {
    memcpy(buffer, head.c_str(), head.length());
    memcpy(buffer + head.length(), fb->buf, fb->len);
    memcpy(buffer + head.length() + fb->len, tail.c_str(), tail.length());

    int httpResponseCode = http.POST(buffer, totalLen);
    // A reused HTTPS connection may have been closed by the server while
    // idle; the failed attempt drops it, so one retry reconnects cleanly.
    if (httpResponseCode < 0) {
      Log.printf("Retrying upload (%d) ...\n", httpResponseCode);
      httpResponseCode = http.POST(buffer, totalLen);
    }

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
      // A moved LAN server shows up as repeated connection failures. After a
      // few, drop the cached URL so the next detection triggers a fresh
      // discovery. A cloud URL never moves, so it is kept.
      if (++g_failCount >= MAX_FAILS_BEFORE_REDISCOVER && serverIsLan()) {
        Log.println("Repeated failures — will re-discover the server.");
        g_base = "";
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

// If WiFi stays down this long (router off, bin moved elsewhere), reboot so
// the boot sequence can fall back to the setup hotspot.
const uint32_t WIFI_LOST_REBOOT_MS = 2UL * 60 * 1000;
uint32_t g_wifiLostSince = 0;

void loop() {
  Log.poll();   // accept a wireless log viewer, replaying recent history
  serviceDoubleReset();

  if (WiFi.status() != WL_CONNECTED) {
    if (g_wifiLostSince == 0) {
      g_wifiLostSince = millis();
      Log.println("⚠️  WiFi lost — reconnecting ...");
    } else if (millis() - g_wifiLostSince > WIFI_LOST_REBOOT_MS) {
      Log.println("WiFi still down — rebooting.");
      rebootNow();
    }
    delay(100);
    return;
  }
  if (g_wifiLostSince) {
    Log.println("WiFi reconnected.");
    g_wifiLostSince = 0;
  }

  // Background retry: self-heal whenever the server appears, whichever device
  // booted first, without needing a reset or a garbage detection.
  if (g_base.length() == 0 &&
      millis() - g_lastDiscoveryAttempt >= REDISCOVER_INTERVAL_MS) {
    g_lastDiscoveryAttempt = millis();
    Log.println("Retrying server discovery ...");
    g_base = discoverServer();
    if (g_base.length()) {
      Log.println("Using server: " + g_base);
      Log.println("✅ Bintelligence Online!");
    }
  }

  if (millis() - g_lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
    g_lastHeartbeat = millis();
    sendHeartbeat();
  }

  if (confirmedDetection()) {
    Log.println("🚨 Garbage Detected!");
    g_state = "sorting";

    classifyAndSort();

    // Re-arm only once the beam is genuinely clear. This is what stops the
    // tray sweeping past the sensor from starting an endless sort loop.
    Log.println("Waiting for sensor to clear ...");
    if (waitForClear()) {
      Log.println("System ready.");
      g_state = "idle";
    } else {
      Log.println("⚠️  Sensor still blocked after 15s — check for waste stuck");
      Log.println("    on the tray, or reposition the sensor away from it.");
      g_state = "blocked";
    }
    // Report the new state straight away rather than up to 15 s later.
    g_lastHeartbeat = 0;
  }
  delay(20);
}
