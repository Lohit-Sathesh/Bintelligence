"""
devices.py — live telemetry for Bintelligence dustbins, used by the mobile app.

The bin (ESP32-CAM) talks to this server over the internet, so neither it nor
the phone needs to know anyone's local IP address:

  bin   → POST /device/heartbeat            status + new log lines, every ~15 s
  bin   → POST /predict (X-Device-Id/Key)   each sort is recorded as an event
  app   → GET  /device/{id}/status|events|logs
  app   → POST /device/{id}/command         delivered in the next heartbeat reply

Access control is a per-bin random key (trust on first use): the first
heartbeat binds device_id → key, and every later request must present the same
key in X-Device-Key. The bin generates its key once and hands it to the app
during WiFi setup, over the bin's own password-protected hotspot.

State is in memory only. On a free Hugging Face Space it resets whenever the
Space restarts; the bin re-registers on its next heartbeat.
"""

import itertools
import threading
import time
from collections import deque

from fastapi import APIRouter, Header, HTTPException, Query, Response
from pydantic import BaseModel, Field

router = APIRouter(prefix="/device", tags=["device"])

ONLINE_WINDOW_S = 45        # seen within this long → "online"
MAX_EVENTS = 50             # recent sorts kept with their photo
MAX_TALLY = 5000            # (timestamp, class) pairs kept for day counts
MAX_LOG_LINES = 300
VALID_COMMANDS = {"tilt_wet", "tilt_dry", "restart", "setup_mode"}


class _Device:
    def __init__(self, device_id: str, key: str) -> None:
        self.id = device_id
        self.key = key
        self.status: dict = {}
        self.last_seen = 0.0
        self.events: deque[dict] = deque(maxlen=MAX_EVENTS)
        self.images: dict[int, bytes] = {}
        self.tally: deque[tuple[float, str]] = deque(maxlen=MAX_TALLY)
        self.logs: deque[dict] = deque(maxlen=MAX_LOG_LINES)
        self.log_seq = 0
        self.commands: list[str] = []


_devices: dict[str, _Device] = {}
_lock = threading.Lock()
_event_ids = itertools.count(1)


def _authorize(device_id: str, key: str | None) -> _Device:
    """Return the device if `key` matches. Caller must hold _lock."""
    dev = _devices.get(device_id)
    if dev is None:
        raise HTTPException(status_code=404, detail="Unknown device — has it sent a heartbeat yet?")
    if not key or key != dev.key:
        raise HTTPException(status_code=403, detail="Wrong device key.")
    return dev


# ---------------------------------------------------------------------------
# Bin → server
# ---------------------------------------------------------------------------

class Heartbeat(BaseModel):
    device_id: str = Field(min_length=1, max_length=40)
    fw: str = ""
    ssid: str = ""
    rssi: int = 0
    ip: str = ""
    uptime_s: int = 0
    free_heap: int = 0
    state: str = "idle"
    # True on the first heartbeat after WiFi setup; lets a re-flashed bin with
    # a fresh key re-claim its ID without waiting for the server to restart.
    provisioned: bool = False
    logs: list[str] = []


@router.post("/heartbeat")
async def heartbeat(hb: Heartbeat, x_device_key: str | None = Header(None)):
    if not x_device_key:
        raise HTTPException(status_code=400, detail="X-Device-Key header required.")
    now = time.time()
    with _lock:
        dev = _devices.get(hb.device_id)
        if dev is None:
            dev = _devices[hb.device_id] = _Device(hb.device_id, x_device_key)
        elif dev.key != x_device_key:
            if not hb.provisioned:
                raise HTTPException(status_code=403, detail="Wrong device key.")
            dev.key = x_device_key

        dev.last_seen = now
        dev.status = hb.model_dump(exclude={"logs", "device_id", "provisioned"})
        for line in hb.logs[-MAX_LOG_LINES:]:
            dev.log_seq += 1
            dev.logs.append({"seq": dev.log_seq, "t": now, "text": line[:300]})

        commands, dev.commands = dev.commands, []
    return {"commands": commands}


def record_event(device_id: str, key: str | None, result: dict, image: bytes) -> None:
    """Called from /predict when the request came from a bin. Never raises —
    a telemetry problem must not break the classification the bin is waiting on."""
    with _lock:
        dev = _devices.get(device_id)
        if dev is None and key:
            # Sort arrived before the first heartbeat (e.g. right after a
            # Space restart) — register the bin now rather than drop it.
            dev = _devices[device_id] = _Device(device_id, key)
        if dev is None or key != dev.key:
            return
        eid = next(_event_ids)
        now = time.time()
        dev.events.appendleft({
            "id": eid,
            "t": now,
            "class": result.get("class"),
            "confidence": result.get("confidence"),
            "probabilities": result.get("probabilities"),
            "bbox": result.get("bbox"),
        })
        dev.images[eid] = image
        live = {e["id"] for e in dev.events}
        for old in [i for i in dev.images if i not in live]:
            del dev.images[old]
        dev.tally.append((now, result.get("class")))


# ---------------------------------------------------------------------------
# App → server
# ---------------------------------------------------------------------------

@router.get("/{device_id}/status")
async def status(
    device_id: str,
    tz: int = Query(0, description="Client UTC offset in minutes, for 'today' counts"),
    x_device_key: str | None = Header(None),
):
    now = time.time()
    with _lock:
        dev = _authorize(device_id, x_device_key)
        # Local midnight for the caller, expressed in UTC epoch seconds.
        local_now = now + tz * 60
        midnight = local_now - (local_now % 86400) - tz * 60
        today = {"wet": 0, "dry": 0}
        total = {"wet": 0, "dry": 0}
        for t, cls in dev.tally:
            if cls in total:
                total[cls] += 1
                if t >= midnight:
                    today[cls] += 1
        return {
            "device_id": dev.id,
            "online": now - dev.last_seen <= ONLINE_WINDOW_S,
            "last_seen": dev.last_seen,
            "server_time": now,
            **dev.status,
            "today": today,
            "total": total,
        }


@router.get("/{device_id}/events")
async def events(
    device_id: str,
    limit: int = Query(20, ge=1, le=MAX_EVENTS),
    x_device_key: str | None = Header(None),
):
    with _lock:
        dev = _authorize(device_id, x_device_key)
        return {"events": list(dev.events)[:limit]}


@router.get("/{device_id}/events/{event_id}/image")
async def event_image(
    device_id: str,
    event_id: int,
    key: str | None = Query(None, description="Alternative to X-Device-Key, for <img> tags"),
    x_device_key: str | None = Header(None),
):
    with _lock:
        dev = _authorize(device_id, x_device_key or key)
        img = dev.images.get(event_id)
    if img is None:
        raise HTTPException(status_code=404, detail="Image no longer stored.")
    return Response(content=img, media_type="image/jpeg",
                    headers={"Cache-Control": "private, max-age=86400"})


@router.get("/{device_id}/logs")
async def logs(
    device_id: str,
    after: int = Query(0, ge=0),
    x_device_key: str | None = Header(None),
):
    with _lock:
        dev = _authorize(device_id, x_device_key)
        lines = [l for l in dev.logs if l["seq"] > after]
        return {"lines": lines, "next": dev.log_seq}


class Command(BaseModel):
    cmd: str


@router.post("/{device_id}/command")
async def command(device_id: str, body: Command, x_device_key: str | None = Header(None)):
    if body.cmd not in VALID_COMMANDS:
        raise HTTPException(status_code=400, detail=f"Unknown command. Use one of {sorted(VALID_COMMANDS)}.")
    with _lock:
        dev = _authorize(device_id, x_device_key)
        if body.cmd not in dev.commands:
            dev.commands.append(body.cmd)
    return {"queued": body.cmd}
