import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';

import { Banner, Button, EmptyState, Row, Screen } from '../../components/ui';
import { getLogs, LogLine } from '../../lib/api';
import { clockTime } from '../../lib/format';
import { usePolling } from '../../lib/hooks';
import { isPaired, useSettings } from '../../lib/settings';
import { radius, space, useTheme } from '../../lib/theme';

const MAX_LINES = 500;
const MONO = Platform.select({ android: 'monospace', ios: 'Menlo', default: 'monospace' });

/** Live device log — the phone version of wireless_monitor.py, via the server. */
export default function LogsScreen() {
  const t = useTheme();
  const { settings, ready } = useSettings();
  const paired = isPaired(settings);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [follow, setFollow] = useState(true);
  const cursor = useRef(0);
  const scroller = useRef<ScrollView>(null);

  const poll = usePolling(
    async () => {
      const r = await getLogs(settings, cursor.current);
      // The server restarted (its counter went backwards) — start over.
      if (r.next < cursor.current) {
        cursor.current = 0;
        setLines([]);
        return;
      }
      cursor.current = r.next;
      if (r.lines.length) setLines((prev) => [...prev, ...r.lines].slice(-MAX_LINES));
    },
    2000,
    ready && paired,
  );

  if (!paired) {
    return (
      <Screen title="Logs">
        <EmptyState
          icon="terminal-outline"
          title="No bin linked"
          body="Your bin's live log appears here — handy for checking what it's doing without a USB cable."
          action={<Button title="Set up my bin" icon="wifi" onPress={() => router.push('/setup')} style={{ alignSelf: 'stretch' }} />}
        />
      </Screen>
    );
  }

  return (
    <Screen
      title="Logs"
      subtitle="Live from your bin"
      scroll={false}
      right={
        <Row style={{ gap: space.sm }}>
          <IconButton icon={follow ? 'arrow-down-circle' : 'arrow-down-circle-outline'} active={follow} onPress={() => setFollow((f) => !f)} label="Auto-scroll" />
          <IconButton icon="trash-outline" onPress={() => setLines([])} label="Clear" />
        </Row>
      }
    >
      {poll.error ? <Banner tone="error" icon="cloud-offline-outline" text={poll.error} /> : null}
      <View style={{ flex: 1, backgroundColor: t.console, borderRadius: radius.lg, marginTop: space.md, marginBottom: space.lg, overflow: 'hidden' }}>
        <ScrollView
          ref={scroller}
          contentContainerStyle={{ padding: space.md }}
          onContentSizeChange={() => follow && scroller.current?.scrollToEnd({ animated: true })}
        >
          {lines.length === 0 ? (
            <Text style={{ color: t.consoleText, opacity: 0.6, fontFamily: MONO, fontSize: 12 }}>
              Waiting for log lines… (the bin sends them every 15 seconds)
            </Text>
          ) : (
            lines.map((l) => (
              <Text key={l.seq} style={{ color: lineColor(l.text, t.consoleText), fontFamily: MONO, fontSize: 12, lineHeight: 18 }} selectable>
                <Text style={{ opacity: 0.45 }}>{clockTime(l.t)}  </Text>
                {l.text}
              </Text>
            ))
          )}
        </ScrollView>
      </View>
    </Screen>
  );
}

function lineColor(text: string, base: string) {
  if (text.includes('❌') || text.includes('failed')) return '#FF8A8A';
  if (text.includes('⚠️')) return '#FFC870';
  if (text.includes('✅')) return '#7CE3A3';
  if (text.startsWith('>>>')) return '#8AD8FF';
  return base;
}

function IconButton({ icon, onPress, label, active }: { icon: 'trash-outline' | 'arrow-down-circle' | 'arrow-down-circle-outline'; onPress: () => void; label: string; active?: boolean }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityLabel={label}
      style={{ width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: active ? t.primarySoft : t.cardAlt }}
    >
      <Ionicons name={icon} size={22} color={active ? t.primary : t.sub} />
    </Pressable>
  );
}
