import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createMachine, MachineError } from '../next/core'
import { createRegistry } from '../next/registry'
import { history } from '../next/plugins/history'
import { persist, type PersistStorage } from '../next/plugins/persist'
import { autosave } from '../next/plugins/autosave'

interface UserState {
	name: string
}

interface CartState {
	items: number
}

const createMemoryStorage = (): PersistStorage & { store: Map<string, string> } => {
	const store = new Map<string, string>()
	return {
		store,
		getItem: key => store.get(key) ?? null,
		setItem: (key, value) => {
			store.set(key, value)
		},
		removeItem: key => {
			store.delete(key)
		},
	}
}

describe('next/registry', () => {
	describe('combined state', () => {
		it('combines member states under their keys', () => {
			const registry = createRegistry({
				user: createMachine<UserState>({ initialState: { name: 'beni' } }),
				cart: createMachine<CartState>({ initialState: { items: 0 } }),
			})

			expect(registry.getState()).toEqual({
				user: { name: 'beni' },
				cart: { items: 0 },
			})
		})

		it('keeps the combined snapshot referentially stable until a member changes', () => {
			const registry = createRegistry({
				user: createMachine<UserState>({ initialState: { name: 'beni' } }),
			})

			const first = registry.getState()
			expect(registry.getState()).toBe(first)

			registry.machines.user.mutate(draft => {
				draft.name = 'changed'
			})

			expect(registry.getState()).not.toBe(first)
			expect(registry.getState().user.name).toBe('changed')
		})

		it('notifies subscribers when any member changes', () => {
			const registry = createRegistry({
				user: createMachine<UserState>({ initialState: { name: 'beni' } }),
				cart: createMachine<CartState>({ initialState: { items: 0 } }),
			})
			const listener = vi.fn()
			registry.subscribe(listener)

			registry.machines.cart.mutate(draft => {
				draft.items = 3
			})

			expect(listener).toHaveBeenCalledWith(expect.objectContaining({ cart: { items: 3 } }))
		})
	})

	describe('typed machine access', () => {
		it('preserves plugin extensions per machine', () => {
			const registry = createRegistry({
				user: createMachine<UserState>({ initialState: { name: 'beni' } }).with(
					history<UserState>()
				),
				cart: createMachine<CartState>({ initialState: { items: 0 } }),
			})

			registry.machines.user.mutate(draft => {
				draft.name = 'changed'
			})

			// undo() existing here is the compile-time proof; cart has no such method
			expect(registry.machines.user.undo()).toBe(true)
			expect(registry.getState().user.name).toBe('beni')
		})
	})

	describe('coordinated operations', () => {
		it('resetAll resets every machine', () => {
			const registry = createRegistry({
				user: createMachine<UserState>({ initialState: { name: 'beni' } }),
				cart: createMachine<CartState>({ initialState: { items: 0 } }),
			})

			registry.machines.user.mutate(draft => {
				draft.name = 'x'
			})
			registry.machines.cart.mutate(draft => {
				draft.items = 9
			})

			registry.resetAll()

			expect(registry.getState()).toEqual({
				user: { name: 'beni' },
				cart: { items: 0 },
			})
		})

		it('forceSaveAll saves only autosave-equipped machines and survives failures', async () => {
			const goodSave = vi.fn()
			const badSave = vi.fn(() => {
				throw new Error('down')
			})

			const registry = createRegistry({
				good: createMachine<UserState>({ initialState: { name: 'a' } }).with(
					autosave<UserState>({ save: goodSave })
				),
				bad: createMachine<CartState>({ initialState: { items: 0 } }).with(
					autosave<CartState>({ save: badSave })
				),
				plain: createMachine<CartState>({ initialState: { items: 0 } }),
			})

			registry.machines.good.mutate(draft => {
				draft.name = 'b'
			})
			registry.machines.bad.mutate(draft => {
				draft.items = 1
			})

			await expect(registry.forceSaveAll()).resolves.toBeUndefined()

			expect(goodSave).toHaveBeenCalledWith({ name: 'b' })
			expect(badSave).toHaveBeenCalled()
			expect(registry.machines.good.hasUnsavedChanges()).toBe(false)
			expect(registry.machines.bad.hasUnsavedChanges()).toBe(true)
		})

		it('hasUnsavedChanges aggregates across autosave machines', () => {
			const registry = createRegistry({
				tracked: createMachine<UserState>({ initialState: { name: 'a' } }).with(
					autosave<UserState>({ save: () => {} })
				),
				plain: createMachine<CartState>({ initialState: { items: 0 } }),
			})

			expect(registry.hasUnsavedChanges()).toBe(false)

			registry.machines.plain.mutate(draft => {
				draft.items = 1
			})
			expect(registry.hasUnsavedChanges()).toBe(false)

			registry.machines.tracked.mutate(draft => {
				draft.name = 'b'
			})
			expect(registry.hasUnsavedChanges()).toBe(true)
		})

		it('clearAllHistory reaches only history-equipped machines', () => {
			const registry = createRegistry({
				tracked: createMachine<UserState>({ initialState: { name: 'a' } }).with(
					history<UserState>()
				),
				plain: createMachine<CartState>({ initialState: { items: 0 } }),
			})

			registry.machines.tracked.mutate(draft => {
				draft.name = 'b'
			})
			expect(registry.machines.tracked.canUndo()).toBe(true)

			registry.clearAllHistory()

			expect(registry.machines.tracked.canUndo()).toBe(false)
		})

		describe('persist coordination', () => {
			beforeEach(() => {
				vi.useFakeTimers()
			})

			afterEach(() => {
				vi.useRealTimers()
			})

			it('hydrateAll and flushAll reach persist-equipped machines', () => {
				const storage = createMemoryStorage()
				storage.store.set(
					'user',
					JSON.stringify({ state: { name: 'stored' }, timestamp: Date.now() })
				)

				const registry = createRegistry({
					user: createMachine<UserState>({ initialState: { name: 'a' } }).with(
						persist<UserState>({ key: 'user', storage, deferred: true })
					),
					plain: createMachine<CartState>({ initialState: { items: 0 } }),
				})

				registry.hydrateAll()
				expect(registry.getState().user.name).toBe('stored')

				registry.machines.user.mutate(draft => {
					draft.name = 'edited'
				})
				registry.flushAll()

				const written = JSON.parse(storage.store.get('user') as string)
				expect(written.state).toEqual({ name: 'edited' })
			})
		})
	})

	describe('destroyAll', () => {
		it('destroys every machine and rejects further use', () => {
			const registry = createRegistry({
				user: createMachine<UserState>({ initialState: { name: 'a' } }),
			})

			registry.destroyAll()

			expect(() => registry.getState()).toThrow(MachineError)
			expect(() => registry.machines.user.getState()).toThrow('destroyed')
			// Second call is a no-op, matching machine.destroy()
			expect(() => registry.destroyAll()).not.toThrow()
		})
	})
})
