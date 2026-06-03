import * as React from 'react';
import { Button, ScrollView, StyleSheet, Text, View } from 'react-native';

import BenchmarkView from './BenchmarkView';
import BenchmarkingModule, { type ViewPropsBenchmark } from './BenchmarkingExpoModule';

// How many prop-update passes to run in a measured batch (after warmup).
const ITERATIONS = 2000;
// Discarded warmup passes so component registration / first-allocation costs don't pollute
// the measured window.
const WARMUP = 200;

/**
 * Builds a fresh set of prop values for pass `i`. Every value changes each pass so the view's
 * change-detection (`previousProps`) never short-circuits and the decode/apply path actually
 * runs for every prop.
 */
function propsForPass(i: number) {
  return {
    color: i % 2 === 0 ? '#ff0000' : '#00ff00',
    decoration: {
      opacity: (i % 100) / 100,
      cornerRadius: i % 24,
      label: `label-${i}`,
      weight: i % 7,
    },
    values: [i, i + 1, i + 2, i + 3, i + 4],
    flag: i % 2 === 0,
    count: i,
    ratio: (i % 50) / 50,
    title: `title-${i}`,
    subtitle: `subtitle-${i}`,
  };
}

type Result = ViewPropsBenchmark & {
  decodeUsPerPass: number;
  applyUsPerPass: number;
};

export default function ViewPropsBenchmarkScreen() {
  const [pass, setPass] = React.useState(0);
  const [running, setRunning] = React.useState(false);
  const [result, setResult] = React.useState<Result | null>(null);

  // Drives ITERATIONS+WARMUP passes via rAF, resetting the native counters right after warmup
  // so only the steady-state window is measured. We bump `pass` each frame; the rendered
  // BenchmarkView receives fresh props, which flows through Fabric → cloneProps (decode) →
  // finalizeUpdates (apply).
  const run = React.useCallback(() => {
    setResult(null);
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

  const props = propsForPass(pass);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.heading}>View-props decoding benchmark</Text>
      <Text style={styles.note}>
        Warmup {WARMUP}, measured {ITERATIONS} passes. Build with EXPO_JSI_VIEW_PROPS=1 (then
        again =0) and compare. With the flag off, decodeMs stays 0 and all cost lands in
        applyMs.
      </Text>

      <View style={styles.viewHost}>
        <BenchmarkView style={styles.benchView} {...props} />
      </View>

      <Button title={running ? 'Running…' : 'Run benchmark'} onPress={run} disabled={running} />

      {result ? (
        <View style={styles.results}>
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
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 12 },
  heading: { fontSize: 18, fontWeight: '600' },
  note: { fontSize: 12, color: '#666' },
  viewHost: { height: 80, borderWidth: StyleSheet.hairlineWidth, borderColor: '#ccc' },
  benchView: { flex: 1 },
  results: { marginTop: 12, gap: 6 },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  rowLabel: { color: '#333' },
  rowValue: { fontVariant: ['tabular-nums'], fontWeight: '600' },
});
