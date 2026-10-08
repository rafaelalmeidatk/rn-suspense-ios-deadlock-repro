/**
 * Drop-in replacement for packages/rn-tester/js/examples/Playground/RNTesterPlayground.js
 * Reproduces: iOS JS timers never fire while the RuntimeScheduler runs a continuous task chain,
 * and the resulting deadlock with React's Suspense retry loop.
 *
 * @flow
 * @format
 */

import type {RNTesterModuleExample} from '../../types/RNTesterTypes';
import type {ViewStyleProp} from 'react-native/Libraries/StyleSheet/StyleSheet';

import * as React from 'react';
import {Suspense, useEffect, useState} from 'react';
import {Platform, StyleSheet, Text, TextInput, View} from 'react-native';
import {
  unstable_NormalPriority as NormalPriority,
  unstable_scheduleCallback as scheduleCallback,
} from 'scheduler';

const RESOLVE_AFTER_MS = 2000;
const BUSY_FOR_MS = 10000;
const BUSY_TASK_MS = 2;

const stats = {startedAt: 0, resolvedAt: 0, dataRenders: 0, intervalTicks: 0};
type Probe = {id: number, scheduledAt: number, firedAt: ?number};

const probes: Array<Probe> = [];
let probeCount = 0;
let statsInput: ?React.ElementRef<typeof TextInput> = null;

function sinceStart(): string {
  return `${((Date.now() - stats.startedAt) / 1000).toFixed(1)}s`;
}

function resetStats() {
  stats.startedAt = Date.now();
  stats.resolvedAt = 0;
  stats.dataRenders = 0;
  stats.intervalTicks = 0;
}

function renderStats() {
  const now = Date.now();
  const lines = [
    `Since start: ${stats.startedAt ? sinceStart() : '-'}`,
    `setInterval(100) ticks: ${stats.intervalTicks}`,
    `Data renders: ${stats.dataRenders}`,
    `Data resolved: ${stats.resolvedAt ? `yes, at ${((stats.resolvedAt - stats.startedAt) / 1000).toFixed(1)}s` : 'no'}`,
    ...probes.map(
      probe =>
        `setTimeout(0) probe #${probe.id}: ${probe.firedAt != null ? `fired after ${probe.firedAt - probe.scheduledAt}ms` : `NOT fired (${now - probe.scheduledAt}ms)`}`,
    ),
  ];
  statsInput?.setNativeProps({text: lines.join('\n')});
}

function probeTimers() {
  const probe: Probe = {
    id: ++probeCount,
    scheduledAt: Date.now(),
    firedAt: null,
  };
  probes.push(probe);
  if (probes.length > 3) {
    probes.shift();
  }
  setTimeout(() => {
    probe.firedAt = Date.now();
    renderStats();
  }, 0);
  renderStats();
}

type Resource = {promise: Promise<string>, value: ?string};

function createResource(): Resource {
  const resource: Resource = {
    promise: new Promise(resolve =>
      setTimeout(() => resolve('resolved'), RESOLVE_AFTER_MS),
    ),
    value: null,
  };
  void resource.promise.then(value => {
    stats.resolvedAt = Date.now();
    console.log(
      `RESOLVED at ${sinceStart()} after ${stats.dataRenders} renders`,
    );
    resource.value = value;
  });
  return resource;
}

function Data({resource}: {resource: Resource}): React.Node {
  stats.dataRenders++;
  // Thrown like TanStack Query's useSuspenseQuery; `use(resource.promise)` does not trigger the loop.
  if (resource.value == null) {
    throw resource.promise;
  }
  return <Text style={styles.loaded}>✅ {resource.value}</Text>;
}

// The trigger: both boundaries suspend on mount, then this mount effect re-renders only boundary A
// while the retry lanes from the mount are still pending.
function UpdatesOnMount({resource}: {resource: Resource}): React.Node {
  const [, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <Suspense fallback={<Text style={styles.loading}>⏳ A loading…</Text>}>
      <Data resource={resource} />
    </Suspense>
  );
}

function startBusyScheduler() {
  resetStats();
  const until = Date.now() + BUSY_FOR_MS;
  let tasks = 0;
  function task() {
    tasks++;
    const taskEnd = Date.now() + BUSY_TASK_MS;
    while (Date.now() < taskEnd) {}
    if (Date.now() < until) {
      scheduleCallback(NormalPriority, task);
    } else {
      console.log(
        `busy scheduler: ${tasks} tasks in ${BUSY_FOR_MS}ms, interval ticks during it: ${stats.intervalTicks}`,
      );
    }
  }
  scheduleCallback(NormalPriority, task);
}

// Buttons and stats avoid React state (and Pressable's pressed state) on purpose: any unrelated
// React commit un-suspends every pending retry lane at once, which ends the loop being measured.
function TapTarget({
  onTap,
  style,
  children,
}: {
  onTap: () => void,
  style: ViewStyleProp,
  children: React.Node,
}): React.Node {
  return (
    <View
      style={style}
      onStartShouldSetResponder={() => true}
      onResponderRelease={onTap}>
      {children}
    </View>
  );
}

function Playground(): React.Node {
  const [resource, setResource] = useState<?Resource>(null);
  const [runId, setRunId] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      stats.intervalTicks++;
      if (stats.intervalTicks % 5 === 0) {
        renderStats();
      }
    }, 100);
    return () => clearInterval(interval);
  }, []);

  function startSuspense() {
    resetStats();
    setResource(createResource());
    setRunId(id => id + 1);
  }

  return (
    <View style={styles.container}>
      <Text style={styles.help}>
        iOS, physical device or simulator. {'\n'}1. Tap "Suspense deadlock",
        don't touch the screen for 10s. Expected: A and B show ✅ after 2s.
        Actual on iOS: they stay loading, setInterval ticks stay at 0, and Data
        renders grow by thousands per second (Android resolves at 2s).
        {'\n'}2. Reload, tap "Busy scheduler 10s". Expected: setInterval keeps
        ticking. Actual on iOS: 0 ticks for 10s.{'\n'}Tap the gray box to
        schedule a setTimeout(0) probe.
      </Text>
      <View style={styles.row}>
        <TapTarget style={styles.button} onTap={startSuspense}>
          <Text style={styles.buttonText}>Suspense deadlock</Text>
        </TapTarget>
        <TapTarget style={styles.button} onTap={startBusyScheduler}>
          <Text style={styles.buttonText}>Busy scheduler 10s</Text>
        </TapTarget>
      </View>
      {resource != null && (
        <View key={runId} style={styles.card}>
          <UpdatesOnMount resource={resource} />
          <Suspense
            fallback={<Text style={styles.loading}>⏳ B loading…</Text>}>
            <Data resource={resource} />
          </Suspense>
        </View>
      )}
      <TapTarget style={styles.stats} onTap={probeTimers}>
        <TextInput
          ref={input => {
            statsInput = input;
          }}
          editable={false}
          multiline={true}
          scrollEnabled={false}
          pointerEvents="none"
          style={styles.statsText}
          defaultValue={`${Platform.OS}: tap a button to start`}
        />
      </TapTarget>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {padding: 10, gap: 12},
  help: {fontSize: 13},
  row: {flexDirection: 'row', gap: 12},
  button: {
    backgroundColor: '#2563eb',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  buttonText: {color: '#fff', fontWeight: '600'},
  card: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 12,
    gap: 8,
  },
  loading: {fontSize: 16, color: '#a16207'},
  loaded: {fontSize: 16, color: '#15803d'},
  stats: {backgroundColor: '#f1f5f9', borderRadius: 8, padding: 12},
  statsText: {fontSize: 14, color: '#0f172a', padding: 0},
});

export default {
  title: 'Playground',
  name: 'playground',
  description: 'Test out new features and ideas.',
  render: (): React.Node => <Playground />,
} as RNTesterModuleExample;
