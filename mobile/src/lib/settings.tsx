import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';

export const DEFAULT_SERVER: string =
  (Constants.expoConfig?.extra?.defaultServerUrl as string | undefined) ?? '';
export const DEFAULT_AP_PASSWORD = 'bintelligence';

export type Settings = {
  serverUrl: string;
  deviceId: string | null;   // e.g. "bin-a1b2c3", learned during WiFi setup
  deviceKey: string | null;  // the bin's pairing key, learned during WiFi setup
  apPassword: string;        // setup hotspot password (SETUP_AP_PASSWORD)
};

const DEFAULTS: Settings = {
  serverUrl: DEFAULT_SERVER,
  deviceId: null,
  deviceKey: null,
  apPassword: DEFAULT_AP_PASSWORD,
};

const STORAGE_KEY = 'bintelligence.settings.v1';

type Ctx = {
  settings: Settings;
  ready: boolean;
  update: (patch: Partial<Settings>) => Promise<void>;
};

const SettingsContext = createContext<Ctx | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [ready, setReady] = useState(false);
  const current = useRef(DEFAULTS);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (!raw) return;
        current.current = { ...DEFAULTS, ...JSON.parse(raw) };
        setSettings(current.current);
      })
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);

  const update = useCallback(async (patch: Partial<Settings>) => {
    current.current = { ...current.current, ...patch };
    setSettings(current.current);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(current.current));
  }, []);

  return (
    <SettingsContext.Provider value={{ settings, ready, update }}>{children}</SettingsContext.Provider>
  );
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used inside SettingsProvider');
  return ctx;
}

export function isPaired(s: Settings) {
  return !!(s.deviceId && s.deviceKey);
}

export function normalizeServer(url: string) {
  let u = url.trim();
  if (u.endsWith('/predict')) u = u.slice(0, -'/predict'.length);
  return u.replace(/\/+$/, '');
}
