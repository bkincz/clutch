import { describe, it, expect, vi } from 'vitest'
import { createMachine, MachineError, type Plugin, type PluginContext } from '../core'
import { history } from '../plugins/history'

interface TestState {
	count: number
	name: string
}

const initialState = (): TestState => ({ count: 0, name: 'test' })

describe('core Machine', () => {
	it('mutates state and notifies subscribers', () => {
		const machine = createMachine({ initialState: initialState() })
		const listener = vi.fn()
		machine.subscribe(listener)

		machine.mutate(draft => {
			draft.count = 1
		})

		expect(machine.getState().count).toBe(1)
		expect(listener).toHaveBeenCalledTimes(1)
		expect(listener).toHaveBeenCalledWith(expect.objectContaining({ count: 1 }))
	})

	it('skips commit entirely when recipe produces no patches', () => {
		const machine = createMachine({ initialState: initialState() })
		const listener = vi.fn()
		const onCommit = vi.fn()
		machine.subscribe(listener)
		machine.with({ name: 'spy', onCommit })

		machine.mutate(() => {})

		expect(listener).not.toHaveBeenCalled()
		expect(onCommit).not.toHaveBeenCalled()
	})

	it('batches mutations into a single commit', () => {
		const machine = createMachine({ initialState: initialState() })
		const onCommit = vi.fn()
		machine.with({ name: 'spy', onCommit })

		machine.batch(
			[
				draft => {
					draft.count = 1
				},
				draft => {
					draft.name = 'batched'
				},
			],
			'batch op'
		)

		expect(machine.getState()).toEqual({ count: 1, name: 'batched' })
		expect(onCommit).toHaveBeenCalledTimes(1)
		expect(onCommit.mock.calls[0]?.[0]).toMatchObject({
			operation: 'batch',
			description: 'batch op',
		})
		expect(onCommit.mock.calls[0]?.[0].patches.length).toBe(2)
	})

	it('accepts a single recipe in batch', () => {
		const machine = createMachine({ initialState: initialState() }).with(history<TestState>())
		machine.batch(draft => {
			draft.count = 3
		}, 'set count')

		expect(machine.getState().count).toBe(3)
		expect(machine.undo()).toBe(true)
		expect(machine.getState().count).toBe(0)
	})

	it('rejects an invalid initial state', () => {
		expect(() => createMachine({ initialState: null as unknown as TestState })).toThrow(
			MachineError
		)
	})

	describe('plugin installation', () => {
		it('throws on duplicate plugin names', () => {
			const machine = createMachine({ initialState: initialState() })
			machine.with({ name: 'dup' })

			expect(() => machine.with({ name: 'dup' })).toThrow('already installed')
		})

		it('throws when an extension key collides with an existing member', () => {
			const machine = createMachine({ initialState: initialState() })

			expect(() =>
				machine.with({
					name: 'bad',
					onInit: () => ({ mutate: () => {} }),
				})
			).toThrow('collides')
		})

		it('merges extensions onto the machine with accumulated typing', () => {
			const machine = createMachine({ initialState: initialState() }).with(
				history<TestState>()
			)

			// Calling undo() here doubles as the compile-time check that .with() carried the type
			machine.mutate(draft => {
				draft.count = 5
			})
			expect(machine.canUndo()).toBe(true)
			expect(machine.undo()).toBe(true)
			expect(machine.getState().count).toBe(0)
		})
	})

	describe('commit hooks', () => {
		it('vetoes the commit when onBeforeCommit throws', () => {
			const machine = createMachine({ initialState: initialState() })
			const listener = vi.fn()
			const onCommit = vi.fn()
			machine.subscribe(listener)
			machine.with({
				name: 'validator',
				onBeforeCommit: payload => {
					if (payload.state.count < 0) {
						throw new MachineError('count must be >= 0', 'VALIDATION_ERROR')
					}
				},
				onCommit,
			})

			expect(() =>
				machine.mutate(draft => {
					draft.count = -1
				})
			).toThrow('count must be >= 0')

			expect(machine.getState().count).toBe(0)
			expect(listener).not.toHaveBeenCalled()
			expect(onCommit).not.toHaveBeenCalled()
		})

		it('isolates onCommit failures and routes them to onError hooks', () => {
			const machine = createMachine({ initialState: initialState() })
			const onError = vi.fn()
			const lateCommit = vi.fn()
			machine.with({
				name: 'broken',
				onCommit: () => {
					throw new Error('plugin exploded')
				},
			})
			machine.with({ name: 'late', onCommit: lateCommit })
			machine.with({ name: 'errors', onError })

			machine.mutate(draft => {
				draft.count = 1
			})

			expect(machine.getState().count).toBe(1)
			expect(lateCommit).toHaveBeenCalledTimes(1)
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({ message: 'plugin exploded' }),
				'plugin:broken:onCommit'
			)
		})
	})

	describe('external state', () => {
		it('fans out onExternalState to every plugin except the source', () => {
			const machine = createMachine({ initialState: initialState() })
			const sourceHook = vi.fn()
			const otherHook = vi.fn()
			let capturedCtx!: PluginContext<TestState>

			machine.with({
				name: 'sync',
				onInit: ctx => {
					capturedCtx = ctx
				},
				onExternalState: sourceHook,
			})
			machine.with({ name: 'observer', onExternalState: otherHook })

			capturedCtx.replaceState({ count: 99, name: 'remote' }, { source: 'sync' })

			expect(machine.getState()).toEqual({ count: 99, name: 'remote' })
			expect(sourceHook).not.toHaveBeenCalled()
			expect(otherHook).toHaveBeenCalledWith(
				expect.objectContaining({ count: 99 }),
				expect.objectContaining({ source: 'sync' })
			)
		})
	})

	describe('replaceState', () => {
		it('swaps state in place, notifying subscribers and external-state plugins', () => {
			const onExternalState = vi.fn()
			const machine = createMachine({ initialState: initialState() }).with({
				name: 'sync',
				onExternalState,
			})
			const listener = vi.fn()
			machine.subscribe(listener)

			machine.replaceState({ count: 9, name: 'migrated' })

			expect(machine.getState()).toEqual({ count: 9, name: 'migrated' })
			expect(listener).toHaveBeenCalledWith({ count: 9, name: 'migrated' })
			expect(onExternalState).toHaveBeenCalledWith(
				{ count: 9, name: 'migrated' },
				expect.objectContaining({ source: 'replace' })
			)
		})
	})

	describe('reset', () => {
		it('returns to the initial state and notifies listeners', () => {
			const machine = createMachine({ initialState: initialState() })
			const listener = vi.fn()
			machine.subscribe(listener)

			machine.mutate(draft => {
				draft.count = 5
			})
			machine.reset()

			expect(machine.getState()).toEqual(initialState())
			expect(listener).toHaveBeenLastCalledWith(initialState())
			expect(machine.getInitialState()).toEqual(initialState())
		})

		it('clears history through the full-replace rule', () => {
			const machine = createMachine({ initialState: initialState() }).with(
				history<TestState>()
			)

			machine.mutate(draft => {
				draft.count = 5
			})
			expect(machine.canUndo()).toBe(true)

			machine.reset()

			expect(machine.canUndo()).toBe(false)
		})
	})

	describe('destroy', () => {
		it('calls onDestroy in reverse install order with the final state', () => {
			const machine = createMachine({ initialState: initialState() })
			const order: string[] = []
			machine.with({ name: 'first', onDestroy: () => order.push('first') })
			machine.with({
				name: 'second',
				onDestroy: state => {
					order.push(`second:${(state as TestState).count}`)
				},
			})

			machine.mutate(draft => {
				draft.count = 7
			})
			machine.destroy()

			expect(order).toEqual(['second:7', 'first'])
			expect(() => machine.getState()).toThrow('destroyed')
			expect(() => machine.with({ name: 'late' })).toThrow('destroyed')
		})
	})

	describe('set', () => {
		it('shallow-merges and notifies', () => {
			const machine = createMachine({ initialState: initialState() })
			const listener = vi.fn()
			machine.subscribe(listener)

			machine.set({ count: 5, name: 'merged' })

			expect(machine.getState()).toEqual({ count: 5, name: 'merged' })
			expect(listener).toHaveBeenCalledTimes(1)
		})

		it('is a no-op when nothing changed', () => {
			const machine = createMachine({ initialState: initialState() })
			const listener = vi.fn()
			machine.subscribe(listener)

			machine.set({ count: 0, name: 'test' })
			expect(listener).not.toHaveBeenCalled()
		})

		it('commits per-key patches that history can undo', () => {
			const machine = createMachine({ initialState: initialState() }).with(
				history<TestState>()
			)

			machine.set({ count: 1 })
			machine.set({ count: 2, name: 'later' })

			expect(machine.undo()).toBe(true)
			expect(machine.getState()).toEqual({ count: 1, name: 'test' })
			expect(machine.undo()).toBe(true)
			expect(machine.getState()).toEqual(initialState())
			expect(machine.redo()).toBe(true)
			expect(machine.getState().count).toBe(1)
		})

		it('freezes the result like mutate does', () => {
			const machine = createMachine({ initialState: { items: [] as number[] } })
			machine.set({ items: [1, 2] })

			expect(Object.isFrozen(machine.getState())).toBe(true)
			expect(Object.isFrozen(machine.getState().items)).toBe(true)
		})

		it('rejects a non-object partial', () => {
			const machine = createMachine({ initialState: initialState() })
			expect(() => machine.set(null as never)).toThrow('Partial state must be an object')
		})
	})

	describe('selector subscriptions', () => {
		it('fires only when the selected value changes, with the previous value', () => {
			const machine = createMachine({ initialState: initialState() })
			const listener = vi.fn()
			machine.subscribe(state => state.count, listener)

			machine.set({ name: 'other' })
			expect(listener).not.toHaveBeenCalled()

			machine.set({ count: 2 })
			expect(listener).toHaveBeenCalledTimes(1)
			expect(listener).toHaveBeenCalledWith(2, 0)
		})

		it('respects a custom equality function', () => {
			const machine = createMachine({ initialState: { items: [] as number[] } })
			const listener = vi.fn()
			machine.subscribe(
				state => state.items,
				listener,
				(a, b) => a.length === b.length
			)

			machine.mutate(draft => {
				draft.items = [9]
			})
			expect(listener).toHaveBeenCalledTimes(1)

			machine.mutate(draft => {
				draft.items = [8]
			})
			expect(listener).toHaveBeenCalledTimes(1)
		})

		it('stops firing after unsubscribe', () => {
			const machine = createMachine({ initialState: initialState() })
			const listener = vi.fn()
			const unsubscribe = machine.subscribe(state => state.count, listener)

			unsubscribe()
			machine.set({ count: 9 })
			expect(listener).not.toHaveBeenCalled()
		})
	})

	describe('without plugins', () => {
		it('still commits and notifies', () => {
			const machine = createMachine({ initialState: initialState() })
			const listener = vi.fn()
			machine.subscribe(listener)

			machine.mutate(draft => {
				draft.count++
			})
			expect(machine.getState().count).toBe(1)
			expect(listener).toHaveBeenCalledTimes(1)
		})

		it('skips notification when a recipe changes nothing', () => {
			const machine = createMachine({ initialState: initialState() })
			const listener = vi.fn()
			machine.subscribe(listener)

			machine.mutate(() => {})
			expect(listener).not.toHaveBeenCalled()
		})

		it('runs batch with a single recipe', () => {
			const machine = createMachine({ initialState: initialState() })
			machine.batch(draft => {
				draft.count = 7
			})
			expect(machine.getState().count).toBe(7)
		})
	})

	describe('initial state', () => {
		it('freezes the passed object so reset cannot be corrupted', () => {
			const passed = initialState()
			const machine = createMachine({ initialState: passed })

			expect(Object.isFrozen(passed)).toBe(true)
			machine.set({ count: 9 })
			machine.reset()
			expect(machine.getState().count).toBe(0)
		})
	})
})

describe('plugins/history', () => {
	const setup = (maxSize?: number) =>
		createMachine({ initialState: initialState() }).with(history<TestState>({ maxSize }))

	it('undoes and redoes through patch history', () => {
		const machine = setup()

		machine.mutate(draft => {
			draft.count = 1
		}, 'one')
		machine.mutate(draft => {
			draft.count = 2
		}, 'two')

		expect(machine.undo()).toBe(true)
		expect(machine.getState().count).toBe(1)
		expect(machine.undo()).toBe(true)
		expect(machine.getState().count).toBe(0)
		expect(machine.undo()).toBe(false)

		expect(machine.redo()).toBe(true)
		expect(machine.getState().count).toBe(1)
		expect(machine.redo()).toBe(true)
		expect(machine.getState().count).toBe(2)
		expect(machine.redo()).toBe(false)
	})

	it('does not record its own undo/redo as new history entries', () => {
		const machine = setup()

		machine.mutate(draft => {
			draft.count = 1
		})
		machine.undo()
		machine.redo()

		expect(machine.getHistoryInfo().historyLength).toBe(1)
	})

	it('truncates the redo branch when mutating after undo', () => {
		const machine = setup()

		machine.mutate(draft => {
			draft.count = 1
		})
		machine.mutate(draft => {
			draft.count = 2
		})
		machine.undo()
		machine.mutate(draft => {
			draft.count = 10
		})

		expect(machine.canRedo()).toBe(false)
		expect(machine.getHistoryInfo().historyLength).toBe(2)
		machine.undo()
		expect(machine.getState().count).toBe(1)
	})

	it('caps history at maxSize', () => {
		const machine = setup(2)

		machine.mutate(draft => {
			draft.count = 1
		})
		machine.mutate(draft => {
			draft.count = 2
		})
		machine.mutate(draft => {
			draft.count = 3
		})

		expect(machine.getHistoryInfo().historyLength).toBe(2)
		expect(machine.undo()).toBe(true)
		expect(machine.undo()).toBe(true)
		expect(machine.undo()).toBe(false)
		expect(machine.getState().count).toBe(1)
	})

	it('keeps getHistoryInfo referentially stable between history changes', () => {
		const machine = setup()

		machine.mutate(draft => {
			draft.count = 1
		}, 'first')

		const info = machine.getHistoryInfo()
		expect(machine.getHistoryInfo()).toBe(info)
		expect(info).toMatchObject({ canUndo: true, canRedo: false, lastAction: 'first' })

		machine.undo()
		expect(machine.getHistoryInfo()).not.toBe(info)
	})

	it('clears history on a full-state external replacement', () => {
		const machine = createMachine({ initialState: initialState() })
		let capturedCtx!: PluginContext<TestState>
		const ctxCapture: Plugin<TestState> = {
			name: 'devtools',
			onInit: ctx => {
				capturedCtx = ctx
			},
		}
		const withHistory = machine.with(ctxCapture).with(history<TestState>())

		withHistory.mutate(draft => {
			draft.count = 1
		})
		expect(withHistory.canUndo()).toBe(true)

		capturedCtx.replaceState({ count: 42, name: 'time-travel' }, { source: 'devtools' })

		expect(withHistory.getState().count).toBe(42)
		expect(withHistory.canUndo()).toBe(false)
		expect(withHistory.getHistoryInfo().historyLength).toBe(0)
	})

	it('keeps history through patch-based external updates', () => {
		const machine = createMachine({ initialState: initialState() })
		let capturedCtx!: PluginContext<TestState>
		const withHistory = machine
			.with({
				name: 'sync',
				onInit: (ctx: PluginContext<TestState>) => {
					capturedCtx = ctx
				},
			})
			.with(history<TestState>())

		withHistory.mutate(draft => {
			draft.count = 1
		})

		capturedCtx.applyPatches([{ op: 'replace', path: ['name'], value: 'remote' }], {
			source: 'sync',
		})

		expect(withHistory.getState().name).toBe('remote')
		expect(withHistory.canUndo()).toBe(true)
	})

	it('rejects a non-positive maxSize', () => {
		expect(() => history({ maxSize: 0 })).toThrow('positive')
	})
})
