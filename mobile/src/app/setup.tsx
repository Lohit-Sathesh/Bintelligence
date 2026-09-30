import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { ReactNode, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, Text, TextInput, View } from 'react-native';

import { Banner, Button, Card, Divider, IconName, IconTile, Row, Screen, SignalBars, textStyles } from '../components/ui';
import { getStatus, sendCommand, serverBase, serverConfigured } from '../lib/api';
import {
  BIN_AP_PREFIX,
  BinInfo,
  canAutoJoin,
  getBinInfo,
  joinBinHotspot,
  leaveBinHotspot,
  NearbyNetwork,
  scanNearby,
  sendWifi,
  bindToCurrentWifi,
} from '../lib/provision';
import { isPaired, Settings, useSettings } from '../lib/settings';
import { radius, space, useTheme } from '../lib/theme';

type Step = 'intro' | 'join' | 'manual' | 'networks' | 'sending' | 'waiting' | 'done' | 'failed';

const WAIT_LIMIT_S = 90;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function SetupScreen() {
  const t = useTheme();
  const tx = textStyles(t);
  const { settings, update } = useSettings();

  const [step, setStep] = useState<Step>('intro');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<BinInfo | null>(null);
  const [networks, setNetworks] = useState<NearbyNetwork[]>([]);
  const [scanning, setScanning] = useState(false);
  const [ssid, setSsid] = useState('');
  const [password, setPassword] = useState('');
  const [remote, setRemote] = useState<'unknown' | 'online' | 'sent'>('unknown');
  const [elapsed, setElapsed] = useState(0);
  const target = useRef<{ creds: Settings; ssid: string; sentAt: number } | null>(null);

  // Never leave the app bound to the hotspot after this screen closes.
  useEffect(() => () => leaveBinHotspot(), []);

  // A linked bin that is online can be switched to setup mode remotely.
  useEffect(() => {
    if (!isPaired(settings)) return;
    getStatus(settings)
      .then((s) => s.online && setRemote((r) => (r === 'unknown' ? 'online' : r)))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startJoin() {
    setError(null);
    if (!canAutoJoin()) {
      setStep('manual');
      return;
    }
    setStep('join');
    try {
      await joinBinHotspot(settings.apPassword);
      await loadBin();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep('manual');
    }
  }

  async function manualConnected() {
    setError(null);
    bindToCurrentWifi();
    setStep('join');
    try {
      await loadBin();
    } catch {
      setError(`Can't find the bin. Make sure your phone is connected to "${BIN_AP_PREFIX}…".`);
      setStep('manual');
    }
  }

  // The hotspot can take a moment to route traffic after joining — retry.
  async function loadBin() {
    let bin: BinInfo | null = null;
    for (let i = 0; i < 6 && !bin; i++) {
      try {
        bin = await getBinInfo();
      } catch {
        await sleep(1000);
      }
    }
    if (!bin) throw new Error("Joined the hotspot, but the bin didn't answer.");
    setInfo(bin);
    setSsid(bin.ssid);
    await rescan(false);
    setStep('networks');
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
  }

  async function rescan(refresh = true) {
    setScanning(true);
    try {
      setNetworks(await scanNearby(refresh));
    } catch {
      setError("Couldn't get the list of networks from the bin.");
    } finally {
      setScanning(false);
    }
  }

  async function send() {
    if (!info) return;
    setError(null);
    setStep('sending');
    try {
      await sendWifi(ssid.trim(), password, serverBase(settings));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the WiFi details.');
      setStep('networks');
      return;
    }
    const creds = { ...settings, deviceId: info.device_id, deviceKey: info.key };
    await update({ deviceId: info.device_id, deviceKey: info.key });
    leaveBinHotspot();
    target.current = { creds, ssid: ssid.trim(), sentAt: Date.now() };
    setElapsed(0);
    setStep('waiting');
  }

  // After the bin reboots it should check in with the server from the new
  // network. A low uptime proves this is the fresh boot, not a stale record.
  useEffect(() => {
    if (step !== 'waiting' || !target.current) return;
    const { creds, ssid: want, sentAt } = target.current;
    let stopped = false;
    const tick = async () => {
      const secs = (Date.now() - sentAt) / 1000;
      setElapsed(secs);
      if (secs > WAIT_LIMIT_S) {
        setStep('failed');
        return;
      }
      try {
        const s = await getStatus(creds);
        if (!stopped && s.online && s.ssid === want && (s.uptime_s ?? Infinity) < secs + 30) {
          setStep('done');
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        }
      } catch {
        // Phone is still switching networks, or the bin hasn't checked in yet.
      }
    };
    const id = setInterval(tick, 3000);
    tick();
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [step]);

  async function remoteSetup() {
    try {
      await sendCommand(settings, 'setup_mode');
      setRemote('sent');
      startJoin();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach the bin.');
    }
  }

  const stepIndex = { intro: 0, join: 1, manual: 1, networks: 2, sending: 2, waiting: 3, done: 3, failed: 3 }[step];

  return (
    <Screen
      title="WiFi setup"
      right={
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityLabel="Close">
          <Ionicons name="close-circle" size={34} color={t.faint} />
        </Pressable>
      }
    >
      <Progress index={stepIndex} labels={['Prepare', 'Connect', 'Choose WiFi', 'Done']} />
      {error ? <Banner tone="error" icon="alert-circle-outline" text={error} /> : null}

      {step === 'intro' ? (
        <>
          <Hero icon="wifi" title="Connect your bin to WiFi" body="Your phone will talk to the bin directly for a moment to hand over the WiFi name and password." />
          <Card style={{ gap: space.lg }}>
            <Numbered n={1} title="Put the bin in setup mode">
              {remote === 'online' ? (
                <Button title="Do it from here" icon="radio-outline" variant="secondary" compact onPress={remoteSetup} />
              ) : null}
              <Text style={tx.sub}>
                {remote === 'online' ? 'Or press ' : 'Press '}the bin’s <Text style={{ fontWeight: '700', color: t.text }}>reset button twice</Text>, quickly.
                A new bin, or one that can’t find its WiFi, opens setup mode by itself.
              </Text>
            </Numbered>
            <Divider />
            <Numbered n={2} title="Find the bin">
              <Text style={tx.sub}>Your phone will ask to connect to “{BIN_AP_PREFIX}XXXX”. Tap it and allow.</Text>
            </Numbered>
          </Card>
          {serverConfigured(settings) ? (
            <Button title="Find my bin" icon="search" onPress={startJoin} />
          ) : (
            <>
              <Banner tone="error" icon="cloud-offline-outline" text="Set your classifier server URL first, so the bin knows where to send photos." />
              <Button title="Open Settings" icon="settings-outline" onPress={() => router.replace('/settings')} />
            </>
          )}
        </>
      ) : null}

      {step === 'join' ? (
        <Working
          title={remote === 'sent' ? 'Waiting for the bin to restart…' : 'Looking for your bin…'}
          body={`Choose “${BIN_AP_PREFIX}…” when Android asks. This can take up to 30 seconds.`}
        />
      ) : null}

      {step === 'manual' ? (
        <>
          <Card style={{ gap: space.lg }}>
            <Text style={tx.h2}>Connect by hand</Text>
            <Numbered n={1} title="Open your phone's WiFi settings" />
            <Numbered n={2} title={`Join “${BIN_AP_PREFIX}XXXX”`}>
              <Text style={tx.sub}>
                Password: <Text style={{ fontWeight: '700', color: t.text }}>{settings.apPassword}</Text>
              </Text>
            </Numbered>
            <Numbered n={3} title="If Android says “No internet”, choose Stay connected" />
            <Numbered n={4} title="Come back here and tap “I'm connected”" />
          </Card>
          <Button title="Open WiFi settings" icon="settings-outline" variant="secondary" onPress={() => Linking.sendIntent('android.settings.WIFI_SETTINGS').catch(() => Linking.openSettings())} />
          <Button title="I'm connected" icon="checkmark" onPress={manualConnected} />
          {canAutoJoin() ? <Button title="Try automatic again" variant="ghost" compact onPress={startJoin} /> : null}
        </>
      ) : null}

      {step === 'networks' && info ? (
        <>
          <Card style={{ gap: space.xs }}>
            <Row>
              <IconTile icon="checkmark" color={t.primary} bg={t.primarySoft} size={40} />
              <View style={{ flex: 1 }}>
                <Text style={tx.h3}>Connected to {info.device_id}</Text>
                <Text style={tx.small}>Firmware {info.fw}</Text>
              </View>
            </Row>
          </Card>
          {info.last_error && info.ssid ? (
            <Banner
              tone="error"
              icon="warning-outline"
              text={
                info.last_error === 'not_found'
                  ? `Last time the bin couldn't see “${info.ssid}”. It only works with 2.4 GHz WiFi — pick a network from the list below.`
                  : `Last time the bin couldn't join “${info.ssid}”. The password may be wrong.`
              }
            />
          ) : null}
          <NetworkPicker
            networks={networks}
            selected={ssid}
            onSelect={(s) => {
              setSsid(s);
              setPassword('');
            }}
            scanning={scanning}
            onRescan={() => rescan(true)}
          />
          {ssid !== '' ? (
            <Card style={{ gap: space.md }}>
              <Text style={tx.h3}>Password for “{ssid}”</Text>
              <PasswordField value={password} onChange={setPassword} />
              <Text style={tx.small}>Networks that need a login page (hotels, some colleges) won’t work.</Text>
              <Button
                title="Connect bin"
                icon="paper-plane"
                disabled={ssid.trim() === '' || (password.length > 0 && password.length < 8)}
                onPress={send}
              />
            </Card>
          ) : null}
        </>
      ) : null}

      {step === 'sending' ? <Working title="Sending WiFi details…" body="Almost there." /> : null}

      {step === 'waiting' ? (
        <Card style={{ gap: space.lg }}>
          <Text style={tx.h2}>Bringing your bin online</Text>
          <Phase done label="WiFi details saved on the bin" />
          <Phase active={elapsed < 20} done={elapsed >= 20} label={`Bin restarts and joins “${target.current?.ssid}”`} />
          <Phase active={elapsed >= 20} label="Bin checks in with the server" />
          <View style={{ height: 8, borderRadius: 4, backgroundColor: t.border, overflow: 'hidden' }}>
            <View style={{ height: '100%', width: `${Math.min(100, (elapsed / WAIT_LIMIT_S) * 100)}%`, backgroundColor: t.primary }} />
          </View>
          <Text style={tx.small}>Your phone is back on its normal network. This usually takes 20–40 seconds.</Text>
        </Card>
      ) : null}

      {step === 'done' ? (
        <>
          <Hero icon="checkmark-circle" title="Your bin is online!" body={`It's connected to “${target.current?.ssid}” and reporting to the server. You can move it anywhere with this WiFi.`} />
          <Button title="Go to dashboard" icon="home" onPress={() => router.dismissTo('/')} />
        </>
      ) : null}

      {step === 'failed' ? (
        <>
          <Hero icon="alert-circle" tone="error" title="The bin didn't come online" body="It will reopen its setup hotspot on its own within a minute, so you can try again." />
          <Card style={{ gap: space.md }}>
            <Text style={tx.h3}>Common causes</Text>
            <Reason text="The WiFi password was mistyped." />
            <Reason text="The network is 5 GHz only — the bin needs 2.4 GHz (most phone hotspots can switch)." />
            <Reason text="The bin is too far from the router." />
            <Reason text="The network needs a login page, or blocks internet access." />
            <Reason text="The server URL in Settings is wrong, or the server is still waking up." />
          </Card>
          <Button title="Try again" icon="refresh" onPress={() => setStep('intro')} />
        </>
      ) : null}
    </Screen>
  );
}

function Progress({ index, labels }: { index: number; labels: string[] }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: space.sm }}>
      {labels.map((l, i) => (
        <View key={l} style={{ flex: 1, gap: 6 }}>
          <View style={{ height: 5, borderRadius: 3, backgroundColor: i <= index ? t.primary : t.border }} />
          <Text style={{ fontSize: 11, fontWeight: '600', color: i <= index ? t.primary : t.faint }}>{l}</Text>
        </View>
      ))}
    </View>
  );
}

function Hero({ icon, title, body, tone }: { icon: IconName; title: string; body: string; tone?: 'error' }) {
  const t = useTheme();
  const tx = textStyles(t);
  const fg = tone === 'error' ? t.danger : t.primary;
  const bg = tone === 'error' ? t.dangerSoft : t.primarySoft;
  return (
    <View style={{ alignItems: 'center', gap: space.md, paddingVertical: space.lg }}>
      <View style={{ width: 112, height: 112, borderRadius: 56, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
        <Ionicons name={icon} size={56} color={fg} />
      </View>
      <Text style={[tx.h2, { fontSize: 24, textAlign: 'center' }]}>{title}</Text>
      <Text style={[tx.sub, { textAlign: 'center', fontSize: 15, lineHeight: 21 }]}>{body}</Text>
    </View>
  );
}

function Numbered({ n, title, children }: { n: number; title: string; children?: ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: space.md }}>
      <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: t.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: t.primary, fontWeight: '800' }}>{n}</Text>
      </View>
      <View style={{ flex: 1, gap: space.sm, paddingTop: 3 }}>
        <Text style={textStyles(t).h3}>{title}</Text>
        {children}
      </View>
    </View>
  );
}

function Working({ title, body }: { title: string; body: string }) {
  const t = useTheme();
  const tx = textStyles(t);
  return (
    <Card style={{ alignItems: 'center', gap: space.md, paddingVertical: space.xxl }}>
      <ActivityIndicator size="large" color={t.primary} />
      <Text style={[tx.h2, { textAlign: 'center' }]}>{title}</Text>
      <Text style={[tx.sub, { textAlign: 'center' }]}>{body}</Text>
    </Card>
  );
}

function Phase({ label, done, active }: { label: string; done?: boolean; active?: boolean }) {
  const t = useTheme();
  return (
    <Row>
      {done ? (
        <Ionicons name="checkmark-circle" size={24} color={t.primary} />
      ) : active ? (
        <ActivityIndicator size="small" color={t.primary} style={{ width: 24 }} />
      ) : (
        <Ionicons name="ellipse-outline" size={24} color={t.border} />
      )}
      <Text style={{ flex: 1, color: done || active ? t.text : t.faint, fontSize: 15, fontWeight: active ? '700' : '500' }}>{label}</Text>
    </Row>
  );
}

function Reason({ text }: { text: string }) {
  const t = useTheme();
  return (
    <Row style={{ alignItems: 'flex-start', gap: space.sm }}>
      <Ionicons name="ellipse" size={6} color={t.sub} style={{ marginTop: 8 }} />
      <Text style={[textStyles(t).sub, { flex: 1 }]}>{text}</Text>
    </Row>
  );
}

function NetworkPicker({
  networks,
  selected,
  onSelect,
  scanning,
  onRescan,
}: {
  networks: NearbyNetwork[];
  selected: string;
  onSelect: (ssid: string) => void;
  scanning: boolean;
  onRescan: () => void;
}) {
  const t = useTheme();
  const tx = textStyles(t);
  const [other, setOther] = useState(false);
  const known = networks.some((n) => n.ssid === selected);

  return (
    <Card style={{ gap: space.sm, padding: space.md }}>
      <Row style={{ justifyContent: 'space-between', paddingHorizontal: space.xs }}>
        <Text style={tx.h3}>Networks the bin can see</Text>
        <Pressable onPress={onRescan} disabled={scanning} hitSlop={10} accessibilityLabel="Scan again">
          {scanning ? <ActivityIndicator size="small" color={t.primary} /> : <Ionicons name="refresh" size={22} color={t.primary} />}
        </Pressable>
      </Row>
      {networks.length === 0 && !scanning ? (
        <Text style={[tx.sub, { padding: space.sm }]}>No networks found. Tap refresh to scan again.</Text>
      ) : null}
      {networks.map((n) => {
        const active = n.ssid === selected && !other;
        return (
          <Pressable
            key={n.ssid}
            onPress={() => {
              setOther(false);
              onSelect(n.ssid);
            }}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.md,
              padding: space.md,
              borderRadius: radius.md,
              backgroundColor: active ? t.primarySoft : 'transparent',
              borderWidth: 1,
              borderColor: active ? t.primary : 'transparent',
            }}
          >
            <Ionicons name="wifi" size={20} color={active ? t.primary : t.sub} />
            <Text style={{ flex: 1, color: t.text, fontSize: 16, fontWeight: active ? '700' : '500' }} numberOfLines={1}>
              {n.ssid}
            </Text>
            {n.secure ? <Ionicons name="lock-closed" size={14} color={t.faint} /> : null}
            <SignalBars rssi={n.rssi} color={active ? t.primary : t.sub} />
          </Pressable>
        );
      })}
      <Pressable
        onPress={() => {
          setOther(true);
          onSelect(known ? '' : selected);
        }}
        style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md }}
      >
        <Ionicons name="add-circle-outline" size={20} color={t.primary} />
        <Text style={{ color: t.primary, fontWeight: '700' }}>Other (hidden) network…</Text>
      </Pressable>
      {other ? (
        <TextInput
          value={selected}
          onChangeText={onSelect}
          placeholder="WiFi name"
          placeholderTextColor={t.faint}
          autoCapitalize="none"
          autoCorrect={false}
          style={{ borderWidth: 1, borderColor: t.border, backgroundColor: t.cardAlt, borderRadius: radius.md, padding: space.md, color: t.text, fontSize: 15 }}
        />
      ) : null}
    </Card>
  );
}

function PasswordField({ value, onChange }: { value: string; onChange: (s: string) => void }) {
  const t = useTheme();
  const [show, setShow] = useState(false);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: t.border, backgroundColor: t.cardAlt, borderRadius: radius.md, paddingHorizontal: space.md }}>
      <Ionicons name="key-outline" size={18} color={t.sub} />
      <TextInput
        value={value}
        onChangeText={onChange}
        secureTextEntry={!show}
        placeholder="Leave empty for an open network"
        placeholderTextColor={t.faint}
        autoCapitalize="none"
        autoCorrect={false}
        style={{ flex: 1, color: t.text, fontSize: 15, paddingVertical: 14, paddingHorizontal: space.sm }}
      />
      <Pressable onPress={() => setShow((s) => !s)} hitSlop={10} accessibilityLabel={show ? 'Hide password' : 'Show password'}>
        <Ionicons name={show ? 'eye-off-outline' : 'eye-outline'} size={20} color={t.sub} />
      </Pressable>
    </View>
  );
}
