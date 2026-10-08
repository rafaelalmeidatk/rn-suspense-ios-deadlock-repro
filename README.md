# Suspense retry loop + iOS timer starvation = deadlock

A minimal reproduction of a hang in React Native apps on iOS. Two bugs combine to cause it:

1. **React (19.2.x):** a Suspense retry-lane render loop. Two or more sibling boundaries suspend on pending thrown promises, then an update re-renders only some of them. React then re-renders and commits them continuously, thousands of times per second, for as long as the promises stay pending. On its own this is "only" wasted CPU: in the browser, in Node and on Android the promises still resolve and the loop ends.
2. **React Native (iOS, bridgeless):** JS timers never fire while the RuntimeScheduler has a continuous chain of tasks. iOS delivers timers from a display link on the JS thread's run loop, and that run loop doesn't get a turn while tasks keep coming. Android keeps firing timers under the same load. On its own this only delays timers until JS goes idle.

**Together they deadlock.** The boundaries wait for data that resolves through `setTimeout` (RN's `fetch` resolves inside `setTimeout(0)`; so do tRPC batching and TanStack Query's `notifyManager`). The timers wait for the scheduler queue to drain. The queue never drains because React keeps looping on the suspended boundaries.

Tested with Expo SDK 57, React Native 0.86.3 and React 19.2.3 on an iPhone 16e (iOS 26.6.1, Expo Go), and on Android (Pixel 9 emulator, Expo Go). It was first seen in a production app on RN 0.83.6 / Expo SDK 55.

## Run it

```sh
npm install
npx expo start
```

Open it in **Expo Go on a physical iPhone**. The app shows the same step-by-step instructions on screen.

| Scenario                                                                                                                                | Expected               | iOS (actual)                                                                                                                               | Android                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| **Start (setTimeout)**: two boundaries suspend on a promise that resolves via `setTimeout(2000)`; a mount effect re-renders one of them | ✅ after 2s            | Never resolves (observed for 65s+). `setInterval(100)` ticks: **0**. `setTimeout(0)` probes never fire. React renders about 4,500 times/s. | Loops at about 2,800 renders/s, but timers fire, so it resolves at 2.0s and the loop stops |
| **Start (fetch)**: same, with a `fetch`                                                                                                 | ✅ quickly             | Same hang                                                                                                                                  | Resolves (0.2–1.3s)                                                                        |
| **Busy scheduler 10s (no React)**: 2ms tasks chained through the `scheduler` package for 10s                                            | Interval keeps ticking | **0** ticks in 10s; ticking resumes when the chain ends                                                                                    | 85 ticks in 10s (normal)                                                                   |

The stats box and buttons deliberately don't use React state (stats are written via `setNativeProps`, and the buttons are plain responder views). Any unrelated React commit, including a `Pressable`'s pressed state or a LogBox toast, un-suspends every pending retry lane at once, so they all render together and the loop ends. A touch that causes a React update can therefore "un-stick" the hang, which may explain reports like facebook/react-native#57592.

Optional remote logging: run `node log-sink.mjs` (port 4002) and start Metro with `EXPO_PUBLIC_LOG_SINK_URL=http://<your-LAN-IP>:4002/log`. Console logs also show up in Metro.

## RNTester (React Native `main`)

`rntester/RNTesterPlayground.js` is the same reproduction as an RNTester Playground. Copy it over `packages/rn-tester/js/examples/Playground/RNTesterPlayground.js` in the react-native repo, run RNTester on iOS, and open Playground. The steps are on screen. It has the same logic as the Expo app, which was verified on a physical iPhone, but I couldn't run RNTester itself (no Mac).

## The React loop without React Native

`node/` reproduces the loop with react-dom, jsdom and the real scheduler; no `act()` is involved:

```sh
cd node && npm install && npm run repro
```

```
t=500ms renders/s=27020 dom=loading Aloading B
t=1000ms renders/s=95950 dom=loading Aloading B
t=1500ms renders/s=95636 dom=loading Aloading B
t=2000ms renders/s=97526 dom=loadedloaded
t=2501ms renders/s=0 dom=loadedloaded
```

It loops on react-dom 19.2.0, 19.2.8 and 19.3.0-canary, in dev and prod builds. It doesn't loop with `use(promise)`, and it doesn't loop when a single update re-renders every suspended boundary.

## Mechanism (React side)

1. On mount, boundaries A and B suspend and claim retry lanes Ra and Rb. The commit marks both suspended.
2. Before the retry-lane prerender pass runs, the mount effect's update re-renders A only. A suspends again and claims Rc.
3. `markRootFinished` sets `root.suspendedLanes = NoLanes`, then re-suspends only this commit's new retry lane (Rc). **Rb is still pending but no longer suspended.**
4. Rb renders as a normal (non-prerender) render, so B suspends again, gets `ScheduleRetry` and claims a new lane. That commit clears `suspendedLanes` again, and Rc is now unsuspended. The two boundaries alternate forever.

## Candidate React fix (verified on device)

`patches/react-ReactFiberLane.diff`: in `markRootFinished`, keep a retry lane suspended when it was already suspended, isn't pinged, is still pending, and wasn't part of this commit. Anything that can unblock it already goes through `markRootUpdated` or `markRootPinged`.

- **React's test suite:** it passes at v19.2.0. One existing `ReactSiblingPrerendering` test needs one fewer redundant render, which its TODO already anticipated.
- **On the iPhone:** with the equivalent change applied to RN's bundled renderer (`patches/react-retry-lane-fix.ReactFabric-dev.patch`), this app resolves at 2.0s after 7 renders, and timers keep ticking.

```sh
patch -p1 < patches/react-retry-lane-fix.ReactFabric-dev.patch
```

React PR facebook/react#37586 (which shares one retry lane per render) does not stop this loop.
