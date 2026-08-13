import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { createMachine } from '../core'
import { createRegistry } from '../registry'
import { history } from '../plugins/history'
import { persist, type PersistStorage } from '../plugins/persist'
import { autosave } from '../plugins/autosave'
import {
	useMachine,
	useSlice,
	useSubscription,
	useMachineHistory,
	useHydration,
	useAutosave,
	useRegistry,
	useRegistrySlice,
	createMachineScope,
} from '../react'

interface TestState {
	count: number
	name: string
}

const initialState = (): TestState => ({ count: 0, name: 'test' })

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

describe('react', () => {
	describe('useMachine', () => {
		it('returns state and re-renders on mutation', () => {
			const machine = createMachine({ initialState: initialState() })
			const { result } = renderHook(() => useMachine(machine))

			expect(result.current.state).toEqual({ count: 0, name: 'test' })

			act(() => {
				result.current.mutate(draft => {
					draft.count = 5
				})
			})

			expect(result.current.state.count).toBe(5)
		})

		it('exposes batch', () => {
			const machine = createMachine({ initialState: initialState() })
			const { result } = renderHook(() => useMachine(machine))

			act(() => {
				result.current.batch([
					draft => {
						draft.count = 1
					},
					draft => {
						draft.name = 'batched'
					},
				])
			})

			expect(result.current.state).toEqual({ count: 1, name: 'batched' })
		})
	})

	describe('useSlice', () => {
		it('returns the selected slice', () => {
			const machine = createMachine({ initialState: initialState() })
			const { result } = renderHook(() => useSlice(machine, state => state.count))

			expect(result.current).toBe(0)

			act(() => {
				machine.mutate(draft => {
					draft.count = 7
				})
			})

			expect(result.current).toBe(7)
		})

		it('uses the latest selector when its identity changes every render', () => {
			const machine = createMachine({ initialState: initialState() })
			const { result, rerender } = renderHook(
				({ key }: { key: 'count' | 'name' }) => useSlice(machine, state => state[key]),
				{ initialProps: { key: 'count' as const } }
			)

			expect(result.current).toBe(0)

			rerender({ key: 'name' as const })

			expect(result.current).toBe('test')
		})

		it('suppresses re-renders through a custom equality function', () => {
			const machine = createMachine({ initialState: initialState() })
			let renders = 0

			renderHook(() => {
				renders++
				return useSlice(
					machine,
					state => ({ count: state.count }),
					(a, b) => a.count === b.count
				)
			})

			const rendersBefore = renders

			act(() => {
				machine.mutate(draft => {
					draft.name = 'changed'
				})
			})

			expect(renders).toBe(rendersBefore)
		})
		it('does not re-render when an unrelated part of state changes', () => {
			const machine = createMachine({ initialState: initialState() })
			let renders = 0

			renderHook(() => {
				renders++
				return useSlice(machine, state => state.count)
			})

			const rendersBefore = renders

			act(() => {
				machine.mutate(draft => {
					draft.name = 'changed'
				})
			})

			expect(renders).toBe(rendersBefore)
		})
	})

	describe('useSubscription', () => {
		it('invokes the callback on changes and stops after unmount', () => {
			const machine = createMachine({ initialState: initialState() })
			const callback = vi.fn()
			const { unmount } = renderHook(() => useSubscription(machine, callback))

			act(() => {
				machine.mutate(draft => {
					draft.count = 1
				})
			})

			expect(callback).toHaveBeenCalledWith(expect.objectContaining({ count: 1 }))

			unmount()
			callback.mockClear()

			act(() => {
				machine.mutate(draft => {
					draft.count = 2
				})
			})

			expect(callback).not.toHaveBeenCalled()
		})
	})

	describe('useRegistry', () => {
		it('returns combined state and re-renders when a member changes', () => {
			const registry = createRegistry({
				counter: createMachine({ initialState: initialState() }),
			})
			const { result } = renderHook(() => useRegistry(registry))

			expect(result.current.counter.count).toBe(0)

			act(() => {
				registry.machines.counter.mutate(draft => {
					draft.count = 4
				})
			})

			expect(result.current.counter.count).toBe(4)
		})
	})

	describe('useRegistrySlice', () => {
		it('re-renders only when the selected slice changes', () => {
			const registry = createRegistry({
				a: createMachine({ initialState: initialState() }),
				b: createMachine({ initialState: initialState() }),
			})
			let renders = 0

			const { result } = renderHook(() => {
				renders++
				return useRegistrySlice(registry, state => state.a.count)
			})

			const rendersBefore = renders

			act(() => {
				registry.machines.b.mutate(draft => {
					draft.count = 9
				})
			})
			expect(renders).toBe(rendersBefore)

			act(() => {
				registry.machines.a.mutate(draft => {
					draft.count = 2
				})
			})
			expect(result.current).toBe(2)
		})
	})

	describe('useMachineHistory', () => {
		it('tracks history info and drives undo/redo', () => {
			const machine = createMachine({ initialState: initialState() }).with(
				history<TestState>()
			)
			const { result } = renderHook(() => useMachineHistory(machine))

			expect(result.current.canUndo).toBe(false)

			act(() => {
				machine.mutate(draft => {
					draft.count = 1
				}, 'increment')
			})

			expect(result.current.canUndo).toBe(true)
			expect(result.current.lastAction).toBe('increment')

			act(() => {
				result.current.undo()
			})

			expect(machine.getState().count).toBe(0)
			expect(result.current.canUndo).toBe(false)
			expect(result.current.canRedo).toBe(true)

			act(() => {
				result.current.redo()
			})

			expect(machine.getState().count).toBe(1)
		})
	})

	describe('useHydration', () => {
		it('hydrates a deferred persist machine on mount', () => {
			const storage = createMemoryStorage()
			storage.store.set(
				'react-test',
				JSON.stringify({ state: { count: 42 }, timestamp: Date.now() })
			)

			const machine = createMachine({ initialState: initialState() }).with(
				persist<TestState>({ key: 'react-test', storage, deferred: true })
			)

			expect(machine.isHydrated()).toBe(false)

			const { result } = renderHook(() => useHydration(machine))

			expect(result.current.isHydrated).toBe(true)
			expect(machine.getState().count).toBe(42)
		})
	})

	describe('useAutosave', () => {
		it('saves, tracks lastSaved and clears the unsaved flag', async () => {
			const save = vi.fn()
			const machine = createMachine({ initialState: initialState() }).with(
				autosave<TestState>({ save })
			)
			const { result } = renderHook(() => useAutosave(machine))

			expect(result.current.hasUnsavedChanges).toBe(false)

			act(() => {
				machine.mutate(draft => {
					draft.count = 1
				})
			})
			expect(result.current.hasUnsavedChanges).toBe(true)

			await act(async () => {
				await expect(result.current.save()).resolves.toBe(true)
			})

			expect(save).toHaveBeenCalledWith({ count: 1, name: 'test' })
			expect(result.current.hasUnsavedChanges).toBe(false)
			expect(result.current.lastSaved).toBeInstanceOf(Date)
			expect(result.current.saveError).toBeNull()
		})

		it('captures save failures as saveError', async () => {
			const machine = createMachine({ initialState: initialState() }).with(
				autosave<TestState>({
					save: () => {
						throw new Error('server down')
					},
				})
			)
			const { result } = renderHook(() => useAutosave(machine))

			act(() => {
				machine.mutate(draft => {
					draft.count = 1
				})
			})

			await act(async () => {
				await expect(result.current.save()).resolves.toBe(false)
			})

			expect(result.current.saveError).toContain('server down')
			expect(result.current.hasUnsavedChanges).toBe(true)

			act(() => {
				result.current.clearSaveError()
			})
			expect(result.current.saveError).toBeNull()
		})

		it('loads from the server through the hook', async () => {
			const machine = createMachine({ initialState: initialState() }).with(
				autosave<TestState>({
					save: () => {},
					load: () => ({ count: 99, name: 'server' }),
				})
			)
			const { result } = renderHook(() => useAutosave(machine))

			await act(async () => {
				await expect(result.current.load()).resolves.toBe(true)
			})

			expect(machine.getState()).toEqual({ count: 99, name: 'server' })
			expect(result.current.lastSaved).toBeInstanceOf(Date)
		})
	})

	describe('createMachineScope', () => {
		const scopeFactory = () => createMachine({ initialState: initialState() })

		const wrapperFor =
			(
				Provider: ReturnType<typeof createMachineScope>['Provider'],
				state?: Partial<TestState>
			) =>
			({ children }: { children: ReactNode }) =>
				createElement(Provider, { state, children })

		it('provides the machine created by the factory', () => {
			const { Provider, useScopedMachine } = createMachineScope(scopeFactory)
			const { result } = renderHook(() => useScopedMachine(), {
				wrapper: wrapperFor(Provider),
			})

			expect(result.current.getState()).toEqual({ count: 0, name: 'test' })
		})

		it('throws when the hook is used outside the provider', () => {
			const { useScopedMachine } = createMachineScope(scopeFactory, 'User')
			const onError = vi.spyOn(console, 'error').mockImplementation(() => {})

			expect(() => renderHook(() => useScopedMachine())).toThrow(
				/User scope was read outside/
			)

			onError.mockRestore()
		})

		// The reason the scope exists: a module-level machine would hand the
		// same state to every concurrent render on a server.
		it('creates an independent machine per provider', () => {
			const { Provider, useScopedMachine } = createMachineScope(scopeFactory)

			const first = renderHook(() => useScopedMachine(), { wrapper: wrapperFor(Provider) })
			const second = renderHook(() => useScopedMachine(), { wrapper: wrapperFor(Provider) })

			expect(first.result.current).not.toBe(second.result.current)

			act(() => {
				first.result.current.set({ count: 42 })
			})

			expect(first.result.current.getState().count).toBe(42)
			expect(second.result.current.getState().count).toBe(0)
		})

		it('seeds the machine before the first render', () => {
			const { Provider, useScopedMachine } = createMachineScope(scopeFactory)
			const seen: number[] = []

			renderHook(
				() => {
					const machine = useScopedMachine()
					seen.push(machine.getState().count)
					return machine
				},
				{ wrapper: wrapperFor(Provider, { count: 7 }) }
			)

			expect(seen[0]).toBe(7)
		})

		it('re-seeds when the state prop changes by value', () => {
			const { Provider, useScopedMachine } = createMachineScope(scopeFactory)
			let seed: Partial<TestState> = { count: 1 }

			const { result, rerender } = renderHook(() => useScopedMachine(), {
				wrapper: ({ children }: { children: ReactNode }) =>
					createElement(Provider, { state: seed, children }),
			})

			expect(result.current.getState().count).toBe(1)

			seed = { count: 9 }
			rerender()

			expect(result.current.getState().count).toBe(9)
		})

		// A parent re-render usually rebuilds the prop object. Re-seeding on
		// identity alone would revert anything the app wrote in between.
		it('does not clobber local writes when an equal seed is rebuilt', () => {
			const { Provider, useScopedMachine } = createMachineScope(scopeFactory)
			const { result, rerender } = renderHook(() => useScopedMachine(), {
				wrapper: ({ children }: { children: ReactNode }) =>
					createElement(Provider, { state: { count: 1 }, children }),
			})

			act(() => {
				result.current.set({ count: 5 })
			})
			rerender()

			expect(result.current.getState().count).toBe(5)
		})

		it('leaves the machine untouched when no state is given', () => {
			const { Provider, useScopedMachine } = createMachineScope(scopeFactory)
			const { result } = renderHook(() => useScopedMachine(), {
				wrapper: wrapperFor(Provider),
			})

			expect(result.current.getState()).toEqual(initialState())
		})
	})
})
