export function timeAgo(epochSeconds: number, now = Date.now() / 1000) {
  const d = Math.max(0, Math.round(now - epochSeconds));
  if (d < 10) return 'just now';
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return `${Math.floor(d / 86400)} d ago`;
}

export function duration(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

export function clockTime(epochSeconds: number) {
  return new Date(epochSeconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** 0–4 bars from a WiFi RSSI in dBm. */
export function signalBars(rssi: number | undefined) {
  if (rssi == null || rssi === 0) return 0;
  if (rssi >= -55) return 4;
  if (rssi >= -65) return 3;
  if (rssi >= -75) return 2;
  return 1;
}

export function signalLabel(rssi: number | undefined) {
  return ['No signal', 'Weak', 'Fair', 'Good', 'Excellent'][signalBars(rssi)];
}

export const className = (c: string | null | undefined) =>
  c === 'wet' ? 'Wet waste' : c === 'dry' ? 'Dry waste' : 'Unknown';
