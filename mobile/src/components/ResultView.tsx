import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { Animated, StyleSheet, Text, useAnimatedValue, View } from 'react-native';

import { BBox, Prediction } from '../lib/api';
import { className } from '../lib/format';
import { classColor, radius, space, useTheme } from '../lib/theme';
import { Card, ClassBadge } from './ui';

/**
 * Photo with the model's bounding box, the predicted class and the wet/dry
 * probability bars — the mobile version of the web dashboard's result card.
 */
export function ResultView({ uri, result, caption }: { uri: string; result: Prediction; caption?: string }) {
  const t = useTheme();
  return (
    <Card style={{ gap: space.lg }}>
      <PhotoWithBox uri={uri} bbox={result.bbox} color={classColor(t, result.class)} />
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ gap: 4 }}>
          <Text style={{ color: t.sub, fontSize: 13, fontWeight: '600' }}>{caption ?? 'Predicted'}</Text>
          <Text style={{ color: t.text, fontSize: 24, fontWeight: '800' }}>{className(result.class)}</Text>
        </View>
        <ClassBadge cls={result.class} size="lg" />
      </View>
      <ProbBar label="Wet" value={result.probabilities.wet} color={t.wet} />
      <ProbBar label="Dry" value={result.probabilities.dry} color={t.dry} />
    </Card>
  );
}

export function PhotoWithBox({ uri, bbox, color }: { uri: string; bbox: BBox | null; color: string }) {
  const t = useTheme();
  // The box is in normalised image coordinates, so the frame is sized to the
  // photo's own aspect ratio and the box can be placed with percentages.
  const [aspect, setAspect] = useState(4 / 3);
  const showBox = hasUsefulBox(bbox);
  return (
    <View style={{ width: '100%', aspectRatio: aspect, borderRadius: radius.md, overflow: 'hidden', backgroundColor: t.cardAlt }}>
      <Image
        source={{ uri }}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        transition={200}
        onLoad={(e) => e.source.width && e.source.height && setAspect(e.source.width / e.source.height)}
      />
      {showBox ? (
        <View
          style={{
            position: 'absolute',
            left: `${bbox.x * 100}%`,
            top: `${bbox.y * 100}%`,
            width: `${bbox.w * 100}%`,
            height: `${bbox.h * 100}%`,
            borderWidth: 3,
            borderColor: color,
            borderRadius: 8,
          }}
        />
      ) : null}
    </View>
  );
}

/** A box covering (almost) the whole frame carries no information. */
export function hasUsefulBox(bbox: BBox | null): bbox is BBox {
  return !!bbox && !(bbox.w > 0.97 && bbox.h > 0.97);
}

export function ProbBar({ label, value, color }: { label: string; value: number; color: string }) {
  const t = useTheme();
  const w = useAnimatedValue(0);
  useEffect(() => {
    Animated.timing(w, { toValue: value, duration: 600, useNativeDriver: false }).start();
  }, [value, w]);
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={{ color: t.text, fontWeight: '600' }}>{label}</Text>
        <Text style={{ color, fontWeight: '800' }}>{value.toFixed(1)}%</Text>
      </View>
      <View style={{ height: 10, borderRadius: 5, backgroundColor: t.border, overflow: 'hidden' }}>
        <Animated.View
          style={{
            height: '100%',
            borderRadius: 5,
            backgroundColor: color,
            width: w.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] }),
          }}
        />
      </View>
    </View>
  );
}
