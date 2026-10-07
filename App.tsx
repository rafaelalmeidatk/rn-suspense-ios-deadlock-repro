import { type ReactNode, Suspense, useEffect, useState } from "react"
import { Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
import {
  unstable_NormalPriority as NormalPriority,
  unstable_scheduleCallback as scheduleCallback,
} from "scheduler"

const LOG_SINK_URL = process.env.EXPO_PUBLIC_LOG_SINK_URL
const FETCH_URL = process.env.EXPO_PUBLIC_FETCH_URL ?? "https://reactnative.dev/"
const RESOLVE_AFTER_MS = 2000

type Source = "setTimeout" | "fetch"
type Resource = Promise<string> & { status?: "fulfilled"; value?: string }

let queuedLogLines: string[] = []
function log(line: string) {
  console.log(line)
  if (!LOG_SINK_URL) return
  if (queuedLogLines.push(`[${Platform.OS}] ${line}`) > 1) return
  queueMicrotask(() => {
    const xhr = new XMLHttpRequest()
    xhr.open("POST", LOG_SINK_URL)
    xhr.setRequestHeader("Content-Type", "text/plain")
    xhr.send(queuedLogLines.join("\n"))
    queuedLogLines = []
  })
}

const stats = {
  startedAt: 0,
  resolvedAt: 0,
  dataRenders: 0,
  intervalTicks: 0,
  rateWindowStart: 0,
  rateWindowRenders: 0,
}

function sinceStart() {
  return `${((Date.now() - stats.startedAt) / 1000).toFixed(1)}s`
}

function createResource(source: Source): Resource {
  const promise: Resource =
    source === "setTimeout"
      ? new Promise((resolve) =>
          setTimeout(() => resolve(`setTimeout(${RESOLVE_AFTER_MS})`), RESOLVE_AFTER_MS),
        )
      : fetch(FETCH_URL).then((response) => `fetch ${response.status}`)
  promise.then((value) => {
    stats.resolvedAt = Date.now()
    log(`RESOLVED via ${value} at ${sinceStart()} (renders so far ${stats.dataRenders})`)
    Object.assign(promise, { status: "fulfilled", value })
  })
  return promise
}

function recordDataRender() {
  stats.dataRenders++
  stats.rateWindowRenders++
  const now = Date.now()
  if (now - stats.rateWindowStart >= 1000) {
    log(
      `t=${sinceStart()} Data renders in last ${now - stats.rateWindowStart}ms: ${stats.rateWindowRenders}`,
    )
    stats.rateWindowStart = now
    stats.rateWindowRenders = 0
  }
}

function Data({ resource }: { resource: Resource }) {
  recordDataRender()
  // Thrown like TanStack Query's useSuspenseQuery; `use(resource)` does not trigger the loop.
  if (resource.status !== "fulfilled") throw resource
  return <Text style={styles.loaded}>✅ {resource.value}</Text>
}

function Loading({ label }: { label: string }) {
  return <Text style={styles.loading}>⏳ {label} loading…</Text>
}

// The trigger: both boundaries suspend on mount, then this mount effect re-renders only boundary A
// while the retry lanes from the mount are still pending.
function UpdatesOnMount({ resource }: { resource: Resource }) {
  const [, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  return (
    <Suspense fallback={<Loading label="A" />}>
      <Data resource={resource} />
    </Suspense>
  )
}

function Scenario({ resource }: { resource: Resource }) {
  return (
    <View style={styles.card}>
      <UpdatesOnMount resource={resource} />
      <Suspense fallback={<Loading label="B" />}>
        <Data resource={resource} />
      </Suspense>
    </View>
  )
}

// Stats and buttons avoid React state (and Pressable's pressed state) on purpose: any unrelated
// React commit un-suspends every pending retry lane at once, which ends the loop being measured.
function TapTarget({
  onTap,
  style,
  children,
}: {
  onTap: () => void
  style: object
  children: ReactNode
}) {
  return (
    <View style={style} onStartShouldSetResponder={() => true} onResponderRelease={onTap}>
      {children}
    </View>
  )
}

let probeCount = 0
const probes: { id: number; scheduledAt: number; firedAt?: number }[] = []
let statsInput: TextInput | null = null

function renderStats() {
  const now = Date.now()
  const lines = [
    `Since start: ${stats.startedAt ? sinceStart() : "-"}`,
    `setInterval(100) ticks: ${stats.intervalTicks}`,
    `Data renders: ${stats.dataRenders}`,
    `Data resolved: ${stats.resolvedAt ? `yes, at ${((stats.resolvedAt - stats.startedAt) / 1000).toFixed(1)}s` : "no"}`,
    ...probes.map(
      (probe) =>
        `setTimeout(0) probe #${probe.id}: ${probe.firedAt ? `fired after ${probe.firedAt - probe.scheduledAt}ms` : `NOT fired (${now - probe.scheduledAt}ms)`}`,
    ),
    `Updated at ${new Date(now).toISOString().slice(11, 23)}`,
  ]
  statsInput?.setNativeProps({ text: lines.join("\n") })
}

function probeTimers() {
  const probe = {
    id: ++probeCount,
    scheduledAt: Date.now(),
    firedAt: undefined as number | undefined,
  }
  probes.push(probe)
  if (probes.length > 3) probes.shift()
  setTimeout(() => {
    probe.firedAt = Date.now()
    log(`probe #${probe.id} setTimeout(0) fired after ${probe.firedAt - probe.scheduledAt}ms`)
    renderStats()
  }, 0)
  log(
    `TAP #${probe.id} at ${sinceStart()}: dataRenders=${stats.dataRenders} intervalTicks=${stats.intervalTicks} resolved=${stats.resolvedAt > 0}`,
  )
  renderStats()
}

function Stats() {
  return (
    <TapTarget style={styles.stats} onTap={probeTimers}>
      <Text style={styles.statsTitle}>Tap here to refresh stats</Text>
      <TextInput
        ref={(input) => {
          statsInput = input
        }}
        editable={false}
        multiline
        scrollEnabled={false}
        pointerEvents="none"
        style={styles.statsText}
        defaultValue="Tap Start, then tap here"
      />
    </TapTarget>
  )
}

const BUSY_FOR_MS = 10000
const BUSY_TASK_MS = 2

function startBusyScheduler() {
  resetStats()
  log(`START busy scheduler for ${BUSY_FOR_MS}ms ${Platform.OS} ${Platform.Version}`)
  const until = Date.now() + BUSY_FOR_MS
  let tasks = 0
  let windowStart = Date.now()
  let windowTasks = 0
  function task() {
    tasks++
    windowTasks++
    const taskEnd = Date.now() + BUSY_TASK_MS
    while (Date.now() < taskEnd) {}
    if (Date.now() - windowStart >= 1000) {
      log(
        `t=${sinceStart()} scheduler tasks in last ${Date.now() - windowStart}ms: ${windowTasks}, interval ticks so far ${stats.intervalTicks}`,
      )
      windowStart = Date.now()
      windowTasks = 0
    }
    if (Date.now() < until) scheduleCallback(NormalPriority, task)
    else
      log(
        `busy scheduler done after ${tasks} tasks, interval ticks during it: ${stats.intervalTicks}`,
      )
  }
  scheduleCallback(NormalPriority, task)
}

function resetStats() {
  Object.assign(stats, {
    startedAt: Date.now(),
    resolvedAt: 0,
    dataRenders: 0,
    intervalTicks: 0,
    rateWindowStart: Date.now(),
    rateWindowRenders: 0,
  })
}

export default function App() {
  const [resource, setResource] = useState<Resource | null>(null)
  const [runId, setRunId] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => {
      stats.intervalTicks++
      if (stats.intervalTicks % 5 === 0) renderStats()
      if (stats.intervalTicks % 10 === 0)
        log(`interval tick ${stats.intervalTicks} at ${sinceStart()}`)
    }, 100)
    return () => clearInterval(interval)
  }, [])

  function start(source: Source) {
    resetStats()
    log(`START source=${source} ${Platform.OS} ${Platform.Version}`)
    setResource(createResource(source))
    setRunId((id) => id + 1)
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <Text style={styles.title}>Suspense retry loop + timers</Text>
      <View style={styles.row}>
        <TapTarget style={styles.button} onTap={() => start("setTimeout")}>
          <Text style={styles.buttonText}>Start (setTimeout)</Text>
        </TapTarget>
        <TapTarget style={styles.button} onTap={() => start("fetch")}>
          <Text style={styles.buttonText}>Start (fetch)</Text>
        </TapTarget>
      </View>
      <View style={styles.row}>
        <TapTarget style={styles.button} onTap={startBusyScheduler}>
          <Text style={styles.buttonText}>Busy scheduler 10s (no React)</Text>
        </TapTarget>
      </View>
      {resource && <Scenario key={runId} resource={resource} />}
      <Stats />
      <Instructions />
    </ScrollView>
  )
}

const scenarios: {
  title: string
  steps: string[]
  expected: string
  actualIos: string
  actualAndroid: string
}[] = [
  {
    title: "1. Suspense deadlock",
    steps: [
      'Tap "Start (setTimeout)".',
      "Don't touch the screen for 10 seconds; watch the gray stats box.",
      "Tap the gray box once, wait 3 seconds, and tap it again. Each tap schedules a setTimeout(0) probe.",
    ],
    expected:
      "A and B show ✅ after about 2s. setInterval ticks keep increasing. Every probe fires.",
    actualIos:
      "A and B stay loading forever. The gray box freezes and setInterval ticks stay at 0. Probes show NOT fired. Data renders grow by thousands per second.",
    actualAndroid:
      "Data renders also grow by thousands per second, but timers keep firing, so the data resolves at 2s and the loop stops.",
  },
  {
    title: "2. Same with fetch",
    steps: [
      "Reload the app (the JS thread is stuck after step 1).",
      'Tap "Start (fetch)" and watch the gray box.',
    ],
    expected: 'A and B show ✅ "fetch 200" within a second or so.',
    actualIos: "Same hang: fetch resolves through setTimeout, so it never resolves.",
    actualAndroid: "Resolves normally.",
  },
  {
    title: "3. iOS timers alone (no React)",
    steps: [
      "Reload the app.",
      'Tap "Busy scheduler 10s (no React)". For 10s it chains 2ms tasks through the scheduler package (RN\'s RuntimeScheduler).',
      "Don't touch the screen; watch setInterval ticks.",
    ],
    expected: "setInterval keeps ticking (about 10/s) during the 10s.",
    actualIos:
      "setInterval ticks stay at 0 for the whole 10s and resume only after the task chain ends.",
    actualAndroid: "About 85 ticks during the 10s.",
  },
]

function Instructions() {
  return (
    <View style={styles.instructions}>
      <Text style={styles.instructionsTitle}>How to reproduce (use a physical iPhone)</Text>
      {scenarios.map((scenario) => (
        <View key={scenario.title} style={styles.scenario}>
          <Text style={styles.scenarioTitle}>{scenario.title}</Text>
          {scenario.steps.map((step) => (
            <Text key={step}>• {step}</Text>
          ))}
          <Text>
            <Text style={styles.label}>Expected: </Text>
            {scenario.expected}
          </Text>
          <Text>
            <Text style={styles.label}>Actual on iOS: </Text>
            {scenario.actualIos}
          </Text>
          <Text>
            <Text style={styles.label}>Android: </Text>
            {scenario.actualAndroid}
          </Text>
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#fff" },
  container: {
    paddingTop: 80,
    paddingBottom: 40,
    paddingHorizontal: 16,
    gap: 16,
  },
  title: { fontSize: 20, fontWeight: "600" },
  row: { flexDirection: "row", gap: 12 },
  button: {
    backgroundColor: "#2563eb",
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  buttonText: { color: "#fff", fontWeight: "600" },
  card: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 8,
    padding: 12,
    gap: 8,
  },
  loading: { fontSize: 16, color: "#a16207" },
  loaded: { fontSize: 16, color: "#15803d" },
  stats: { backgroundColor: "#f1f5f9", borderRadius: 8, padding: 12, gap: 4 },
  statsTitle: { fontWeight: "600" },
  statsText: { fontSize: 14, color: "#0f172a", padding: 0 },
  instructions: { gap: 12 },
  instructionsTitle: { fontSize: 17, fontWeight: "600" },
  scenario: { gap: 4 },
  scenarioTitle: { fontWeight: "600" },
  label: { fontWeight: "600" },
})
