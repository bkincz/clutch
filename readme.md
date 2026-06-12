# Clutch

[![Release](https://github.com/bkincz/clutch/actions/workflows/release.yml/badge.svg?branch=main)](https://github.com/bkincz/clutch/actions/workflows/release.yml)
[![codecov](https://codecov.io/gh/bkincz/clutch/branch/main/graph/badge.svg)](https://codecov.io/gh/bkincz/clutch)
[![npm version](https://badge.fury.io/js/@bkincz%2Fclutch.svg)](https://badge.fury.io/js/@bkincz%2Fclutch)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A TypeScript-first, plugin-based state manager built on Immer. The core does immutable updates and subscriptions. Everything else, like undo/redo, persistence, sync, and DevTools, is a plugin you opt into. You only ship what you use.

Coming from v2? See the [migration guide](./docs/migration-v3.md).

## Installation

```bash
pnpm add @bkincz/clutch
```
```bash
npm install @bkincz/clutch
```
```bash
yarn add @bkincz/clutch
```

## Quick Start

```typescript
import { createMachine } from '@bkincz/clutch'

interface AppState {
  count: number
  todos: string[]
}

const machine = createMachine<AppState>({
  initialState: { count: 0, todos: [] },
})

// Write mutable-style code, get immutable state back
machine.mutate(draft => {
  draft.count++
  draft.todos.push('Learn Clutch')
})

machine.getState() // { count: 1, todos: ['Learn Clutch'] }

const unsubscribe = machine.subscribe(state => console.log(state))
```

The core machine has `mutate`, `batch`, `getState`, `subscribe`, `reset`, and `destroy`. That is all. Features come from plugins.

## Plugins

Install plugins with `.with()`. Each plugin adds its methods to the machine, and to its TypeScript type. Calling a method from a plugin you never installed is a compile error, not a runtime surprise.

```typescript
import { createMachine, history, persist, devtools } from '@bkincz/clutch'

const machine = createMachine<AppState>({ initialState })
  .with(history<AppState>({ maxSize: 50 }))
  .with(persist<AppState>({ key: 'app' }))
  .with(devtools<AppState>({ name: 'App' }))

machine.undo()   // from history
machine.flush()  // from persist
```

| Plugin | What it adds |
|---|---|
| `history()` | Undo/redo with patch-based history |
| `persist()` | localStorage persistence with debounced writes |
| `devtools()` | Redux DevTools integration with time travel |
| `sync()` | State sync across tabs or via WebSocket |
| `validate()` | Rejects commits that fail your validator |
| `autosave()` | Periodic and manual saving to your server |

Plugin order matters in one case: install `persist` before `sync` so hydration happens before the first sync exchange.

### history

```typescript
machine.with(history<AppState>({ maxSize: 50 })) // default 50
```

Adds `undo()`, `redo()`, `canUndo()`, `canRedo()`, `getHistoryInfo()`, and `clearHistory()`. Undo and redo return `false` when there is nothing to apply.

`getHistoryInfo()` returns `{ canUndo, canRedo, historyLength, currentIndex, lastAction }` and is referentially stable between history changes, so it is safe to use as a `useSyncExternalStore` snapshot.

### persist

```typescript
machine.with(persist<AppState>({
  key: 'app',                       // required, the storage key
  debounceMs: 300,                  // default 300
  maxChars: 5 * 1024 * 1024,        // refuse to write larger payloads
  storage: customStorage,           // anything with getItem/setItem/removeItem
  filter: { exclude: ['draft'] },   // or { include: [...] } or { custom: state => ... }
  deferred: false,                  // see SSR below
}))
```

Adds `hydrate()`, `isHydrated()`, `flush()`, and `clearPersisted()`. State is loaded on install and written on a debounce after every change. `flush()` forces a pending write immediately. Writes also flush on `pagehide` and `destroy()`.

**SSR:** pass `deferred: true` to skip hydration on install, then call `hydrate()` on the client after mount (or use the `useHydration` React hook). Without a browser storage available the plugin is inert, so creating machines on the server is safe.

### devtools

```typescript
machine.with(devtools<AppState>({ name: 'App', maxAge: 50 }))
```

Connects to the [Redux DevTools Extension](https://github.com/reduxjs/redux-devtools). Every commit, undo, sync update, and hydration shows up in the timeline. Time travel from the extension updates the machine. Adds no methods.

### sync

```typescript
machine.with(sync<AppState>({
  channel: 'my-app',            // BroadcastChannel name, for cross-tab sync
  mergeStrategy: 'latest',      // or 'patches'
  syncDebounce: 50,
  transport: customTransport,   // bring your own, e.g. WebSocket
  autoStart: true,
}))
```

Adds `startSync()`. By default sync uses a `BroadcastChannel` and starts on install. For server sync, pass the WebSocket transport:

```typescript
import { WebSocketTransport } from '@bkincz/clutch/sync-ws'

machine.with(sync<AppState>({
  transport: new WebSocketTransport({ url: 'wss://example.com/sync' }),
}))
```

With deferred persistence, pass `autoStart: false` and call `startSync()` after `hydrate()`, so a remote response cannot race your locally persisted state. The wire format is documented in [docs/sync-protocol.md](./docs/sync-protocol.md).

### validate

```typescript
machine.with(validate<AppState>(state => state.count >= 0))
```

A failing validator makes `mutate` and `batch` throw before any state is applied. Updates arriving from outside (sync, hydration) are already applied when plugins see them, so those are reported through `onError` instead of rejected.

### autosave

```typescript
machine.with(autosave<AppState>({
  save: state => api.put('/state', state),   // required
  load: () => api.get('/state'),             // optional
  intervalMs: 5 * 60 * 1000,                 // default 5 minutes
  auto: true,                                // false = manual forceSave only
}))
```

Adds `forceSave()`, `hasUnsavedChanges()`, `setAutoSaveInterval(ms)`, and `loadFromServer()`. Only local mutations mark the state dirty. Undo and incoming sync updates do not, since that data is already saved somewhere. A failed save stays dirty and retries on the next interval.

## Reset

`machine.reset()` returns to the initial state. History clears and persistence rewrites. Resets are not broadcast to sync peers.

## Registry

Group machines and read them as one combined state:

```typescript
import { createMachine, createRegistry, history, persist } from '@bkincz/clutch'

const registry = createRegistry({
  user: createMachine<UserState>({ initialState: userInit }).with(history<UserState>()),
  cart: createMachine<CartState>({ initialState: cartInit }).with(persist<CartState>({ key: 'cart' })),
})

registry.getState()             // { user: UserState, cart: CartState }
registry.subscribe(combined => { ... })

registry.machines.user.undo()   // typed, plugin methods are preserved per machine
```

Coordination methods only reach machines that have the matching plugin installed:

| Method | Reaches |
|---|---|
| `resetAll()` | every machine |
| `hydrateAll()` / `flushAll()` | machines with `persist` |
| `forceSaveAll()` / `hasUnsavedChanges()` | machines with `autosave` |
| `clearAllHistory()` | machines with `history` |
| `destroyAll()` | every machine |

The machine map is fixed at creation. There is no `register`/`unregister`.

## React

Hooks live in `@bkincz/clutch/react`. The main entry stays React-free.

```tsx
import { useMachine, useSlice } from '@bkincz/clutch/react'

function Counter() {
  const { state, mutate } = useMachine(machine)
  return <button onClick={() => mutate(d => { d.count++ })}>{state.count}</button>
}

function CountLabel() {
  // re-renders only when the selected value changes
  const count = useSlice(machine, s => s.count)
  return <span>{count}</span>
}
```

| Hook | Needs | Returns |
|---|---|---|
| `useMachine(machine)` | core | `{ state, mutate, batch }` |
| `useSlice(machine, selector, equalityFn?)` | core | the selected value |
| `useSubscription(machine, callback)` | core | nothing, runs your callback on changes |
| `useRegistry(registry)` | registry | combined state |
| `useRegistrySlice(registry, selector, equalityFn?)` | registry | the selected value |
| `useMachineHistory(machine)` | `history` plugin | history info plus `undo`, `redo`, `clearHistory` |
| `useHydration(machine)` | `persist` plugin | `{ isHydrated }`, hydrates on mount |
| `useAutosave(machine)` | `autosave` plugin | `save`, `load`, `isSaving`, `saveError`, `hasUnsavedChanges`, ... |

The plugin hooks require the plugin's methods on the machine type. Passing a machine without that plugin fails to compile.

## Writing a Plugin

A plugin is an object with a name and lifecycle hooks. Whatever `onInit` returns is merged onto the machine and shows up in its type.

```typescript
import type { Plugin } from '@bkincz/clutch'

function logger<T extends object>(): Plugin<T, { getLogCount(): number }> {
  let count = 0
  return {
    name: 'logger',
    onInit: () => ({ getLogCount: () => count }),
    onCommit: payload => {
      count++
      console.log(payload.description ?? payload.operation, payload.patches)
    },
  }
}

const machine = createMachine({ initialState }).with(logger())
machine.getLogCount()
```

Available hooks:

- `onInit(ctx)` runs at install. Return an object to extend the machine. `ctx` gives you `getState`, `subscribe`, `replaceState`, `applyPatches`, and `emitError`.
- `onBeforeCommit(payload)` runs before a mutation is applied. Throw to reject it.
- `onCommit(payload)` runs after a mutation is applied, before subscribers are notified. The payload has the new state, patches, inverse patches, description, and operation.
- `onExternalState(state, meta)` runs when state changes outside the mutation path: sync updates, hydration, undo, time travel, reset. `meta.source` names the plugin that caused it. Your own changes via `ctx.replaceState` are not echoed back to you.
- `onError(error, operation)` receives errors from any plugin.
- `onDestroy(finalState)` runs on `machine.destroy()`, in reverse install order.

Plugin names must be unique per machine, and extension keys must not collide with existing methods. Both throw at install time.

## Migrating from v2

`createV2Machine` accepts a v2 config and assembles the matching plugins, so most code only changes one import:

```typescript
import { createV2Machine } from '@bkincz/clutch'

const machine = createV2Machine({
  initialState,
  persistenceKey: 'app',
  maxHistorySize: 50,
  enableDevTools: true,
  saveToServer: state => api.put('/state', state),  // replaces subclassing
})
```

Details, the full option-to-plugin mapping, and behavior changes are in the [migration guide](./docs/migration-v3.md).

## TypeScript

State types are inferred from `initialState`, or pass them explicitly: `createMachine<AppState>(...)`. Each `.with()` call widens the machine type with the plugin's API, so autocomplete always matches what is actually installed.

```typescript
const machine = createMachine<AppState>({ initialState })
  .with(history<AppState>())

machine.undo()      // ok
machine.hydrate()   // compile error, persist is not installed
```

## Bundle Size

Sizes are minified and brotli compressed, including Immer.

| Import | Size |
|---|---|
| `{ createMachine }` only | ~4.5 KB |
| Everything | ~8.4 KB |
| React hooks (`/react`) | ~0.8 KB |
| WebSocket transport (`/sync-ws`) | ~1.1 KB |

Plugins you do not import are tree-shaken away.

## License

MIT
