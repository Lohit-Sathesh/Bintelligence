import Ionicons from '@expo/vector-icons/Ionicons';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, Text, TextInput, View } from 'react-native';

import { Banner, Button, Card, Divider, IconName, IconTile, Row, Screen, SectionTitle, textStyles } from '../../components/ui';
import { checkHealth } from '../../lib/api';
import { DEFAULT_AP_PASSWORD, DEFAULT_SERVER, isPaired, normalizeServer, useSettings } from '../../lib/settings';
import { radius, space, useTheme } from '../../lib/theme';

export default function SettingsScreen() {
  const t = useTheme();
  const tx = textStyles(t);
  const { settings, update } = useSettings();
  const paired = isPaired(settings);

  const [server, setServer] = useState(settings.serverUrl);
  const [apPass, setApPass] = useState(settings.apPassword);
  const [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const serverDirty = normalizeServer(server) !== normalizeServer(settings.serverUrl);

  async function testServer() {
    setChecking(true);
    setCheck(null);
    try {
      const r = await checkHealth(server || DEFAULT_SERVER);
      setCheck({ ok: r.status === 'healthy', text: r.status === 'healthy' ? 'Server is up and the model is loaded.' : 'Server answered but the model is not ready.' });
    } catch (e) {
      setCheck({ ok: false, text: e instanceof Error ? e.message : 'Could not reach the server.' });
    } finally {
      setChecking(false);
    }
  }

  return (
    <Screen title="Settings">
      <SectionTitle>Your bin</SectionTitle>
      <Card style={{ gap: space.lg }}>
        <Row>
          <IconTile icon="trash" color={paired ? t.primary : t.faint} bg={paired ? t.primarySoft : t.cardAlt} />
          <View style={{ flex: 1 }}>
            <Text style={tx.h3}>{paired ? settings.deviceId : 'No bin linked'}</Text>
            <Text style={tx.sub}>{paired ? 'Linked to this phone' : 'Set up WiFi to link your bin'}</Text>
          </View>
        </Row>
        <Button title={paired ? 'Change WiFi network' : 'Set up my bin'} icon="wifi" onPress={() => router.push('/setup')} />
        {paired ? (
          <Button
            title="Forget this bin"
            icon="unlink"
            variant="danger"
            compact
            onPress={() =>
              Alert.alert('Forget this bin?', "The app will stop showing its status. The bin itself keeps working; run WiFi setup again to re-link it.", [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Forget', style: 'destructive', onPress: () => update({ deviceId: null, deviceKey: null }) },
              ])
            }
          />
        ) : null}
      </Card>

      <SectionTitle>Classifier server</SectionTitle>
      <Card style={{ gap: space.md }}>
        <Text style={tx.sub}>
          Your bin and this app both talk to this server, so they work on any WiFi with internet.
        </Text>
        <Field value={server} onChangeText={setServer} placeholder="https://your-space.hf.space" icon="cloud-outline" keyboardType="url" />
        {check ? <Banner tone={check.ok ? 'info' : 'error'} icon={check.ok ? 'checkmark-circle' : 'alert-circle-outline'} text={check.text} /> : null}
        <View style={{ flexDirection: 'row', gap: space.md }}>
          <Button title="Test" icon="pulse" variant="secondary" compact style={{ flex: 1 }} loading={checking} onPress={testServer} />
          <Button
            title="Save"
            icon="save-outline"
            compact
            style={{ flex: 1 }}
            disabled={!serverDirty}
            onPress={() => {
              update({ serverUrl: normalizeServer(server) });
              if (paired) {
                Alert.alert('Saved', 'Run WiFi setup again so your bin uses the new server too.');
              }
            }}
          />
        </View>
      </Card>

      <Pressable onPress={() => setShowAdvanced((v) => !v)} hitSlop={8}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text style={[tx.sub, { fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, fontSize: 13 }]}>Advanced</Text>
          <Ionicons name={showAdvanced ? 'chevron-up' : 'chevron-down'} size={18} color={t.sub} />
        </Row>
      </Pressable>
      {showAdvanced ? (
        <Card style={{ gap: space.md }}>
          <Text style={tx.h3}>Setup hotspot password</Text>
          <Text style={tx.sub}>
            Only change this if you changed SETUP_AP_PASSWORD in the firmware. Default: “{DEFAULT_AP_PASSWORD}”.
          </Text>
          <Field value={apPass} onChangeText={setApPass} icon="key-outline" />
          <Button
            title="Save password"
            compact
            variant="secondary"
            disabled={apPass === settings.apPassword || apPass.length < 8}
            onPress={() => update({ apPassword: apPass })}
          />
          <Divider />
          <Text style={tx.small}>App version {Constants.expoConfig?.version ?? '—'}</Text>
        </Card>
      ) : null}
    </Screen>
  );
}

function Field({
  value,
  onChangeText,
  placeholder,
  icon,
  keyboardType,
}: {
  value: string;
  onChangeText: (s: string) => void;
  placeholder?: string;
  icon: IconName;
  keyboardType?: 'url' | 'default';
}) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, borderWidth: 1, borderColor: t.border, backgroundColor: t.cardAlt, borderRadius: radius.md, paddingHorizontal: space.md }}>
      <Ionicons name={icon} size={18} color={t.sub} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={t.faint}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={keyboardType}
        style={{ flex: 1, color: t.text, fontSize: 15, paddingVertical: 14 }}
      />
    </View>
  );
}
