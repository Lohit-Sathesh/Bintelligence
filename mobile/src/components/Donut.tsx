import { Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { useTheme } from '../lib/theme';

/** Wet/dry split ring with the total in the middle. */
export function Donut({ wet, dry, size = 132 }: { wet: number; dry: number; size?: number }) {
  const t = useTheme();
  const stroke = 16;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const total = wet + dry;
  const wetLen = total ? (wet / total) * c : 0;
  // Small gap between segments so they read as two parts, not one bar.
  const gap = wet && dry ? 4 : 0;

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={t.border} strokeWidth={stroke} fill="none" />
        {total > 0 && dry > 0 ? (
          <Circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke={t.dry}
            strokeWidth={stroke}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={`${Math.max(0, c - wetLen - gap)} ${c}`}
            strokeDashoffset={-(wetLen + gap / 2)}
          />
        ) : null}
        {wet > 0 ? (
          <Circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke={t.wet}
            strokeWidth={stroke}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={`${Math.max(0, wetLen - gap)} ${c}`}
            strokeDashoffset={-gap / 2}
          />
        ) : null}
      </Svg>
      <Text style={{ color: t.text, fontSize: 30, fontWeight: '800' }}>{total}</Text>
      <Text style={{ color: t.sub, fontSize: 12, fontWeight: '600' }}>items</Text>
    </View>
  );
}
