import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { hasUsefulBox, ResultView } from '../../components/ResultView';
import { Banner, Card, Divider, Row, Screen, Skeleton, textStyles } from '../../components/ui';
import { eventImageUrl, getEvents, SortEvent } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { useSettings } from '../../lib/settings';
import { space, useTheme } from '../../lib/theme';

export default function EventScreen() {
  const t = useTheme();
  const tx = textStyles(t);
  const { id } = useLocalSearchParams<{ id: string }>();
  const { settings } = useSettings();
  const [ev, setEv] = useState<SortEvent | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getEvents(settings, 50)
      .then((list) => {
        const found = list.find((e) => String(e.id) === id);
        if (found) setEv(found);
        else setError('This item is no longer stored on the server.');
      })
      .catch((e) => setError(e.message));
  }, [id, settings]);

  const when = ev ? new Date(ev.t * 1000) : null;
  return (
    <Screen
      title="Sorted item"
      right={
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityLabel="Close">
          <Ionicons name="close-circle" size={34} color={t.faint} />
        </Pressable>
      }
    >
      {error ? <Banner tone="error" icon="alert-circle-outline" text={error} /> : null}
      {!ev && !error ? <Skeleton height={380} /> : null}
      {ev && when ? (
        <>
          <ResultView uri={eventImageUrl(settings, ev.id)} result={ev} caption="The bin sorted this as" />
          <Card style={{ gap: space.md }}>
            <Detail label="When" value={`${when.toLocaleDateString()} · ${when.toLocaleTimeString()}`} sub={timeAgo(ev.t)} />
            <Divider />
            <Detail label="Confidence" value={`${ev.confidence.toFixed(1)}%`} />
            <Divider />
            <Detail label="Tray tilted" value={ev.class === 'wet' ? 'Left (wet side)' : 'Right (dry side)'} />
          </Card>
          {hasUsefulBox(ev.bbox) ? (
            <Text style={[tx.small, { textAlign: 'center' }]}>
              The box shows where the model was looking when it decided.
            </Text>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}

function Detail({ label, value, sub }: { label: string; value: string; sub?: string }) {
  const tx = textStyles(useTheme());
  return (
    <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
      <Text style={tx.sub}>{label}</Text>
      <View style={{ flexShrink: 1, alignItems: 'flex-end' }}>
        <Text style={[tx.body, { fontWeight: '600', textAlign: 'right' }]}>{value}</Text>
        {sub ? <Text style={tx.small}>{sub}</Text> : null}
      </View>
    </Row>
  );
}
