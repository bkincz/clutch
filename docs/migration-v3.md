# Migrating from v2 to v3

> **Note:** Everything in this guide applies to `@bkincz/clutch@3.x` only. The `createV2Machine` bridge and all v2 APIs were removed in v4. If you are on v2, migrate to v3 with this guide first, then upgrade to v4.

v3 replaces the all-in-one `StateMachine` with a small core plus opt-in plugins. Every v2 feature still exists, but you now install only what you use.

There are two ways to migrate:

1. **The bridge.** Swap `createStateMachine` for `createV2Machine` and keep your config. Done in minutes, intended as a stopover for one release.
2. **The full migration.** Move to `createMachine` plus plugins. This is where the bundle savings and the better types are.

## 1. The bridge: createV2Machine

```typescript
// v2
import { createStateMachine } from '@bkincz/clutch'
const machine = createStateMachine(config)

// v3 bridge
import { createV2Machine } from '@bkincz/clutch'
const machine = createV2Machine(config)
```

`createV2Machine` accepts the whole v2 `StateConfig`, assembles the matching plugins, and restores the v2 method surface including `hydrateFromPersisted()`, `loadFromServerManually()`, `applyPatchSet()`, `on()`, and recipe middleware.

If you subclassed `StateMachine` to override the server hooks, pass them as config instead:

```typescript
const machine = createV2Machine({
  ...config,
  saveToServer: state => api.put('/state', state),
  loadFromServer: () => api.get('/state'),
})
```

Known differences from real v2, even with the bridge:

- `enableLogging` is ignored. v3 has no built-in logger.
- `isHydrated` is a method, not a getter: `machine.isHydrated()`.
- `undo()`/`redo()` no longer fire `afterMutate`.
- `validateState` rejects local mutations, but updates arriving from sync are only reported through `onError`, not rejected.
- `reset()` is not broadcast to sync peers.

## 2. The full migration

### Config options become plugins

```typescript
// v2
const machine = createStateMachine({
  initialState,
  maxHistorySize: 100,
  persistenceKey: 'app',
  persistenceFilter: { exclude: ['draft'] },
  validateState: isValid,
  enableDevTools: { name: 'App' },
  enableSync: true,
  autoSaveIntervalMs: 60_000,
})

// v3
const machine = createMachine({ initialState })
  .with(validate(isValid))
  .with(history({ maxSize: 100 }))
  .with(persist({ key: 'app', filter: { exclude: ['draft'] } }))
  .with(devtools({ name: 'App' }))
  .with(sync())
  .with(autosave({ save: state => api.put('/state', state), intervalMs: 60_000 }))
```

| v2 config | v3 plugin |
|---|---|
| `maxHistorySize` | `history({ maxSize })` |
| `persistenceKey`, `enablePersistence` | `persist({ key })` |
| `persistenceFilter` | `persist({ filter })` |
| `deferredHydration` | `persist({ deferred: true })` |
| `validateState` | `validate(fn)` |
| `enableDevTools` | `devtools(config)` |
| `enableSync` | `sync(config)` |
| `enableAutoSave`, `autoSaveIntervalMs` | `autosave({ save, intervalMs, auto })` |
| `saveToServer` / `loadFromServer` overrides | `autosave({ save, load })` |
| `middleware` | `onBeforeCommit` / `onCommit` in a custom plugin |
| `enableLogging` | removed |

Undo/redo, persistence methods, and save methods only exist on the machine when the matching plugin is installed. TypeScript enforces this.

### Renamed and moved methods

| v2 | v3 |
|---|---|
| `hydrateFromPersisted()` | `hydrate()`, then `startSync()` if you use sync with deferred hydration |
| `isHydrated` (getter) | `isHydrated()` (method) |
| `forceSave()` | `forceSave()` from `autosave`. It no longer also writes localStorage. Call `flush()` from `persist` for that |
| `loadFromServerManually()` | `loadFromServer()` |
| `applyPatchSet(patches)` | `machine.mutate(draft => applyPatches(draft, patches))` |
| `on('afterMutate' \| 'error' \| 'destroy')` | `onCommit` / `onError` / `onDestroy` hooks in a custom plugin |
| `getHistoryInfo()`, `clearHistory()` | unchanged, from `history` |
| `setAutoSaveInterval(ms)` | unchanged, from `autosave` |
| `StateMachineError` | `MachineError`, with the same `code` field |

### Middleware

v2 recipe middleware is replaced by plugin hooks. Validation belongs in `onBeforeCommit` (throw to reject), observation in `onCommit`:

```typescript
// v2
const logger: Middleware<S> = (ctx, next, draft) => {
  console.log('before', ctx.description)
  next(draft)
  console.log('after')
}

// v3
const logger: Plugin<S> = {
  name: 'logger',
  onCommit: payload => console.log(payload.description, payload.patches),
}
```

Middleware that rewrote drafts has no direct v3 equivalent. Wrap your recipes before passing them to `mutate`, or keep using `createV2Machine`, which still runs v2 middleware.

### SSR and deferred hydration

```typescript
// v2
const machine = createStateMachine({ initialState, persistenceKey: 'app', deferredHydration: true })
machine.hydrateFromPersisted() // on the client

// v3
const machine = createMachine({ initialState })
  .with(persist({ key: 'app', deferred: true }))
  .with(sync({ autoStart: false }))

machine.hydrate()    // on the client
machine.startSync()  // after hydration
```

Persisted data is compatible. v3 reads the same `{ state, timestamp }` envelope v2 wrote, under the same key.

### Registry

```typescript
// v2
const store = new StateRegistry<{ user: UserState }>()
store.register('user', userMachine)
const userState = store.getMachineState('user')

// v3
const registry = createRegistry({ user: userMachine })
const userState = registry.getState().user
registry.machines.user // the machine itself, with its plugin methods typed
```

Changes:

- Machines are passed at creation. `register`/`unregister` are gone.
- `getMachine`, `getMachineState`, `subscribeToMachine`, `has`, and `getMachineNames` are replaced by direct access through `registry.machines`.
- `forceSaveAll`, `hasUnsavedChanges`, and `clearAllHistory` now only reach machines that have the matching plugin. New: `hydrateAll()` and `flushAll()`.

### React hooks

```typescript
// v2
import { useStateMachine } from '@bkincz/clutch/react'
// v3
import { useMachine } from '@bkincz/clutch/react'
```

| v2 | v3 |
|---|---|
| `useStateMachine` | `useMachine` |
| `useStateSlice` | `useSlice` |
| `useStateHistory` | `useMachineHistory` |
| `useStatePersist` | `useAutosave` |
| `useDeferredHydration` | `useHydration` |
| `useStateSubscription` | `useSubscription` |
| `useRegistry`, `useRegistrySlice` | same names, take a v3 `Registry` |
| `useRegistryMachine` | `useMachine(registry.machines.x)` |
| `useStateActions`, `useRegistryActions` | call machine/registry methods directly |
| `useLifecycleEvent` | custom plugin with `onCommit`/`onError` |
| `useOptimisticUpdate`, `useDebouncedStateUpdate`, `useShallowEqual` | removed |
| `createStateMachineHooks`, `createRegistryHooks` | removed |

v3 hooks no longer hydrate automatically. `useMachine` only reads state. If you use deferred persistence, render a `useHydration(machine)` call once near the root.

The plugin hooks are typed against the plugin APIs. `useMachineHistory` requires a machine with `history` installed, `useHydration` requires `persist`, `useAutosave` requires `autosave`.

### Behavior changes

- **Subscribers are notified after plugins run.** In a listener, `getHistoryInfo()` and `hasUnsavedChanges()` are already up to date for the change being announced.
- **`reset()` stays local.** v2 broadcast resets to sync peers, v3 does not. Use a regular mutation if peers need to follow.
- **DevTools shows more.** Sync updates and hydration now appear in the timeline. v2 only showed local commits.
- **Validation of remote updates is report-only.** A failing validator rejects local mutations, but external updates are already applied when plugins see them. They surface through the `onError` hook.
