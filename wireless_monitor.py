"""
wireless_monitor.py — view the ESP32-CAM's serial log over WiFi.

The board mirrors every log line to TCP port 23 once WiFi is up, so it can be
monitored while sealed inside the bin with no USB/FTDI connection.

Usage:
    python wireless_monitor.py                 # auto-discover the board
    python wireless_monitor.py 192.168.210.39  # connect directly

Auto-discovery sweeps the local /24 for a host with port 23 open, which is how
you find the board again after DHCP moves it. Ctrl+C to quit.
"""

import concurrent.futures as cf
import socket
import sys

LOG_PORT = 23


def local_ip() -> str:
    """Best-effort local IP (no traffic is actually sent)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    finally:
        s.close()


def port_open(ip: str, port: int = LOG_PORT, timeout: float = 0.5) -> bool:
    # Use create_connection, not connect_ex: settimeout() makes the socket
    # non-blocking, so connect_ex returns EWOULDBLOCK rather than 0 for a
    # remote host that is still completing its handshake.
    try:
        with socket.create_connection((ip, port), timeout=timeout):
            return True
    except OSError:
        return False


def discover() -> str | None:
    """Scan the local /24 for a host listening on LOG_PORT."""
    me = local_ip()
    base = me.rsplit(".", 1)[0]
    print(f"Scanning {base}.0/24 for the ESP32 on port {LOG_PORT} ...")

    candidates = [f"{base}.{h}" for h in range(1, 255) if f"{base}.{h}" != me]
    with cf.ThreadPoolExecutor(max_workers=128) as pool:
        for ip, ok in zip(candidates, pool.map(port_open, candidates)):
            if ok:
                print(f"Found ESP32 at {ip}")
                return ip
    return None


def stream(ip: str) -> None:
    print(f"Connecting to {ip}:{LOG_PORT} ... (Ctrl+C to quit)\n")
    with socket.create_connection((ip, LOG_PORT), timeout=10) as s:
        s.settimeout(None)
        buf = b""
        while True:
            chunk = s.recv(4096)
            if not chunk:
                print("\n[connection closed by board]")
                return
            buf += chunk
            # Decode on line boundaries so multi-byte UTF-8 is never split.
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                print(line.decode("utf-8", errors="replace").rstrip("\r"))


def main() -> None:
    ip = sys.argv[1] if len(sys.argv) > 1 else discover()
    if not ip:
        print(
            "No board found. Check that it is powered, on the same WiFi, and has\n"
            "already printed '✅ WiFi connected!' (the log server starts after that)."
        )
        sys.exit(1)
    try:
        stream(ip)
    except KeyboardInterrupt:
        print("\nBye.")
    except OSError as e:
        print(f"Connection failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
