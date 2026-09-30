import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';

import { Donut } from '../../components/Donut';
import {
  Banner,
  Button,
  Card,
  ClassBadge,
  EmptyState,
  IconTile,
  PulseDot,
  Row,
  Screen,
  SectionTitle,
  SignalBars,
  Skeleton,
  textStyles,
} from '../../components/ui';
import { ApiError, Command, DeviceStatus, eventImageUrl, getEvents, getStatus, sendCommand, SortEvent } from '../../lib/api';
import { duration, signalLabel, timeAgo } from '../../lib/format';
import { usePolling, useTick } from '../../lib/hooks';
import { isPaired, useSettings } from '../../lib/settings';
import { radius, space, useTheme } from '../../lib/theme';

export default function HomeScreen() {
  const t = useTheme();
  const { settings, ready } = useSettings();
  const paired = isPaired(settings);
  const poll = usePolling(
    async () => {
      const [status, events] = await Promise.all([getStatus(settings), getEvents(settings, 1)]);
      return { status, latest: events[0] as SortEvent | undefined };
    },
    3000,
    ready && paired,
  );
  useTick(5000);

  if (!ready) return <Screen title="Bintelligence"><Skeleton height={180} /></Screen>;

  if (!paired) {
    return (
      <Screen title="Bintelligence" subtitle="Smart waste sorting">
        <EmptyState
          icon="leaf"
          title="Let's connect your bin"
          body="Link your dustbin to WiFi from your phone. It takes about a minute, and you'll never need its IP address."
          action={<Button title="Set up my bin" icon="wifi" onPress={() => router.push('/setup')} style={{ alignSelf: 'stretch' }} />}
        />
        <Card style={{ gap: space.sm }}>
          <Text style={textStyles(t).h3}>Just want to try the classifier?</Text>
          <Text style={textStyles(t).sub}>Open the Test tab to photograph any item and see whether it’s wet or dry waste.</Text>
        </Card>
      </Screen>
    );
  }

  const waiting = poll.error && poll.error.includes('Unknown device');
  return (
    <Screen
      title="Bintelligence"
      subtitle={settings.deviceId ?? undefined}
      onRefresh={poll.refresh}
      right={
        <Pressable onPress={() => router.push('/setup')} hitSlop={12} accessibilityLabel="WiFi setup">
          <IconTile icon="wifi" color={t.primary} bg={t.primarySoft} size={42} />
        </Pressable>
      }
    >
      {poll.error && !waiting ? <Banner tone="error" icon="cloud-offline-outline" text={poll.error} /> : null}
      {poll.loading && !poll.data ? (
        <>
          <Skeleton height={150} />
          <Skeleton height={170} />
        </>
      ) : waiting ? (
        <EmptyState
          icon="hourglass-outline"
          title="Waiting for your bin"
          body="The server hasn't heard from your bin yet. Make sure it's powered on — it checks in every 15 seconds once it's on WiFi."
        />
      ) : poll.data ? (
        <>
          <StatusCard s={poll.data.status} />
          <TodayCard s={poll.data.status} />
          <LatestCard ev={poll.data.latest} />
          <Actions online={poll.data.status.online} />
        </>
      ) : null}
    </Screen>
  );
}

function StatusCard({ s }: { s: DeviceStatus }) {
  const t = useTheme();
  const tx = textStyles(t);
  const color = !s.online ? t.offline : s.state === 'blocked' ? t.danger : t.primary;
  const headline = !s.online
    ? 'Offline'
    : s.state === 'sorting'
      ? 'Sorting an item…'
      : s.state === 'blocked'
        ? 'Something is stuck'
        : 'Ready for waste';
  const detail = !s.online
    ? s.last_seen
      ? `Last seen ${timeAgo(s.last_seen, s.server_time)}`
      : 'Not seen yet'
    : s.state === 'blocked'
      ? 'The sensor is still blocked — check the tray.'
      : 'Online and listening';
  return (
    <Card style={{ gap: space.lg }}>
      <Row>
        <IconTile icon="trash" color={color} bg={s.online ? t.primarySoft : t.cardAlt} size={52} />
        <View style={{ flex: 1, gap: 2 }}>
          <Row style={{ gap: space.sm }}>
            <PulseDot color={color} active={s.online} />
            <Text style={tx.h2}>{headline}</Text>
          </Row>
          <Text style={tx.sub}>{detail}</Text>
        </View>
      </Row>
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        <Chip icon="wifi" label={s.ssid || '—'} extra={<SignalBars rssi={s.rssi} color={s.online ? t.primary : t.faint} />} sub={s.online ? signalLabel(s.rssi) : 'WiFi'} />
        <Chip icon="time-outline" label={s.online && s.uptime_s != null ? duration(s.uptime_s) : '—'} sub="Uptime" />
      </View>
    </Card>
  );
}

function Chip({ icon, label, sub, extra }: { icon: 'wifi' | 'time-outline'; label: string; sub: string; extra?: React.ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: t.cardAlt, borderRadius: radius.md, padding: space.md, gap: 4 }}>
      <Row style={{ gap: 6, justifyContent: 'space-between' }}>
        <Ionicons name={icon} size={16} color={t.sub} />
        {extra}
      </Row>
      <Text style={{ color: t.text, fontWeight: '700', fontSize: 15 }} numberOfLines={1}>
        {label}
      </Text>
      <Text style={{ color: t.faint, fontSize: 12 }}>{sub}</Text>
    </View>
  );
}

function TodayCard({ s }: { s: DeviceStatus }) {
  const t = useTheme();
  const tx = textStyles(t);
  const { wet, dry } = s.today;
  const total = wet + dry;
  const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);
  return (
    <>
      <SectionTitle>Today</SectionTitle>
      <Card>
        <Row style={{ gap: space.xl }}>
          <Donut wet={wet} dry={dry} />
          <View style={{ flex: 1, gap: space.lg }}>
            <Legend color={t.wet} label="Wet" value={wet} pct={pct(wet)} />
            <Legend color={t.dry} label="Dry" value={dry} pct={pct(dry)} />
            <Text style={tx.small}>All time: {s.total.wet + s.total.dry} items</Text>
          </View>
        </Row>
      </Card>
    </>
  );
}

function Legend({ color, label, value, pct }: { color: string; label: string; value: number; pct: number }) {
  const t = useTheme();
  return (
    <View>
      <Row style={{ gap: space.sm }}>
        <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: color }} />
        <Text style={{ color: t.sub, fontWeight: '600' }}>{label}</Text>
      </Row>
      <Text style={{ color: t.text, fontSize: 24, fontWeight: '800' }}>
        {value} <Text style={{ color: t.faint, fontSize: 14, fontWeight: '600' }}>{pct}%</Text>
      </Text>
    </View>
  );
}

function LatestCard({ ev }: { ev?: SortEvent }) {
  const t = useTheme();
  const tx = textStyles(t);
  const { settings } = useSettings();
  return (
    <>
      <SectionTitle
        right={
          ev ? (
            <Pressable onPress={() => router.push('/history')} hitSlop={10}>
              <Text style={{ color: t.primary, fontWeight: '700' }}>See all</Text>
            </Pressable>
          ) : null
        }
      >
        Latest item
      </SectionTitle>
      {ev ? (
        <Pressable onPress={() => router.push({ pathname: '/event/[id]', params: { id: String(ev.id) } })}>
          <Card>
            <Row>
              <Image
                source={{ uri: eventImageUrl(settings, ev.id) }}
                style={{ width: 84, height: 84, borderRadius: radius.md, backgroundColor: t.cardAlt }}
                contentFit="cover"
                transition={200}
              />
              <View style={{ flex: 1, gap: 6 }}>
                <ClassBadge cls={ev.class} />
                <Text style={tx.h3}>{ev.confidence.toFixed(0)}% confident</Text>
                <Text style={tx.small}>{timeAgo(ev.t)}</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={t.faint} />
            </Row>
          </Card>
        </Pressable>
      ) : (
        <Card style={{ alignItems: 'center', gap: space.sm, paddingVertical: space.xl }}>
          <Ionicons name="sparkles-outline" size={28} color={t.faint} />
          <Text style={tx.sub}>Nothing sorted yet — drop something in!</Text>
        </Card>
      )}
    </>
  );
}

function Actions({ online }: { online: boolean }) {
  const t = useTheme();
  const { settings } = useSettings();
  const [busy, setBusy] = useState<Command | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function run(cmd: Command, label: string) {
    setBusy(cmd);
    try {
      await sendCommand(settings, cmd);
      setNote(`${label} sent — the bin picks it up within about 15 seconds.`);
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : 'Could not send the command.');
    } finally {
      setBusy(null);
      setTimeout(() => setNote(null), 6000);
    }
  }

  return (
    <>
      <SectionTitle>Quick actions</SectionTitle>
      <Card style={{ gap: space.md }}>
        {!online ? <Text style={textStyles(t).sub}>The bin is offline — actions will run when it reconnects.</Text> : null}
        <View style={{ flexDirection: 'row', gap: space.md }}>
          <Button
            title="Tilt wet"
            icon="water"
            variant="secondary"
            compact
            style={{ flex: 1 }}
            loading={busy === 'tilt_wet'}
            onPress={() => run('tilt_wet', 'Tilt wet')}
          />
          <Button
            title="Tilt dry"
            icon="cube"
            variant="secondary"
            compact
            style={{ flex: 1 }}
            loading={busy === 'tilt_dry'}
            onPress={() => run('tilt_dry', 'Tilt dry')}
          />
        </View>
        <Button
          title="Restart bin"
          icon="refresh"
          variant="ghost"
          compact
          loading={busy === 'restart'}
          onPress={() =>
            Alert.alert('Restart the bin?', 'It will be offline for about 20 seconds.', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Restart', onPress: () => run('restart', 'Restart') },
            ])
          }
        />
        {note ? <Banner tone="info" icon="paper-plane-outline" text={note} /> : null}
      </Card>
    </>
  );
}
