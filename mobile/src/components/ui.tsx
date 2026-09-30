import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { ComponentProps, ReactNode, useEffect } from 'react';
import {
  ActivityIndicator,
  Animated,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleProp,
  StyleSheet,
  Text,
  useAnimatedValue,
  View,
  ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { signalBars } from '../lib/format';
import { classColor, classSoft, radius, space, Theme, useTheme } from '../lib/theme';

export type IconName = ComponentProps<typeof Ionicons>['name'];

/** Scrollable page with a large title, safe-area padding and pull-to-refresh. */
export function Screen({
  title,
  subtitle,
  right,
  children,
  onRefresh,
  refreshing = false,
  scroll = true,
}: {
  title?: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
  onRefresh?: () => void;
  refreshing?: boolean;
  scroll?: boolean;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const header = title ? (
    <View style={styles.header}>
      <View style={{ flex: 1 }}>
        <Text style={[styles.title, { color: t.text }]}>{title}</Text>
        {subtitle ? <Text style={[styles.subtitle, { color: t.sub }]}>{subtitle}</Text> : null}
      </View>
      {right}
    </View>
  ) : null;

  if (!scroll) {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top + space.md, paddingHorizontal: space.lg }}>
        {header}
        {children}
      </View>
    );
  }
  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingTop: insets.top + space.md,
          paddingHorizontal: space.lg,
          paddingBottom: space.xxl,
          gap: space.lg,
        }}
        refreshControl={
          onRefresh ? (
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.primary} colors={[t.primary]} />
          ) : undefined
        }
      >
        {header}
        {children}
      </ScrollView>
      {/* Keeps scrolled content from showing through the status bar. */}
      <View style={{ position: 'absolute', top: 0, left: 0, right: 0, height: insets.top, backgroundColor: t.bg }} />
    </View>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: t.card, borderColor: t.border, shadowColor: t.shadow },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  const t = useTheme();
  return (
    <View style={styles.sectionRow}>
      <Text style={[styles.section, { color: t.sub }]}>{children}</Text>
      {right}
    </View>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  title,
  onPress,
  icon,
  variant = 'primary',
  loading = false,
  disabled = false,
  style,
  compact = false,
}: {
  title: string;
  onPress: () => void;
  icon?: IconName;
  variant?: ButtonVariant;
  loading?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  compact?: boolean;
}) {
  const t = useTheme();
  const palette: Record<ButtonVariant, { bg: string; fg: string; border: string }> = {
    primary: { bg: t.primary, fg: t.onPrimary, border: t.primary },
    secondary: { bg: t.primarySoft, fg: t.primary, border: t.primarySoft },
    ghost: { bg: 'transparent', fg: t.text, border: t.border },
    danger: { bg: t.dangerSoft, fg: t.danger, border: t.dangerSoft },
  };
  const c = palette[variant];
  const off = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      disabled={off}
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        onPress();
      }}
      style={({ pressed }) => [
        styles.button,
        compact && styles.buttonCompact,
        { backgroundColor: c.bg, borderColor: c.border, opacity: off ? 0.5 : pressed ? 0.8 : 1 },
        pressed && !off && { transform: [{ scale: 0.98 }] },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={c.fg} />
      ) : (
        <>
          {icon ? <Ionicons name={icon} size={compact ? 18 : 20} color={c.fg} /> : null}
          <Text style={[styles.buttonText, compact && { fontSize: 14 }, { color: c.fg }]} numberOfLines={1}>
            {title}
          </Text>
        </>
      )}
    </Pressable>
  );
}

/** Round icon tile, e.g. for quick actions and list rows. */
export function IconTile({ icon, color, bg, size = 44 }: { icon: IconName; color: string; bg: string; size?: number }) {
  return (
    <View style={{ width: size, height: size, borderRadius: size / 3, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
      <Ionicons name={icon} size={size * 0.5} color={color} />
    </View>
  );
}

export function ClassBadge({ cls, size = 'md' }: { cls: string | null | undefined; size?: 'sm' | 'md' | 'lg' }) {
  const t = useTheme();
  const fs = size === 'lg' ? 16 : size === 'sm' ? 11 : 13;
  return (
    <View style={[styles.badge, { backgroundColor: classSoft(t, cls), paddingVertical: size === 'lg' ? 8 : 4 }]}>
      <Ionicons name={cls === 'wet' ? 'water' : 'cube'} size={fs} color={classColor(t, cls)} />
      <Text style={{ color: classColor(t, cls), fontWeight: '800', fontSize: fs, letterSpacing: 0.6 }}>
        {cls === 'wet' ? 'WET' : cls === 'dry' ? 'DRY' : '—'}
      </Text>
    </View>
  );
}

export function SignalBars({ rssi, color }: { rssi?: number; color: string }) {
  const t = useTheme();
  const n = signalBars(rssi);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 16 }}>
      {[1, 2, 3, 4].map((i) => (
        <View
          key={i}
          style={{ width: 4, height: 4 + i * 3, borderRadius: 2, backgroundColor: i <= n ? color : t.border }}
        />
      ))}
    </View>
  );
}

/** Pulsing placeholder shown while the first data loads. */
export function Skeleton({ height = 16, width = '100%', style }: { height?: number; width?: number | `${number}%`; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  const pulse = useAnimatedValue(0.5);
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.5, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return (
    <Animated.View
      style={[{ height, width, borderRadius: radius.sm, backgroundColor: t.border, opacity: pulse }, style]}
    />
  );
}

/** Soft green dot with an expanding ring, for "online". */
export function PulseDot({ color, active }: { color: string; active: boolean }) {
  const ring = useAnimatedValue(0);
  useEffect(() => {
    if (!active) return;
    const loop = Animated.loop(
      Animated.timing(ring, { toValue: 1, duration: 1600, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [active, ring]);
  return (
    <View style={{ width: 14, height: 14, alignItems: 'center', justifyContent: 'center' }}>
      {active ? (
        <Animated.View
          style={{
            position: 'absolute',
            width: 14,
            height: 14,
            borderRadius: 7,
            backgroundColor: color,
            opacity: ring.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }),
            transform: [{ scale: ring.interpolate({ inputRange: [0, 1], outputRange: [1, 2.4] }) }],
          }}
        />
      ) : null}
      <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: color }} />
    </View>
  );
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: IconName;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  const t = useTheme();
  return (
    <Card style={{ alignItems: 'center', paddingVertical: space.xxl, gap: space.md }}>
      <IconTile icon={icon} color={t.primary} bg={t.primarySoft} size={64} />
      <Text style={{ color: t.text, fontSize: 18, fontWeight: '700', textAlign: 'center' }}>{title}</Text>
      <Text style={{ color: t.sub, fontSize: 15, textAlign: 'center', lineHeight: 21 }}>{body}</Text>
      {action}
    </Card>
  );
}

export function Banner({ tone, icon, text }: { tone: 'error' | 'info'; icon: IconName; text: string }) {
  const t = useTheme();
  const fg = tone === 'error' ? t.danger : t.primary;
  const bg = tone === 'error' ? t.dangerSoft : t.primarySoft;
  return (
    <View style={[styles.banner, { backgroundColor: bg }]}>
      <Ionicons name={icon} size={18} color={fg} />
      <Text style={{ color: fg, flex: 1, fontSize: 14, lineHeight: 19 }}>{text}</Text>
    </View>
  );
}

export function Row({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap: space.md }, style]}>{children}</View>;
}

export function Divider() {
  const t = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.border }} />;
}

export function textStyles(t: Theme) {
  return {
    h2: { color: t.text, fontSize: 20, fontWeight: '800' as const },
    h3: { color: t.text, fontSize: 16, fontWeight: '700' as const },
    body: { color: t.text, fontSize: 15, lineHeight: 21 },
    sub: { color: t.sub, fontSize: 14, lineHeight: 19 },
    small: { color: t.faint, fontSize: 12 },
  };
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.xs },
  title: { fontSize: 30, fontWeight: '800', letterSpacing: -0.5 },
  subtitle: { fontSize: 15, marginTop: 2 },
  card: {
    borderRadius: radius.lg,
    padding: space.lg,
    borderWidth: StyleSheet.hairlineWidth,
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: -space.sm },
  section: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8 },
  button: {
    minHeight: 52,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: space.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
  },
  buttonCompact: { minHeight: 42, paddingHorizontal: space.md },
  buttonText: { fontSize: 16, fontWeight: '700' },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
    alignSelf: 'flex-start',
  },
  banner: { flexDirection: 'row', gap: space.sm, padding: space.md, borderRadius: radius.md, alignItems: 'flex-start' },
});
