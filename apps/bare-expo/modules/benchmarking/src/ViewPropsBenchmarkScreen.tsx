import { useTheme } from 'ThemeProvider';
import * as React from 'react';
import { Button, ScrollView, StyleSheet, Text, View } from 'react-native';

import BenchmarkView from './BenchmarkView';
import BenchmarkingModule, { type ViewPropsBenchmark } from './BenchmarkingExpoModule';

// How many prop-update passes to run in a measured batch (after warmup).
const ITERATIONS = 2000;
// Discarded warmup passes so component registration / first-allocation costs don't pollute
// the measured window.
const WARMUP = 200;

type BenchMode = 'all' | 'single';

const ALL_PROP_KEYS = [
  'color',
  'decoration',
  'values',
  'flag',
  'count',
  'ratio',
  'title',
  'subtitle',
] as const;

function valueForKey(key: (typeof ALL_PROP_KEYS)[number], i: number) {
  switch (key) {
    case 'color':
      return i % 2 === 0 ? '#ff0000' : '#00ff00';
    case 'decoration':
      return { opacity: (i % 100) / 100, cornerRadius: i % 24, label: `label-${i}`, weight: i % 7 };
    case 'values':
      return [i, i + 1, i + 2, i + 3, i + 4];
    case 'flag':
      return i % 2 === 0;
    case 'count':
      return i;
    case 'ratio':
      return (i % 50) / 50;
    case 'title':
      return `title-${i}`;
    case 'subtitle':
      return `subtitle-${i}`;
  }
}

/**
 * Builds prop values for pass `i`.
 *
 * - `'all'`: every prop changes each pass — worst case, measures a full re-decode.
 * - `'single'`: only ONE prop changes each pass (cycling which one), the rest keep a value
 *   pinned to a constant. This mirrors a realistic update where Fabric's rawProps diff carries
 *   a single changed prop, so the decode/apply path should touch ~1 prop instead of all of them.
 *   It's the realistic-case counterpart to the synthetic worst case.
 */
// Stable references for the "single" mode's unchanged props.
const PINNED_BASE = Object.fromEntries(ALL_PROP_KEYS.map((k) => [k, valueForKey(k, 0)]));

function propsForPass(i: number, mode: BenchMode) {
  if (mode === 'all') {
    return Object.fromEntries(ALL_PROP_KEYS.map((k) => [k, valueForKey(k, i)]));
  }
  // single: pin every prop to a STABLE pass-0 value, then vary exactly one (chosen by `i`).
  // Reuse the same references for the pinned props (PINNED_BASE) so React's reconciler diffs
  // them as unchanged — otherwise fresh object/array literals (decoration, values) would look
  // changed by identity and end up in the rawProps diff, defeating the single-prop scenario.
  const changing = ALL_PROP_KEYS[i % ALL_PROP_KEYS.length];
  return { ...PINNED_BASE, [changing]: valueForKey(changing, i) };
}

type Result = ViewPropsBenchmark & {
  decodeUsPerPass: number;
  applyUsPerPass: number;
};

export default function ViewPropsBenchmarkScreen() {
  const { theme } = useTheme();
  const [pass, setPass] = React.useState(0);
  const [running, setRunning] = React.useState(false);
  const [result, setResult] = React.useState<Result | null>(null);
  const [mode, setMode] = React.useState<BenchMode>('all');

  // Drives ITERATIONS+WARMUP passes via rAF, resetting the native counters right after warmup
  // so only the steady-state window is measured. We bump `pass` each frame; the rendered
  // BenchmarkView receives fresh props, which flows through Fabric → cloneProps (decode) →
  // finalizeUpdates (apply).
  const run = React.useCallback((runMode: BenchMode) => {
    setResult(null);
    setMode(runMode);
    setRunning(true);
    let i = 0;

    const tick = () => {
      if (i === WARMUP) {
        BenchmarkingModule.resetViewPropsBenchmark();
      }
      setPass(i);
      i += 1;

      if (i <= WARMUP + ITERATIONS) {
        requestAnimationFrame(tick);
      } else {
        // Let the last commit flush before reading.
        requestAnimationFrame(() => {
          const snap = BenchmarkingModule.getViewPropsBenchmark();
          // Normalize each side by its OWN pass count: Fabric may call cloneProps (decode)
          // more than once per visual update, while apply runs once per finalizeUpdates.
          const decodePasses = Math.max(snap.decodePassCount, 1);
          const applyPasses = Math.max(snap.applyPassCount, 1);
          const measured: Result = {
            ...snap,
            decodeUsPerPass: (snap.decodeMs * 1000) / decodePasses,
            applyUsPerPass: (snap.applyMs * 1000) / applyPasses,
          };
          console.log('[view-props-benchmark]', {
            mode: runMode,
            iterations: ITERATIONS,
            warmup: WARMUP,
            decodeMs: Number(measured.decodeMs.toFixed(2)),
            applyMs: Number(measured.applyMs.toFixed(2)),
            decodeUsPerPass: Number(measured.decodeUsPerPass.toFixed(2)),
            applyUsPerPass: Number(measured.applyUsPerPass.toFixed(2)),
            decodedPropCount: measured.decodedPropCount,
            legacyPropCount: measured.legacyPropCount,
            decodePassCount: measured.decodePassCount,
            applyPassCount: measured.applyPassCount,
          });
          setResult(measured);
          setRunning(false);
        });
      }
    };
    requestAnimationFrame(tick);
  }, []);

  const props = propsForPass(pass, mode);

  return (
    <ScrollView
      style={{ backgroundColor: theme.background.screen }}
      contentContainerStyle={styles.container}>
      <Text style={[styles.heading, { color: theme.text.default }]}>
        View-props decoding benchmark
      </Text>
      <Text style={[styles.note, { color: theme.text.secondary }]}>
        Warmup {WARMUP}, measured {ITERATIONS} passes. Build with EXPO_JSI_VIEW_PROPS=1 (then
        again =0) and compare. With the flag off, decodeMs stays 0 and all cost lands in applyMs.
        {'\n\n'}"All props" changes every prop each pass (worst case). "1 prop" changes only one
        prop per pass (realistic update) — decode/apply should touch ~1 prop, not all.
      </Text>

      <View style={[styles.viewHost, { borderColor: theme.border.default }]}>
        <BenchmarkView style={styles.benchView} {...props} />
      </View>

      <Button
        title={running ? 'Running…' : 'Run — all props change'}
        onPress={() => run('all')}
        disabled={running}
      />
      <Button
        title={running ? 'Running…' : 'Run — 1 prop changes'}
        onPress={() => run('single')}
        disabled={running}
      />

      {result ? (
        <View style={styles.results}>
          <Row label="mode" value={mode} />
          <Row label="decode total (JS thread)" value={`${result.decodeMs.toFixed(2)} ms`} />
          <Row label="apply total (main thread)" value={`${result.applyMs.toFixed(2)} ms`} />
          <Row label="decode / pass" value={`${result.decodeUsPerPass.toFixed(2)} µs`} />
          <Row label="apply / pass" value={`${result.applyUsPerPass.toFixed(2)} µs`} />
          <Row label="decoded props" value={`${result.decodedPropCount}`} />
          <Row label="legacy props" value={`${result.legacyPropCount}`} />
          <Row label="decode passes" value={`${result.decodePassCount}`} />
          <Row label="apply passes" value={`${result.applyPassCount}`} />
        </View>
      ) : null}
    </ScrollView>
  );

  function Row({ label, value }: { label: string; value: string }) {
    return (
      <View style={styles.row}>
        <Text style={{ color: theme.text.secondary }}>{label}</Text>
        <Text style={[styles.rowValue, { color: theme.text.default }]}>{value}</Text>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 12 },
  heading: { fontSize: 18, fontWeight: '600' },
  note: { fontSize: 12 },
  viewHost: { height: 80, borderWidth: StyleSheet.hairlineWidth },
  benchView: { flex: 1 },
  results: { marginTop: 12, gap: 6 },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  rowValue: { fontVariant: ['tabular-nums'], fontWeight: '600' },
});
