import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createMachine, type PluginContext } from '../core'
import { persist, type PersistStorage } from '../plugins/persist'
import { history } from '../plugins/history'

interface TestState {
	count: number
	name: string
	secret: string
}

const initialState = (): TestState => ({ count: 0, name: 'test', secret: 'hidden' })

const KEY = 'persist-test'

// setup.ts replaces window.localStorage with no-op mocks, so tests exercise
// the injectable storage seam instead
interface MemoryStorage extends PersistStorage {
	store: Map<string, string>
	setItem: ReturnType<typeof vi.fn<(key: string, value: string) => void>>
}

const createMemoryStorage = (): MemoryStorage => {
	const store = new Map<string, string>()
	return {
		store,
		getItem: key => store.get(key) ?? null,
		setItem: vi.fn((key: string, value: string) => {
			store.set(key, value)
		}),
		removeItem: key => {
			store.delete(key)
		},
	}
}

describe('plugins/persist', () => {
	let storage: MemoryStorage

	const readStored = (): { state: Partial<TestState>; timestamp: number } | null => {
		const raw = storage.store.get(KEY)
		return raw ? JSON.parse(raw) : null
	}

	const seedStored = (state: Partial<TestState>): void => {
		storage.store.set(KEY, JSON.stringify({ state, timestamp: Date.now() }))
	}

	beforeEach(() => {
		storage = createMemoryStorage()
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('requires a key', () => {
		expect(() => persist({ key: '' })).toThrow('key is required')
	})

	describe('hydration', () => {
		it('hydrates on install, merging persisted partials over current state', () => {
			seedStored({ count: 42 })

			const machine = createMachine({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage })
			)

			expect(machine.getState()).toEqual({ count: 42, name: 'test', secret: 'hidden' })
			expect(machine.isHydrated()).toBe(true)
		})

		it('does not write back to storage during hydration', () => {
			seedStored({ count: 42 })

			createMachine({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage })
			)

			vi.runAllTimers()
			expect(storage.setItem).not.toHaveBeenCalled()
		})

		it('defers hydration until hydrate() is called', () => {
			seedStored({ count: 42 })

			const machine = createMachine({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage, deferred: true })
			)

			expect(machine.getState().count).toBe(0)
			expect(machine.isHydrated()).toBe(false)

			expect(machine.hydrate()).toBe(true)
			expect(machine.getState().count).toBe(42)
			expect(machine.isHydrated()).toBe(true)
		})

		it('hydrate() is one-shot and reports whether stored state was applied', () => {
			const machine = createMachine({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage, deferred: true })
			)

			expect(machine.hydrate()).toBe(false)
			expect(machine.isHydrated()).toBe(true)
			expect(machine.hydrate()).toBe(false)
		})

		it('ignores corrupt persisted data', () => {
			storage.store.set(KEY, 'not json {{')

			const machine = createMachine({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage })
			)

			expect(machine.getState().count).toBe(0)
			expect(machine.isHydrated()).toBe(true)
		})

		it('strips prototype pollution keys while hydrating safe ones', () => {
			storage.store.set(
				KEY,
				`{"state":{"count":5,"__proto__":{"polluted":true}},"timestamp":1}`
			)

			const machine = createMachine({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage })
			)

			expect(machine.getState().count).toBe(5)
			expect(({} as Record<string, unknown>).polluted).toBeUndefined()
			expect(Object.prototype.hasOwnProperty.call(machine.getState(), '__proto__')).toBe(
				false
			)
		})

		it('clears installed history on deferred hydration (full-state replace)', () => {
			seedStored({ count: 42 })

			const machine = createMachine({ initialState: initialState() })
				.with(history<TestState>())
				.with(persist<TestState>({ key: KEY, storage, deferred: true }))

			machine.mutate(draft => {
				draft.count = 1
			})
			expect(machine.canUndo()).toBe(true)

			machine.hydrate()

			expect(machine.getState().count).toBe(42)
			expect(machine.canUndo()).toBe(false)
		})
	})

	describe('writing', () => {
		it('persists after the debounce window', () => {
			const machine = createMachine({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage, debounceMs: 300 })
			)

			machine.mutate(draft => {
				draft.count = 1
			})

			expect(readStored()).toBeNull()

			vi.advanceTimersByTime(300)

			expect(readStored()?.state).toMatchObject({ count: 1 })
		})

		it('coalesces rapid mutations into one debounced write', () => {
			const machine = createMachine({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage, debounceMs: 300 })
			)

			machine.mutate(draft => {
				draft.count = 1
			})
			machine.mutate(draft => {
				draft.count = 2
			})
			machine.mutate(draft => {
				draft.count = 3
			})

			vi.advanceTimersByTime(300)

			expect(storage.setItem).toHaveBeenCalledTimes(1)
			expect(readStored()?.state).toMatchObject({ count: 3 })
		})

		it('flush() writes a pending persist immediately', () => {
			const machine = createMachine({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage, debounceMs: 300 })
			)

			machine.mutate(draft => {
				draft.count = 1
			})
			machine.flush()

			expect(readStored()?.state).toMatchObject({ count: 1 })
		})

		it('persists external state updates from other plugins', () => {
			let capturedCtx!: PluginContext<TestState>
			createMachine({ initialState: initialState() })
				.with({
					name: 'sync',
					onInit: (ctx: PluginContext<TestState>) => {
						capturedCtx = ctx
					},
				})
				.with(persist<TestState>({ key: KEY, storage, debounceMs: 300 }))

			capturedCtx.replaceState(
				{ count: 9, name: 'remote', secret: 'hidden' },
				{ source: 'sync' }
			)

			vi.advanceTimersByTime(300)

			expect(readStored()?.state).toMatchObject({ count: 9, name: 'remote' })
		})

		it('flushes a pending write on destroy', () => {
			const machine = createMachine({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage, debounceMs: 300 })
			)

			machine.mutate(draft => {
				draft.count = 5
			})
			machine.destroy()

			expect(readStored()?.state).toMatchObject({ count: 5 })
		})

		it('clearPersisted removes the stored entry without touching state', () => {
			const machine = createMachine({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage })
			)

			machine.mutate(draft => {
				draft.count = 1
			})
			machine.flush()
			expect(readStored()).not.toBeNull()

			machine.clearPersisted()

			expect(readStored()).toBeNull()
			expect(machine.getState().count).toBe(1)
		})
	})

	describe('filters', () => {
		it('applies an exclude filter', () => {
			const machine = createMachine({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage, filter: { exclude: ['secret'] } })
			)

			machine.mutate(draft => {
				draft.count = 1
			})
			machine.flush()

			expect(readStored()?.state).toEqual({ count: 1, name: 'test' })
		})

		it('applies an include filter', () => {
			const machine = createMachine({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage, filter: { include: ['count'] } })
			)

			machine.mutate(draft => {
				draft.count = 1
			})
			machine.flush()

			expect(readStored()?.state).toEqual({ count: 1 })
		})

		it('applies a custom filter', () => {
			const machine = createMachine({ initialState: initialState() }).with(
				persist<TestState>({
					key: KEY,
					storage,
					filter: { custom: state => ({ name: state.name.toUpperCase() }) },
				})
			)

			machine.mutate(draft => {
				draft.name = 'custom'
			})
			machine.flush()

			expect(readStored()?.state).toEqual({ name: 'CUSTOM' })
		})
	})

	describe('failure handling', () => {
		it('emits an error and skips the write when state exceeds maxChars', () => {
			const onError = vi.fn()
			const machine = createMachine({ initialState: initialState() })
				.with({ name: 'errors', onError })
				.with(persist<TestState>({ key: KEY, storage, maxChars: 10 }))

			machine.mutate(draft => {
				draft.name = 'way too large to fit'
			})
			machine.flush()

			expect(readStored()).toBeNull()
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({ code: 'PERSISTENCE_ERROR' }),
				'persist'
			)
		})

		it('emits an error on quota exceeded', () => {
			const quotaError = new Error('quota')
			quotaError.name = 'QuotaExceededError'
			const failingStorage: PersistStorage = {
				getItem: () => null,
				setItem: () => {
					throw quotaError
				},
				removeItem: () => {},
			}

			const onError = vi.fn()
			const machine = createMachine({ initialState: initialState() })
				.with({ name: 'errors', onError })
				.with(persist<TestState>({ key: KEY, storage: failingStorage }))

			machine.mutate(draft => {
				draft.count = 1
			})
			machine.flush()

			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({ message: 'Storage quota exceeded' }),
				'persist'
			)
		})
	})

	describe('versioning', () => {
		const seedVersioned = (state: Partial<TestState>, version?: number): void => {
			storage.store.set(KEY, JSON.stringify({ state, timestamp: Date.now(), version }))
		}

		it('writes the configured version into the envelope', () => {
			const machine = createMachine({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage, version: 2 })
			)
			machine.mutate(draft => {
				draft.count = 1
			})
			machine.flush()

			expect(readStored()).toMatchObject({ version: 2 })
		})

		it('migrates persisted state from an older version', () => {
			seedVersioned({ count: 41 }, 1)
			const migrate = vi.fn((old: Partial<TestState>) => ({
				...old,
				count: (old.count ?? 0) + 1,
			}))

			const machine = createMachine({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage, version: 2, migrate })
			)

			expect(migrate).toHaveBeenCalledWith({ count: 41 }, 1)
			expect(machine.getState().count).toBe(42)
		})

		it('discards mismatched state when no migrate is configured', () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
			seedVersioned({ count: 41 }, 1)

			const machine = createMachine({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage, version: 2 })
			)

			expect(machine.getState().count).toBe(0)
			expect(warn).toHaveBeenCalledWith(expect.stringContaining('version 1'))
			warn.mockRestore()
		})

		it('hydrates unversioned state as version 0', () => {
			seedVersioned({ count: 41 })

			const machine = createMachine({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage })
			)
			expect(machine.getState().count).toBe(41)
		})
	})
})
