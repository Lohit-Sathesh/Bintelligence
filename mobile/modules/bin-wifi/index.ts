import { requireOptionalNativeModule } from 'expo';

type BinWifiModule = {
  isSupported(): boolean;
  connectToPrefix(prefix: string, passphrase: string): Promise<boolean>;
  bindToCurrentWifi(): boolean;
  release(): void;
};

// null in Expo Go / on web — callers fall back to manual WiFi instructions.
export default requireOptionalNativeModule<BinWifiModule>('BinWifi');
