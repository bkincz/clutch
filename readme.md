# Clutch - State Machine

A production-ready, TypeScript-first state management library built on Immer with advanced features.

This was primarily created for a personal project of mine called Kintsugi, hence the very specific features like `Auto-Save` or `Undo/Redo`, but I've found it a useful replacement for most state managers in my other projects.
Thought I'd put it here for anyone that might want to use it as well.

## Features

- 🔄 **Immutable Updates** - Powered by Immer for clean, mutable-style code that produces immutable state
- ⏪ **Undo/Redo** - Built-in history management using efficient patch-based storage
- 💾 **Persistence** - Automatic localStorage backup with optional server synchronization
- 🚀 **Performance** - Debounced notifications, memory tracking, and efficient batch operations
- 🛡️ **Type Safety** - Full TypeScript support with runtime validation
- 🔍 **Debugging** - Comprehensive logging system with structured output
- 🧹 **Memory Management** - Automatic cleanup and configurable history limits
- ⚡ **Auto-Save** - Configurable automatic persistence to prevent data loss

## Installation

```bash
npm install clutch
# or
yarn add clutch
# or
pnpm install clutch
```

## Quick Start

### 1. Define Your State

```typescript
interface AppState {
  user: { id: string; name: string } | null;
  todos: Array<{ id: string; text: string; completed: boolean }>;
  ui: { loading: boolean; error: string | null };
}

const initialState: AppState = {
  user: null,
  todos: [],
  ui: { loading: false, error: null },
};
```

### 2. Create Your State Machine

```typescript
import { StateMachine } from "clutch";

class TodoState extends StateMachine<AppState> {
  constructor() {
    super({
      initialState,
      persistenceKey: "todo-app",
      autoSaveInterval: 5, // minutes
      enableLogging: process.env.NODE_ENV === "development",
    });
  }

  // Optional: implement server persistence
  protected async saveToServer(state: AppState): Promise<void> {
    await fetch("/api/state", {
      method: "POST",
      body: JSON.stringify(state),
    });
  }

  protected async loadFromServer(): Promise<AppState | null> {
    const response = await fetch("/api/state");
    return response.ok ? await response.json() : null;
  }
}

export const todoState = new TodoState();
```

### 3. Use in React

```typescript
import { useStateMachine } from "clutch";
import { todoState } from "./todoState";

function TodoApp() {
  const { state, mutate } = useStateMachine(todoState);

  const addTodo = (text: string) => {
    mutate((draft) => {
      draft.todos.push({
        id: Date.now().toString(),
        text,
        completed: false,
      });
    }, "Add todo");
  };

  const toggleTodo = (id: string) => {
    mutate((draft) => {
      const todo = draft.todos.find((t) => t.id === id);
      if (todo) {
        todo.completed = !todo.completed;
      }
    }, "Toggle todo");
  };

  return (
    <div>
      <input
        type="text"
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            addTodo(e.currentTarget.value);
            e.currentTarget.value = "";
          }
        }}
        placeholder="Add a todo..."
      />
      
      {state.todos.map((todo) => (
        <div key={todo.id}>
          <input
            type="checkbox"
            checked={todo.completed}
            onChange={() => toggleTodo(todo.id)}
          />
          <span>{todo.text}</span>
        </div>
      ))}
    </div>
  );
}
```

## Core Features

### Immutable Updates with Immer

Write simple, mutable-looking code that produces immutable state:

```typescript
// Instead of complex spread operations
const newState = {
  ...state,
  todos: state.todos.map(todo => 
    todo.id === id ? { ...todo, completed: !todo.completed } : todo
  )
};

// Write simple mutations
state.mutate(draft => {
  const todo = draft.todos.find(t => t.id === id);
  if (todo) {
    todo.completed = !todo.completed;
  }
});
```

### Undo/Redo

```typescript
import { useStateActions } from "clutch";

function UndoRedoButtons() {
  const { undo, redo } = useStateActions(todoState);
  
  return (
    <>
      <button onClick={() => undo()}>Undo</button>
      <button onClick={() => redo()}>Redo</button>
    </>
  );
}
```

### Batch Operations

Group multiple changes into a single undo operation:

```typescript
state.batch([
  draft => draft.todos.push(newTodo1),
  draft => draft.todos.push(newTodo2),
  draft => { draft.ui.loading = false; }
], "Add multiple todos");
```

## React Hooks

### `useStateMachine(engine)`
Subscribe to entire state and get mutation methods.

### `useStateSlice(engine, selector, equalityFn?)`
Subscribe to a specific slice of state for better performance.

```typescript
const todoCount = useStateSlice(todoState, state => state.todos.length);
const completedTodos = useStateSlice(
  todoState, 
  state => state.todos.filter(t => t.completed)
);
```

### `useStateActions(engine)`
Get mutation methods without subscribing to state changes.

### `useStateHistory(engine)`
Access undo/redo state and controls.

```typescript
const { canUndo, canRedo, undo, redo } = useStateHistory(todoState);
```

### `useStatePersist(engine)`
Handle save/load operations and persistence state.

```typescript
const { save, load, isSaving, hasUnsavedChanges } = useStatePersist(todoState);
```

## Configuration

```typescript
interface StateConfig<T> {
  initialState: T;
  persistenceKey?: string;        // localStorage key
  autoSaveInterval?: number;      // minutes (default: 5)
  maxHistorySize?: number;        // undo history limit (default: 50)
  enablePersistence?: boolean;    // localStorage backup (default: true)
  enableAutoSave?: boolean;       // auto-save timer (default: true)
  enableLogging?: boolean;        // debug logs (default: false)
  validateState?: (state: T) => boolean; // state validation
}
```

## API Reference

### Core Methods

- `getState(): T` - Get current state
- `mutate(recipe, description?)` - Update state with Immer draft
- `batch(mutations, description?)` - Batch multiple mutations
- `subscribe(listener)` - Subscribe to state changes
- `undo(): boolean` - Undo last operation
- `redo(): boolean` - Redo next operation
- `destroy()` - Clean up resources

### Persistence Methods

- `forceSave(): Promise<void>` - Immediately save state
- `hasUnsavedChanges(): boolean` - Check for unsaved changes
- `loadFromServerManually(): Promise<boolean>` - Manual server load

## License

MIT