# Changelog

## 2.0.0 — 2026-06-10

Performance and simplicity pass. Several breaking changes. no deprecation shims, 
just straight raw dogging this release.

### Breaking

- **React hooks removed from the main entry.** Import them from `@bkincz/clutch/react`.
  The main entry is now React-free, so CJS consumers without React can `require()` it.
- **`autoSaveInterval` (minutes) → `autoSaveIntervalMs`.** It was the only duration in
  the API not in milliseconds. `setAutoSaveInterval()` now also takes ms.
- **`subscribe()` no longer invokes the listener immediately.** Listeners fire on the
  next state change. `useSyncExternalStore` never needed the initial call; it cost one
  wasted render per mount.
- **Persisted-state `checksum` and `version` fields removed.** The checksum was
  computed on every save but a mismatch on load only logged a warning. It's all cost and no
  protection. Old persisted blobs still load fine (extra fields are ignored).
- **`StateHistoryInfo.memoryUsage` removed.** It serialized the entire history on every
  read. More specifically every render with `useStateHistory`.
- **Middleware is now explicitly synchronous** (`=> void`, not `=> void | Promise<void>`).
  Async middleware never worked lol. The Immer draft is revoked when `produce` returns and 
  the 5s "timeout protection" could never fire for sync code. Now both are removed.
- **Notifications are synchronous.** The 16ms notify debounce caused controlled-input
  cursor jumps.

### Added

- **`createStateMachine(config)` factory** bye-bye subclass boilerplate. `StateMachine` is
  no longer abstract, so `new StateMachine(config)` works too. Subclassing is only for
  overriding `saveToServer`/`loadFromServer`.
- **`applyPatchSet(patches, description?)`** apply Immer patches as a regular
  mutation (middleware, history, sync, DevTools included).

### Fixed

- **Undo/redo now broadcast to sync and DevTools.** TDLR; this broke constantly Previously 
  two tabs diverged permanently after one tab undid a change, and the DevTools timeline 
  missed them.
- **`useStateHistory` no longer returns a fresh snapshot every read** history info is
  cached until history changes, fixing React's "getSnapshot should be cached" loop.
- **`useStateSlice`/`useRegistrySlice` no longer serve stale values when the selector
  changes** the selector is re-run on every read. The previous reference is reused
  when results are equal so re-renders are still skipped.
- **`useOptimisticUpdate` rollback reverts only the optimistic change** (via inverse
  patches) instead of undoing every mutation that happened since.
- **Persistence write race removed** writes are synchronous again (the async checksum
  could land out of order under rapid mutations).

### Performance

- **localStorage writes are debounced (300ms, trailing)** instead of on every mutation,
  with guaranteed flushes on `pagehide` and `destroy()`. Typing/dragging no longer
  serializes state per keystroke.
- immer removed from `peerDependencies` (kept as a regular dependency) no more risk
  of two immer copies in one app.

## 1.4.0 — 2026-06-06

I want the ability to sync via Websockets

### Added

- **Pluggable sync transports.** `SyncConfig` accepts `transport: SyncTransport`.
  `BroadcastChannelTransport` remains the built-in default with unchanged behavior.
  `SyncTransport`, `TransportStatus`, `BroadcastChannelTransport`, and
  `BroadcastChannelTransportConfig` are exported from the main entry.
- **WebSocket server sync** via the new opt-in `@bkincz/clutch/sync-ws` entry point.
  `WebSocketTransport` ships auto-reconnect with jittered exponential backoff,
  ping/pong heartbeats, bounded offline queueing, and query-param or first-frame
  auth. Cross-machine ordering uses server-assigned monotonic versions instead of
  client timestamps. Version gaps in patch streams trigger an automatic full resync.
  Wire protocol and reference server pseudocode documented in `docs/sync-protocol.md`
  for now since I have no idea where to put this info.

### Fixed

- With `deferredHydration: true`, sync now starts at `hydrateFromPersisted()` instead
  of construction. Previously a remote full-sync response could land on unhydrated
  state and overwrite the persisted state before hydration read it.
- `StateSyncManager` now calls Immer's `enablePatches()` itself instead of relying on
  `StateMachine`'s module side effect. Patch application no longer breaks when the
  sync manager is used standalone.
- Inbound `full_sync` requests are no longer subject to the timestamp-window check
  (they carry no state, a clock-skewed client must still be able to request a resync).

### Tooling

- Fixed `npm run size` (bumped `size-limit` 8 → 11 to match the installed preset) and
  added a 4 KB budget for the new `sync-ws` entry.
