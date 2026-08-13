# Changelog

## 3.5.0 - Unreleased

The React Compiler and server-rendering release. No API removals.

### Added

- **`createMachineScope(factory, name?)`** in `@bkincz/clutch/react`: returns a
  `Provider` that creates one machine per mount and a `useScopedMachine` hook
  that reads it. A module-level machine is one object per process, so on a
  server every concurrent request renders against the same state; a scope gives
  each render tree its own instance. This is separate from `persist`'s
  `deferred` option, which only defers storage access.
- The provider takes an optional `state` prop, merged in before the first
  render so children never observe an empty store, and re-applied when it
  changes by value. Rebuilding an equal object during a parent re-render does
  not re-seed, so writes made in between survive.
- **`ctx.notify()` on `PluginContext`.** Publishes a change a plugin exposes
  through its own API without touching state, so plugin-backed hooks re-render
  on flags that live outside the store.
- **`StandardSchemaV1` is exported from the main entry.** `validate` and `sync`
  have accepted a schema since 3.3, but the type was not importable, so nothing
  wrapping either could be typed.

### Fixed

- **`forceSave()` now notifies subscribers.** `useAutosave().hasUnsavedChanges`
  stayed `true` in the UI after a successful manual save, because clearing the
  dirty flag published nothing.
- **`loadFromServer()` clears the dirty flag before replacing state**, so a
  subscriber woken by the replacement no longer reads the pre-load flag.
- **`useSlice` and `useRegistrySlice` no longer keep a mirror of state in a
  ref.** Both now run through `useSyncExternalStoreWithSelector`, which is what
  React expects an external store to use and what the React Compiler can
  verify. Same behavior for a stable selector; an inline selector that changes
  identity every render is now re-run on read rather than serving the previous
  value.
- **`useHydration` and `useAutosave` read through `useSyncExternalStore`**
  instead of copying plugin flags into local state from an effect.

### Changed

- **New runtime dependency: `use-sync-external-store`** (the official shim,
  around 1 KB). Adds `useSyncExternalStoreWithSelector`, which React does not
  export directly.
- **`immer` is now `^11.1.16`**, up from an open `>=9.0.0`. The old range let a
  consumer resolve immer 9 against a build tested on 11.
- **Node 22.12 is the floor** (`engines`), and the toolchain moved to
  TypeScript 6, ESLint 10, and vitest 4. Emitted output targets are unchanged.

### Sizes

Minified + brotli, dependencies included: core-only import 5.8 KB, full bundle
10.7 KB, React hooks 2.0 KB, WebSocket sync 1.1 KB.

## 3.3.1 - 2026-07-10

- **Standard Schema moved out of `validate`** into its own module, so more than
  one plugin can accept a schema.
- **`sync({ schema })`.** A remote update that fails the schema is dropped and
  reported through the machine's error channel instead of being applied. One
  misconfigured tab can no longer poison every other tab's state.

## 3.3.0 - 2026-07-10

- **`validate` accepts a Standard Schema** (zod, valibot, arktype, anything
  implementing the spec) in place of a predicate. Issues come back as the
  rejection message.
- **`sharedMachine({ version, migrate })`.** When apps on one page disagree on
  the state shape, the higher version migrates the shared state in place
  instead of only warning. Downgrades, missing `migrate`, and a throwing
  `migrate` each warn and leave the state alone. `version` takes precedence
  over `contract`, which can only report a mismatch.
- **`machine.replaceState(state, meta?)`** is public, which is what makes an
  external migration possible.

## 3.2.0 - 2026-07-06

The performance and durability release.

- **`machine.set(partial)`**: shallow merge without immer, roughly 7x faster
  than `mutate` on hot paths. Patches are synthesized per changed key, so
  history, persist, sync, and devtools treat it like any other commit.
- **`persist` versioning**: `version` and `migrate(oldState, fromVersion)`
  config. Persisted state from a different version migrates on hydrate, or is
  discarded with a warning when no migration exists. Pre-versioning state
  counts as version 0.
- **Selector subscriptions**: `machine.subscribe(selector, listener,
  equalityFn?)` fires with `(selected, previous)` only when the selection
  changes. The single-listener form is unchanged.
- **`batch` accepts a single recipe** as well as an array.
- **`validate` can return a string** to reject with that message instead of
  the generic one.
- Machines without plugins skip immer patch generation, roughly doubling
  `mutate` throughput for bare stores.
- `enablePatches()` now runs when the first machine is created instead of at
  import time, so importing clutch no longer flips a global immer switch.
- The object passed as `initialState` is deep-frozen, so external mutation of
  it can no longer corrupt what `reset()` restores.

## 3.1.0 - 2026-07-06

The micro-frontend release. Added `sharedMachine(key, factory, options?)`:
creates a machine once per page and returns the same instance to every caller
of the same key, no matter which bundle asks. Built for independently deployed
apps sharing one page, like Module Federation remotes. The registry lives on
`globalThis` and instances are used structurally, so it survives apps bundling
separate copies of clutch. Pass `{ contract: n }` and clutch warns at runtime
when two apps disagree on the state shape version; mismatched clutch versions
across bundles are warned the same way. See the new "Micro frontends" section
in the README.

## 3.0.0 - 2026-06-11

The plugin release. The monolithic `StateMachine` is gone from the public API. The core
now does immutable updates and subscriptions only, and every feature is a plugin you
install with `.with()`. A counter app pays for a counter app, not for WebSocket sync code.

See the [migration guide](./docs/migration-v3.md).

### Breaking

- **`createStateMachine` / `StateMachine` replaced by `createMachine` + plugins.**
  Undo/redo, persistence, DevTools, sync, validation, and autosave are now `history()`,
  `persist()`, `devtools()`, `sync()`, `validate()`, and `autosave()`. Methods only exist
  on the machine (and in its type) when the plugin is installed.
- **`createV2Machine(config)` is the bridge.** Takes a v2 `StateConfig`, assembles the
  matching plugins, and restores the v2 surface including recipe middleware, `on()`,
  `hydrateFromPersisted()`, and `applyPatchSet()`. Use it to migrate one import now and
  unwind at your own pace.
- **Subclassing for server persistence is gone.** `saveToServer`/`loadFromServer`
  overrides become `autosave({ save, load })` callbacks (also accepted by
  `createV2Machine`).
- **`StateRegistry` replaced by `createRegistry(machines)`.** Machines are fixed at
  creation and typed per entry, so `registry.machines.user.undo()` compiles only when
  user actually has history. Coordination methods (`forceSaveAll`, `clearAllHistory`, new
  `hydrateAll`/`flushAll`) only reach machines with the matching plugin.
- **React hooks renamed.** `useStateMachine` is now `useMachine`, `useStateSlice` is
  `useSlice`, `useStateHistory` is `useMachineHistory`, `useStatePersist` is
  `useAutosave`, `useDeferredHydration` is `useHydration`. Hooks no longer hydrate
  automatically and the plugin hooks type-require their plugin.
- **`StateMachineError` is now `MachineError`**, same `code` field.
- **`enableLogging` removed.** No built-in logger in v3.

### Added

- **Public plugin interface.** `Plugin<T, Ext>` with `onInit`, `onBeforeCommit` (throw to
  veto), `onCommit`, `onExternalState`, `onError`, and `onDestroy`. Whatever `onInit`
  returns is merged onto the machine and its type. Write your own persistence,
  transport, or logging in userland.
- **`persist({ storage })`** accepts any getItem/setItem/removeItem object, so IndexedDB
  wrappers and test doubles plug straight in.
- **`sync({ autoStart: false })` + `startSync()`** for SSR flows, replacing v2's hidden
  hydration/sync ordering with an explicit call.
- **`autosave({ auto: false })`** for manual-save-only setups.

### Fixed

- **Listeners now fire after plugins update their bookkeeping.** In v2-style setups a
  React snapshot read during notification could see stale undo/dirty flags. The commit
  order is now state, plugins, subscribers.

### Sizes

Minified + brotli, Immer included: core-only import 4.5 KB (was 9.8 KB in v2), full
bundle 8.3 KB, React hooks 0.8 KB.

## 2.0.0 - 2026-06-10

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

## 1.4.0 - 2026-06-06

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
