// Talks to the bin directly while the phone is on its setup hotspot
// ("Bintelligence-XXXX", always at 192.168.4.1). See runSetupMode() in
// src/main.cpp of the firmware.
import BinWifi from '../../modules/bin-wifi';

export const BIN_AP_PREFIX = 'Bintelligence-';
const BIN_URL = 'http://192.168.4.1';

export type BinInfo = {
  device_id: string;
  key: string;
  fw: string;
  mode: 'setup';
  ssid: string;
  server: string;
  last_error: '' | 'not_found' | 'failed';
};

export type NearbyNetwork = { ssid: string; rssi: number; secure: boolean };

async function binFetch<T>(path: string, init: RequestInit = {}, timeoutMs = 8000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(BIN_URL + path, { ...init, signal: ctrl.signal });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error ?? `Bin replied ${res.status}`);
    return body as T;
  } finally {
    clearTimeout(timer);
  }
}

export const canAutoJoin = () => !!BinWifi?.isSupported();

/** Shows Android's "connect to device" sheet for the bin's hotspot. */
export async function joinBinHotspot(apPassword: string) {
  if (!BinWifi) throw new Error('Automatic joining needs the installed app build.');
  await BinWifi.connectToPrefix(BIN_AP_PREFIX, apPassword);
}

/** For the manual path: route requests over WiFi even though it has no internet. */
export function bindToCurrentWifi() {
  BinWifi?.bindToCurrentWifi();
}

/** Leave the hotspot and send traffic over the phone's normal network again. */
export function leaveBinHotspot() {
  BinWifi?.release();
}

export const getBinInfo = () => binFetch<BinInfo>('/info', {}, 5000);

export async function scanNearby(refresh = false) {
  const list = await binFetch<NearbyNetwork[]>(refresh ? '/scan?refresh=1' : '/scan', {}, 15000);
  return [...list].sort((a, b) => b.rssi - a.rssi);
}

export function sendWifi(ssid: string, password: string, server: string) {
  return binFetch<{ ok: boolean; device_id: string }>('/provision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ssid, password, server }),
  });
}
