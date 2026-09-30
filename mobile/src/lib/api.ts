// Client for the classifier server (the Hugging Face Space). The bin reports
// to the same server, so the app never needs the bin's local IP address.
import { DEFAULT_SERVER, normalizeServer, Settings } from './settings';

export type WasteClass = 'wet' | 'dry';

export type BBox = { x: number; y: number; w: number; h: number };

export type Prediction = {
  class: WasteClass;
  confidence: number;
  probabilities: { wet: number; dry: number };
  bbox: BBox | null;
};

export type DeviceStatus = {
  device_id: string;
  online: boolean;
  last_seen: number;
  server_time: number;
  fw?: string;
  ssid?: string;
  rssi?: number;
  ip?: string;
  uptime_s?: number;
  free_heap?: number;
  state?: 'idle' | 'sorting' | 'blocked' | string;
  today: { wet: number; dry: number };
  total: { wet: number; dry: number };
};

export type SortEvent = Prediction & { id: number; t: number };

export type LogLine = { seq: number; t: number; text: string };

export type Command = 'tilt_wet' | 'tilt_dry' | 'restart' | 'setup_mode';

export class ApiError extends Error {
  constructor(message: string, public status = 0) {
    super(message);
  }
}

export function serverBase(s: Settings) {
  return normalizeServer(s.serverUrl || DEFAULT_SERVER);
}

/** False while the server URL is still the placeholder from app.json. */
export function serverConfigured(s: Settings) {
  const base = serverBase(s);
  return /^https?:\/\/./.test(base) && !base.includes('YOUR-USERNAME');
}

async function request<T>(url: string, init: RequestInit = {}, timeoutMs = 15000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: ctrl.signal });
  } catch {
    throw new ApiError("Can't reach the server. Check your internet connection.");
  } finally {
    clearTimeout(timer);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = typeof body?.detail === 'string' ? body.detail : `Server error ${res.status}`;
    throw new ApiError(detail, res.status);
  }
  return body as T;
}

function deviceUrl(s: Settings, path: string) {
  if (!s.deviceId || !s.deviceKey) throw new ApiError('No bin linked yet.');
  return `${serverBase(s)}/device/${encodeURIComponent(s.deviceId)}${path}`;
}

function keyHeader(s: Settings) {
  return { 'X-Device-Key': s.deviceKey ?? '' };
}

export function getStatus(s: Settings) {
  const tz = -new Date().getTimezoneOffset();
  return request<DeviceStatus>(deviceUrl(s, `/status?tz=${tz}`), { headers: keyHeader(s) });
}

export async function getEvents(s: Settings, limit = 50) {
  const r = await request<{ events: SortEvent[] }>(deviceUrl(s, `/events?limit=${limit}`), {
    headers: keyHeader(s),
  });
  return r.events;
}

export function eventImageUrl(s: Settings, id: number) {
  return deviceUrl(s, `/events/${id}/image?key=${encodeURIComponent(s.deviceKey ?? '')}`);
}

export function getLogs(s: Settings, after: number) {
  return request<{ lines: LogLine[]; next: number }>(deviceUrl(s, `/logs?after=${after}`), {
    headers: keyHeader(s),
  });
}

export function sendCommand(s: Settings, cmd: Command) {
  return request<{ queued: string }>(deviceUrl(s, '/command'), {
    method: 'POST',
    headers: { ...keyHeader(s), 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd }),
  });
}

export function checkHealth(base: string) {
  return request<{ status: string }>(`${normalizeServer(base)}/health`, {}, 60000);
}

// Classify a photo from the phone (the web dashboard's "Classifier Tester").
// A free Space that has been asleep can take ~30 s to wake, hence the timeout.
export function classifyPhoto(s: Settings, uri: string, mimeType = 'image/jpeg') {
  const form = new FormData();
  form.append('file', { uri, name: 'photo.jpg', type: mimeType } as unknown as Blob);
  return request<Prediction>(`${serverBase(s)}/predict`, { method: 'POST', body: form }, 60000);
}
