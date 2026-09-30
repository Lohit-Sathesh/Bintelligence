import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Banner, Button, Card, ClassBadge, EmptyState, Row, Screen, Skeleton, textStyles } from '../../components/ui';
import { eventImageUrl, getEvents, SortEvent } from '../../lib/api';
import { clockTime, timeAgo } from '../../lib/format';
import { usePolling, useTick } from '../../lib/hooks';
import { isPaired, useSettings } from '../../lib/settings';
import { radius, space, useTheme } from '../../lib/theme';

type Filter = 'all' | 'wet' | 'dry';

export default function HistoryScreen() {
  const t = useTheme();
  const { settings, ready } = useSettings();
  const paired = isPaired(settings);
  const [filter, setFilter] = useState<Filter>('all');
  const poll = usePolling(() => getEvents(settings, 50), 5000, ready && paired);
  useTick(10000);

  if (!paired) {
    return (
      <Screen title="History">
        <EmptyState
          icon="time-outline"
          title="No bin linked"
          body="Once your bin is set up, every item it sorts shows up here with its photo."
          action={<Button title="Set up my bin" icon="wifi" onPress={() => router.push('/setup')} style={{ alignSelf: 'stretch' }} />}
        />
      </Screen>
    );
  }

  const events = (poll.data ?? []).filter((e) => filter === 'all' || e.class === filter);
  return (
    <Screen title="History" subtitle="The last 50 items your bin sorted" onRefresh={poll.refresh}>
      <FilterBar value={filter} onChange={setFilter} />
      {poll.error ? <Banner tone="error" icon="cloud-offline-outline" text={poll.error} /> : null}
      {poll.loading && !poll.data ? (
        [0, 1, 2, 3].map((i) => <Skeleton key={i} height={88} />)
      ) : events.length === 0 ? (
        <Card style={{ alignItems: 'center', gap: space.sm, paddingVertical: space.xxl }}>
          <Ionicons name="file-tray-outline" size={32} color={t.faint} />
          <Text style={textStyles(t).sub}>
            {filter === 'all' ? 'Nothing sorted yet.' : `No ${filter} items yet.`}
          </Text>
        </Card>
      ) : (
        <View style={{ gap: space.md }}>
          {events.map((ev) => (
            <EventRow key={ev.id} ev={ev} />
          ))}
        </View>
      )}
    </Screen>
  );
}

function FilterBar({ value, onChange }: { value: Filter; onChange: (f: Filter) => void }) {
  const t = useTheme();
  const opts: { key: Filter; label: string; color: string }[] = [
    { key: 'all', label: 'All', color: t.primary },
    { key: 'wet', label: 'Wet', color: t.wet },
    { key: 'dry', label: 'Dry', color: t.dry },
  ];
  return (
    <View style={{ flexDirection: 'row', backgroundColor: t.cardAlt, borderRadius: radius.pill, padding: 4, borderWidth: 1, borderColor: t.border }}>
      {opts.map((o) => {
        const active = o.key === value;
        return (
          <Pressable
            key={o.key}
            onPress={() => onChange(o.key)}
            style={{ flex: 1, paddingVertical: 10, borderRadius: radius.pill, alignItems: 'center', backgroundColor: active ? t.card : 'transparent' }}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
          >
            <Text style={{ color: active ? o.color : t.sub, fontWeight: '700' }}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function EventRow({ ev }: { ev: SortEvent }) {
  const t = useTheme();
  const tx = textStyles(t);
  const { settings } = useSettings();
  return (
    <Pressable onPress={() => router.push({ pathname: '/event/[id]', params: { id: String(ev.id) } })}>
      {({ pressed }) => (
        <Card style={{ padding: space.md, opacity: pressed ? 0.85 : 1 }}>
          <Row>
            <Image
              source={{ uri: eventImageUrl(settings, ev.id) }}
              style={{ width: 64, height: 64, borderRadius: radius.sm, backgroundColor: t.cardAlt }}
              contentFit="cover"
              transition={150}
            />
            <View style={{ flex: 1, gap: 4 }}>
              <ClassBadge cls={ev.class} size="sm" />
              <Text style={tx.h3}>{ev.confidence.toFixed(0)}% confident</Text>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 4 }}>
              <Text style={tx.small}>{clockTime(ev.t)}</Text>
              <Text style={tx.small}>{timeAgo(ev.t)}</Text>
            </View>
          </Row>
        </Card>
      )}
    </Pressable>
  );
}
