# Clutch

[![Release](https://github.com/bkincz/clutch/actions/workflows/release.yml/badge.svg?branch=main)](https://github.com/bkincz/clutch/actions/workflows/release.yml)
[![codecov](https://codecov.io/gh/bkincz/clutch/branch/main/graph/badge.svg)](https://codecov.io/gh/bkincz/clutch)
[![npm version](https://badge.fury.io/js/@bkincz%2Fclutch.svg)](https://badge.fury.io/js/@bkincz%2Fclutch)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A TypeScript-first state manager built on Immer with undo/redo, persistence, and debugging tools.

```bash
npm install @bkincz/clutch
```

## Quick Start

```typescript
import { StateMachine } from '@bkincz/clutch'

interface AppState {
  count: number
  todos: string[]
}

const state = new StateMachine({
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

## Core Features

### Immutable Updates

Powered by Immer - write simple mutations, get immutable state.

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
const state = new StateMachine({
  initialState: { count: 0 },
  persistenceKey: 'my-app',
  autoSaveInterval: 5 // minutes
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

Middleware executes in order, like Express.js:
1. First middleware runs "before" code
2. Calls `next(draft)` to pass control to next middleware
3. After all middleware, the mutation executes
4. Control returns back through middleware "after" code

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

// Now open Redux DevTools extension to see:
// - All mutations with descriptions
// - State at each step
// - Time-travel through history
// - Import/export state
```

Gracefully degrades when DevTools extension is not installed.

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

// Now changes in one tab instantly appear in all other tabs
// - 'patches': Send only the changes (more efficient)
// - 'latest': Send full state (simpler, more reliable)
```

Works automatically in the background. Gracefully degrades when BroadcastChannel is not supported.

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

## React Hooks

### `useStateMachine(state)`

Subscribe to entire state.

```typescript
import { useStateMachine } from '@bkincz/clutch'

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

## Configuration

```typescript
interface StateConfig<T> {
  // Required
  initialState: T

  // Persistence
  persistenceKey?: string              // localStorage key
  persistenceFilter?: PersistenceFilter<T> // exclude/include/custom
  enablePersistence?: boolean          // default: true
  autoSaveInterval?: number            // minutes, default: 5
  enableAutoSave?: boolean             // default: true

  // History
  maxHistorySize?: number              // default: 50

  // Middleware
  middleware?: Middleware<T>[]

  // DevTools
  enableDevTools?: boolean | DevToolsConfig

  // Sync
  enableSync?: boolean | SyncConfig

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
```

### History Methods

```typescript
getHistoryInfo(): StateHistoryInfo    // Get history state
clearHistory(): void                   // Clear undo/redo
canUndo(): boolean                     // Check if undo available
canRedo(): boolean                     // Check if redo available
```

## Performance

- **Lightweight**: ~20KB minified
- **Fast mutations**: < 1ms average overhead
- **Efficient undo/redo**: Patch-based storage
- **Optimized rendering**: Fine-grained subscriptions
- **Lazy initialization**: Zero-cost for unused features
- **Tree-shakeable**: Only bundle what you use

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
