# Clutch

[![Release](https://github.com/bkincz/clutch/actions/workflows/release.yml/badge.svg?branch=main)](https://github.com/bkincz/clutch/actions/workflows/release.yml)
[![codecov](https://codecov.io/gh/bkincz/clutch/branch/main/graph/badge.svg)](https://codecov.io/gh/bkincz/clutch)
[![npm version](https://badge.fury.io/js/@bkincz%2Fclutch.svg)](https://badge.fury.io/js/@bkincz%2Fclutch)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A TypeScript-first state manager built on Immer with undo/redo, persistence, and debugging tools.

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
import { createStateMachine } from '@bkincz/clutch'

interface AppState {
  count: number
  todos: string[]
}

const state = createStateMachine<AppState>({
  initialState: { count: 0, todos: [] }
})

// Mutate state with simple, mutable-style code
state.mutate(draft => {
  draft.count++
  draft.todos.push('Learn Clutch')
})

// Undo/Redo out of the box
state.undo()
state.redo()
```

Prefer classes? `new StateMachine({ ... })` works too. You only need to subclass when you want to override the server persistence hooks.

## Core Features

### Immutable Updates

Powered by Immer. Write simple mutations, get immutable state back.

```typescript
// Instead of this
const newState = {
  ...state,
  todos: state.todos.map(todo =>
    todo.id === id ? { ...todo, completed: true } : todo
  )
}

// Write this
state.mutate(draft => {
  const todo = draft.todos.find(t => t.id === id)
  if (todo) todo.completed = true
})
```

### Undo/Redo

Built-in history management using efficient patch-based storage.

```typescript
state.mutate(draft => { draft.count++ }, 'increment')
state.mutate(draft => { draft.count++ }, 'increment')

state.undo() // count is back to 1
state.redo() // count is 2 again

state.clearHistory() // start fresh
```

### Batch Operations

Group multiple changes into a single undo/redo step.

```typescript
state.batch([
  draft => { draft.count++ },
  draft => { draft.todos.push('New todo') },
  draft => { draft.loading = false }
], 'bulk update')
```

### Persistence

Automatic localStorage backup with optional server sync.

```typescript
const state = createStateMachine({
  initialState: { count: 0 },
  persistenceKey: 'my-app',
  autoSaveIntervalMs: 5 * 60 * 1000 // auto-save every 5 minutes
})

// Optional: add server persistence
class MyState extends StateMachine<AppState> {
  protected async saveToServer(state: AppState): Promise<void> {
    await fetch('/api/state', {
      method: 'POST',
      body: JSON.stringify(state)
    })
  }

  protected async loadFromServer(): Promise<AppState | null> {
    const res = await fetch('/api/state')
    return res.ok ? res.json() : null
  }
}
```

> `saveToServer`/`loadFromServer` are for periodic backup and restore. If you want *live* state sync between clients, that's what [Server Sync (WebSocket)](#server-sync-websocket) is for.

## Advanced Features

### Middleware

Intercept mutations for validation, logging, or transformation.

```typescript
import { Middleware } from '@bkincz/clutch'

// Validation middleware
const validateCount: Middleware<AppState> = (ctx, next, draft) => {
  next(draft)
  if (draft.count < 0) {
    throw new Error('Count cannot be negative')
  }
}

// Logging middleware
const logger: Middleware<AppState> = (ctx, next, draft) => {
  console.log('Before:', ctx.state)
  next(draft)
  console.log('After:', draft)
}

const state = new StateMachine({
  initialState: { count: 0 },
  middleware: [validateCount, logger]
})
```

Middleware runs in order, Express style. Whatever you do before `next(draft)` happens before the mutation, whatever comes after runs on the way back out.

### Selective Persistence

Exclude sensitive fields from localStorage.

```typescript
interface AppState {
  user: { name: string; email: string }
  authToken: string
  preferences: object
}

const state = new StateMachine({
  initialState: { ... },
  persistenceKey: 'my-app',

  // Option 1: Exclude specific fields
  persistenceFilter: {
    exclude: ['authToken']
  },

  // Option 2: Include only specific fields
  persistenceFilter: {
    include: ['user', 'preferences']
  },

  // Option 3: Custom filter function
  persistenceFilter: {
    custom: (state) => ({
      user: { name: state.user.name }, // exclude email
      preferences: state.preferences
    })
  }
})
```

Excluded fields automatically fall back to `initialState` when loaded from localStorage.

### DevTools Integration

Connect to Redux DevTools browser extension for time-travel debugging.

```typescript
const state = new StateMachine({
  initialState: { count: 0 },

  // Simple: enable with defaults
  enableDevTools: true,

  // Advanced: customize behavior
  enableDevTools: {
    name: 'MyApp',           // Name in DevTools
    maxAge: 50,              // Max actions to keep
    latency: 500,            // Debounce updates
    features: {
      jump: true,            // Enable time-travel
      skip: false,
      export: true,
      import: false
    }
  }
})
```

If the extension isn't installed, nothing breaks.

### StateRegistry (Multi-Machine Management)

Consolidate multiple state machines into a single coordinated store.

```typescript
import { StateMachine, StateRegistry } from '@bkincz/clutch'

// Define your state types
type UserState = { name: string; email: string }
type TodosState = { items: { id: string; text: string }[] }

// Define the store's machine registry
type AppMachines = {
  user: UserState
  todos: TodosState
}

// Create individual machines
class UserMachine extends StateMachine<UserState> {
  constructor() {
    super({ initialState: { name: '', email: '' } })
  }
}

class TodosMachine extends StateMachine<TodosState> {
  constructor() {
    super({ initialState: { items: [] } })
  }
}

// Create store and register machines
const store = new StateRegistry<AppMachines>()
store.register('user', new UserMachine())
store.register('todos', new TodosMachine())

// Get combined state from all machines
const state = store.getState()
// { user: { name: '', email: '' }, todos: { items: [] } }

// Subscribe to any machine's changes
store.subscribe((combinedState) => {
  console.log('Something changed:', combinedState)
})

// Coordinated operations across all machines
store.resetAll()        // Reset all machines to initial state
store.clearAllHistory() // Clear undo history on all machines
store.forceSaveAll()    // Persist all machines
store.destroyAll()      // Clean up everything
```

> **Note:** When defining your machine registry type, use `type` instead of `interface` for TypeScript compatibility.

### Multi-Instance Sync

Sync state across browser tabs using BroadcastChannel.

```typescript
const state = new StateMachine({
  initialState: { count: 0 },

  // Simple: enable with defaults
  enableSync: true,

  // Advanced: customize behavior
  enableSync: {
    channel: 'my-app-sync',      // BroadcastChannel name
    syncDebounce: 50,             // Debounce updates (ms)
    mergeStrategy: 'patches'      // 'patches' or 'latest'
  }
})
```

Changes in one tab show up in the others. `'patches'` sends just the diff, `'latest'` sends the whole state. Runs in the background and quietly does nothing in environments without BroadcastChannel.

> **Note:** With `deferredHydration: true`, sync starts when `hydrateFromPersisted()` is
> called rather than at construction, so remote updates can never overwrite persisted state
> before it has been loaded.

The transport is pluggable. Pass any `SyncTransport` implementation to route sync
messages somewhere else:

```typescript
import type { SyncTransport } from '@bkincz/clutch'

const state = new StateMachine({
  initialState: { count: 0 },
  enableSync: { transport: myCustomTransport }, // defaults to BroadcastChannelTransport
})
```

### Server Sync (WebSocket)

Want sync across actual machines, not just tabs? Point Clutch at a WebSocket server.
It lives in its own `@bkincz/clutch/sync-ws` entry, so it costs nothing unless you import it.

```typescript
import { StateMachine } from '@bkincz/clutch'
import { WebSocketTransport } from '@bkincz/clutch/sync-ws'

const state = new StateMachine({
  initialState: { count: 0 },
  enableSync: {
    mergeStrategy: 'patches',
    transport: new WebSocketTransport({
      url: 'wss://example.com/sync',
      getAuthToken: () => myAuth.getToken(), // optional, sync or async
      onError: err => reportError(err),      // operational errors (reconnect gave up, queue overflow)
    }),
  },
})
```

| Option                | Default   | Description                                                     |
| --------------------- | --------- | --------------------------------------------------------------- |
| `url`                 | -         | WebSocket server URL                                            |
| `protocols`           | -         | WebSocket subprotocols                                          |
| `webSocketCtor`       | global    | Custom constructor, pass `require('ws')` in Node                |
| `reconnect`           | `{}`      | `false` to disable, or `{ maxRetries, baseDelayMs, maxDelayMs }` |
| `heartbeatIntervalMs` | `30000`   | Ping interval, `0` disables                                     |
| `heartbeatTimeoutMs`  | `10000`   | Close and reconnect if no reply within this window              |
| `maxQueueSize`        | `100`     | Outgoing messages queued while offline (drop-oldest)            |
| `getAuthToken`        | -         | Token provider, sync or async                                   |
| `authMode`            | `'query'` | `'query'` appends `?token=...`, `'message'` sends an auth frame |
| `onError`             | -         | Operational error callback                                      |

Reconnection with backoff, heartbeats, and offline queueing are all handled for you.
Your server just needs to stamp each message with an incrementing version and broadcast
it to everyone, including the sender. That's about 30 lines in any language, and it never
has to understand your state shape. Full wire spec and reference pseudocode in
[docs/sync-protocol.md](docs/sync-protocol.md).

> **Heads up:** server-synced state has to be JSON-serializable. `Date`/`Map`/`Set`
> survive cross-tab structured clone but not JSON.

### Lifecycle Events

Subscribe to state changes, errors, and cleanup.

```typescript
// Subscribe to mutations
const unsubscribe = state.on('afterMutate', (payload) => {
  console.log(`[${payload.operation}] ${payload.description}`)
  console.log('Patches:', payload.patches)
  console.log('New state:', payload.state)
})

// Subscribe to errors
state.on('error', (payload) => {
  console.error(`Error in ${payload.operation}:`, payload.error)
})

// Subscribe to cleanup
state.on('destroy', (payload) => {
  console.log('Final state:', payload.finalState)
})

// Cleanup when done
unsubscribe()
```

**Available Events:**
- `afterMutate` - After any successful mutation (mutate, batch, undo, redo)
- `error` - When a mutation or persistence operation fails
- `destroy` - Before the state machine is cleaned up

### SSR / Deferred Hydration

Prevent hydration mismatches in Next.js, Remix, and other SSR frameworks.

The server renders `initialState`, the client hydrates with whatever was in localStorage, and React complains about the mismatch. Set `deferredHydration: true` and the machine waits until first client mount to load persisted state. `useStateMachine` and `useStateSlice` handle it automatically.

```typescript
class CartMachine extends StateMachine<CartState> {
  constructor() {
    super({
      initialState: { items: [] },
      persistenceKey: 'cart',
      deferredHydration: true   // skip localStorage in constructor
    })
  }
}
```

```tsx
// No extra wiring needed, hydration is automatic
function Cart() {
  const { state, mutate } = useStateMachine(cartMachine)
  return <div>{state.items.length} items</div>
}
```

Want to avoid a flash of stale state? Gate your UI with `useDeferredHydration`:

```tsx
function App() {
  const { isHydrated } = useDeferredHydration(cartMachine)
  if (!isHydrated) return <Skeleton />
  return <Cart />
}
```

> `isHydrated` is always `true` for machines without `deferredHydration: true`.

## React Hooks

> **Note:** React hooks are imported from `@bkincz/clutch/react`.

### `useStateMachine(state)`

Subscribe to entire state.

```typescript
import { useStateMachine } from '@bkincz/clutch/react'

function Counter() {
  const { state, mutate } = useStateMachine(todoState)

  return (
    <button onClick={() => mutate(draft => { draft.count++ })}>
      Count: {state.count}
    </button>
  )
}
```

### `useStateSlice(state, selector)`

Subscribe to a slice for better performance.

```typescript
const todoCount = useStateSlice(state, s => s.todos.length)
const completedTodos = useStateSlice(state, s => s.todos.filter(t => t.completed))
```

### `useStateActions(state)`

Get mutation methods without subscribing.

```typescript
const { mutate, batch, undo, redo } = useStateActions(state)
```

### `useStateHistory(state)`

Access undo/redo controls.

```typescript
const { canUndo, canRedo, undo, redo } = useStateHistory(state)
```

### `useStatePersist(state)`

Handle persistence operations.

```typescript
const { save, load, isSaving, hasUnsavedChanges } = useStatePersist(state)
```

### `useDeferredHydration(state)`

Reactive hydration status for machines with `deferredHydration: true`. Hydration itself is automatic, this hook is just for gating UI on it.

```typescript
const { isHydrated } = useDeferredHydration(cartMachine)
```

### `useLifecycleEvent(state, event, listener)`

Subscribe to lifecycle events with automatic cleanup.

```typescript
useLifecycleEvent(state, 'afterMutate', (payload) => {
  console.log('State changed:', payload.state)
})
```

### `createStateMachineHooks(state)`

Create pre-bound hooks for convenience.

```typescript
import { createStateMachineHooks } from '@bkincz/clutch/react'

const hooks = createStateMachineHooks(todoState)

function TodoApp() {
  const { state, mutate } = hooks.useState()
  const { canUndo, undo } = hooks.useHistory()

  hooks.useLifecycle('afterMutate', (payload) => {
    console.log('Changed:', payload.description)
  })

  return <div>...</div>
}
```

### `useRegistry(store)`

Subscribe to combined state from a `StateRegistry`.

```typescript
const state = useRegistry(store)
// { user: { name: '', email: '' }, todos: { items: [] } }
```

### `useRegistrySlice(store, selector)`

Subscribe to a slice of combined state for better performance.

```typescript
const userName = useRegistrySlice(store, s => s.user.name)
const todoCount = useRegistrySlice(store, s => s.todos.items.length)
```

### `useRegistryMachine(store, machineName)`

Subscribe to a specific machine's state.

```typescript
const userState = useRegistryMachine(store, 'user')
const todosState = useRegistryMachine(store, 'todos')
```

### `useRegistryActions(store)`

Get registry-wide actions without subscribing.

```typescript
const { resetAll, forceSaveAll, clearAllHistory, destroyAll } = useRegistryActions(store)
```

### `createRegistryHooks(store)`

Create pre-bound hooks for a specific `StateRegistry`.

```typescript
import { createRegistryHooks } from '@bkincz/clutch/react'

const hooks = createRegistryHooks(store)

function App() {
  const state = hooks.useRegistry()
  const userState = hooks.useMachine('user')
  const { resetAll } = hooks.useActions()

  return <div>...</div>
}
```

## Configuration

```typescript
interface StateConfig<T> {
  // Required
  initialState: T

  // Persistence
  persistenceKey?: string              // localStorage key
  persistenceFilter?: PersistenceFilter<T> // exclude/include/custom
  enablePersistence?: boolean          // default: true
  autoSaveIntervalMs?: number          // default: 300000 (5 minutes)
  enableAutoSave?: boolean             // default: true

  // History
  maxHistorySize?: number              // default: 50

  // Middleware
  middleware?: Middleware<T>[]

  // DevTools
  enableDevTools?: boolean | DevToolsConfig

  // Sync
  enableSync?: boolean | SyncConfig

  // SSR
  deferredHydration?: boolean          // skip localStorage in constructor, default: false

  // Validation & Debugging
  validateState?: (state: T) => boolean
  enableLogging?: boolean              // default: false
}
```

## API Reference

### Core Methods

```typescript
getState(): T                          // Get current state
mutate(recipe, description?)           // Update state
batch(mutations, description?)         // Batch multiple mutations
subscribe(listener)                    // Subscribe to changes
undo(): boolean                        // Undo last operation
redo(): boolean                        // Redo next operation
destroy()                              // Clean up resources
```

### Lifecycle Methods

```typescript
on(event, listener): () => void        // Subscribe to events
```

### Persistence Methods

```typescript
forceSave(): Promise<void>             // Immediately save
hasUnsavedChanges(): boolean           // Check unsaved changes
loadFromServerManually(): Promise<boolean> // Manual server load
hydrateFromPersisted(): void           // Load localStorage (deferred hydration only)
isHydrated: boolean                    // false until hydrateFromPersisted() runs
```

### History Methods

```typescript
getHistoryInfo(): StateHistoryInfo    // Get history state
clearHistory(): void                   // Clear undo/redo
canUndo(): boolean                     // Check if undo available
canRedo(): boolean                     // Check if redo available
```

### Reset Methods

```typescript
reset(): void                          // Reset to initial state
getInitialState(): T                   // Get the initial state
```

### StateRegistry Methods

```typescript
register(name, machine)                // Register a machine
unregister(name)                       // Remove a machine
getMachine(name)                       // Get a registered machine
getMachineNames()                      // List all machine names
getState()                             // Get combined state
getMachineState(name)                  // Get specific machine state
subscribe(listener)                    // Subscribe to any change
subscribeToMachine(name, listener)     // Subscribe to specific machine
resetAll()                             // Reset all machines
forceSaveAll()                         // Save all machines
clearAllHistory()                      // Clear all history
destroyAll()                           // Destroy all machines
```

## Performance

- Core is under 10KB brotlied, Immer included
- Undo/redo stores patches, not full state snapshots
- Slice subscriptions only re-render when the selected value actually changes
- localStorage writes are debounced instead of firing on every mutation
- React, WebSocket sync, and DevTools cost nothing unless you use them

## TypeScript

Fully typed with automatic inference.

```typescript
const state = new StateMachine({
  initialState: { count: 0, name: 'John' }
})

// TypeScript knows the exact shape
state.mutate(draft => {
  draft.count++      // ✓ number
  draft.name = 'Jane' // ✓ string
  draft.age = 25     // ✗ Property 'age' does not exist
})
```

## License

MIT
