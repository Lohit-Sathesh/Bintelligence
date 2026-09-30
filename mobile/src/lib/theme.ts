import { useColorScheme } from 'react-native';

// Wet = cyan/teal and dry = orange, matching the web dashboard.
const light = {
  bg: '#F2F6F3',
  card: '#FFFFFF',
  cardAlt: '#F7FAF8',
  text: '#13231A',
  sub: '#5E6E65',
  faint: '#98A69E',
  border: '#E2EAE5',
  primary: '#1F9D55',
  primarySoft: '#DDF3E6',
  onPrimary: '#FFFFFF',
  wet: '#0B9FB0',
  wetSoft: '#D9F3F6',
  dry: '#E8870E',
  drySoft: '#FDEBD3',
  danger: '#D64545',
  dangerSoft: '#FBE3E3',
  offline: '#9AA5A0',
  shadow: '#0B2A18',
  console: '#0F1A14',
  consoleText: '#C9E8D3',
};

const dark: typeof light = {
  bg: '#0C1310',
  card: '#151F1A',
  cardAlt: '#1B2721',
  text: '#E8F0EB',
  sub: '#9AAAA1',
  faint: '#66766D',
  border: '#24322A',
  primary: '#3CC47A',
  primarySoft: '#16301F',
  onPrimary: '#06140C',
  wet: '#2CCBDD',
  wetSoft: '#0F2E33',
  dry: '#F5A33A',
  drySoft: '#36260F',
  danger: '#F06A6A',
  dangerSoft: '#3A1818',
  offline: '#66766D',
  shadow: '#000000',
  console: '#070C09',
  consoleText: '#B6E3C4',
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}

export const radius = { sm: 10, md: 16, lg: 22, pill: 999 };
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };

export function classColor(t: Theme, cls: string | null | undefined) {
  return cls === 'wet' ? t.wet : cls === 'dry' ? t.dry : t.faint;
}

export function classSoft(t: Theme, cls: string | null | undefined) {
  return cls === 'wet' ? t.wetSoft : cls === 'dry' ? t.drySoft : t.cardAlt;
}
