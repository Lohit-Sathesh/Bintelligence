import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';

import { ResultView } from '../../components/ResultView';
import { Banner, Button, Card, IconTile, Screen, textStyles } from '../../components/ui';
import { classifyPhoto, Prediction } from '../../lib/api';
import { useSettings } from '../../lib/settings';
import { radius, space, useTheme } from '../../lib/theme';

type Photo = { uri: string; mimeType?: string; aspect: number };

export default function TestScreen() {
  const t = useTheme();
  const tx = textStyles(t);
  const { settings } = useSettings();
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [result, setResult] = useState<Prediction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(source: 'camera' | 'library') {
    setError(null);
    if (source === 'camera') {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        setError('Camera permission is needed to take a photo.');
        return;
      }
    }
    const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.8 };
    const res =
      source === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
    if (res.canceled || !res.assets[0]) return;
    const a = res.assets[0];
    const p = { uri: a.uri, mimeType: a.mimeType ?? 'image/jpeg', aspect: a.width && a.height ? a.width / a.height : 4 / 3 };
    setPhoto(p);
    setResult(null);
    classify(p);
  }

  async function classify(p: Photo) {
    setBusy(true);
    try {
      const r = await classifyPhoto(settings, p.uri, p.mimeType);
      setResult(r);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Classification failed.');
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setPhoto(null);
    setResult(null);
    setError(null);
  }

  return (
    <Screen title="Test a photo" subtitle="Check what the AI thinks of any item">
      {error ? <Banner tone="error" icon="alert-circle-outline" text={error} /> : null}

      {!photo ? (
        <Card style={{ alignItems: 'center', gap: space.lg, paddingVertical: space.xxl }}>
          <IconTile icon="scan" color={t.primary} bg={t.primarySoft} size={72} />
          <Text style={[tx.h2, { textAlign: 'center' }]}>Wet or dry?</Text>
          <Text style={[tx.sub, { textAlign: 'center' }]}>
            Take a photo of a single item on a plain background for the best result.
          </Text>
          <View style={{ alignSelf: 'stretch', gap: space.md }}>
            <Button title="Take a photo" icon="camera" onPress={() => pick('camera')} />
            <Button title="Choose from gallery" icon="images" variant="secondary" onPress={() => pick('library')} />
          </View>
        </Card>
      ) : result ? (
        <>
          <ResultView uri={photo.uri} result={result} />
          <Button title="Test another item" icon="refresh" variant="secondary" onPress={reset} />
        </>
      ) : (
        <Card style={{ gap: space.lg }}>
          <View style={{ width: '100%', aspectRatio: photo.aspect, borderRadius: radius.md, overflow: 'hidden' }}>
            <Image source={{ uri: photo.uri }} style={{ flex: 1 }} contentFit="cover" />
            {busy ? (
              <View style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0007', gap: space.sm }}>
                <ActivityIndicator size="large" color="#fff" />
                <Text style={{ color: '#fff', fontWeight: '700' }}>Analysing…</Text>
              </View>
            ) : null}
          </View>
          {busy ? (
            <Text style={[tx.small, { textAlign: 'center' }]}>
              If the server was asleep this can take up to a minute.
            </Text>
          ) : (
            <View style={{ flexDirection: 'row', gap: space.md }}>
              <Button title="Retry" icon="refresh" style={{ flex: 1 }} onPress={() => classify(photo)} />
              <Button title="New photo" variant="ghost" style={{ flex: 1 }} onPress={reset} />
            </View>
          )}
        </Card>
      )}
    </Screen>
  );
}
