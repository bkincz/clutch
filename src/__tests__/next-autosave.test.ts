import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createMachine, MachineError } from '../next/core'
import { autosave } from '../next/plugins/autosave'
import { history } from '../next/plugins/history'

interface TestState {
	count: number
}

const initialState = (): TestState => ({ count: 0 })

const INTERVAL = 1000

describe('next/plugins/autosave', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('requires a save function and a positive interval', () => {
		expect(() => autosave({ save: null as unknown as () => void })).toThrow(MachineError)
		expect(() => autosave({ save: () => {}, intervalMs: 0 })).toThrow('positive')
	})

	describe('dirty tracking and forceSave', () => {
		it('marks dirty on commit, saves the current state, then resets', async () => {
			const save = vi.fn()
			const machine = createMachine({ initialState: initialState() }).with(
				autosave<TestState>({ save, intervalMs: INTERVAL })
			)

			expect(machine.hasUnsavedChanges()).toBe(false)

			machine.mutate(draft => {
				draft.count = 3
			})
			expect(machine.hasUnsavedChanges()).toBe(true)

			await machine.forceSave()

			expect(save).toHaveBeenCalledWith({ count: 3 })
			expect(machine.hasUnsavedChanges()).toBe(false)
		})

		it('skips the save call when nothing changed', async () => {
			const save = vi.fn()
			const machine = createMachine({ initialState: initialState() }).with(
				autosave<TestState>({ save, intervalMs: INTERVAL })
			)

			await machine.forceSave()

			expect(save).not.toHaveBeenCalled()
		})

		it('does not mark undo as unsaved changes', async () => {
			const save = vi.fn()
			const machine = createMachine({ initialState: initialState() })
				.with(history<TestState>())
				.with(autosave<TestState>({ save, intervalMs: INTERVAL }))

			machine.mutate(draft => {
				draft.count = 1
			})
			await machine.forceSave()

			machine.undo()

			expect(machine.hasUnsavedChanges()).toBe(false)
			await vi.advanceTimersByTimeAsync(INTERVAL * 2)
			expect(save).toHaveBeenCalledTimes(1)
		})

		it('stays dirty and reports the error when save fails', async () => {
			const onError = vi.fn()
			const save = vi.fn(() => {
				throw new Error('server down')
			})
			const machine = createMachine({ initialState: initialState() })
				.with({ name: 'errors', onError })
				.with(autosave<TestState>({ save, intervalMs: INTERVAL }))

			machine.mutate(draft => {
				draft.count = 1
			})

			await expect(machine.forceSave()).rejects.toThrow('Force save failed: server down')
			expect(machine.hasUnsavedChanges()).toBe(true)
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({ code: 'PERSISTENCE_ERROR' }),
				'persist'
			)
		})
	})

	describe('interval', () => {
		it('saves automatically when dirty', async () => {
			const save = vi.fn()
			const machine = createMachine({ initialState: initialState() }).with(
				autosave<TestState>({ save, intervalMs: INTERVAL })
			)

			machine.mutate(draft => {
				draft.count = 1
			})

			await vi.advanceTimersByTimeAsync(INTERVAL)

			expect(save).toHaveBeenCalledWith({ count: 1 })
			expect(machine.hasUnsavedChanges()).toBe(false)
		})

		it('does nothing on ticks while clean', async () => {
			const save = vi.fn()
			createMachine({ initialState: initialState() }).with(
				autosave<TestState>({ save, intervalMs: INTERVAL })
			)

			await vi.advanceTimersByTimeAsync(INTERVAL * 3)

			expect(save).not.toHaveBeenCalled()
		})

		it('swallows tick failures after reporting them', async () => {
			const onError = vi.fn()
			const save = vi.fn(() => {
				throw new Error('flaky')
			})
			const machine = createMachine({ initialState: initialState() })
				.with({ name: 'errors', onError })
				.with(autosave<TestState>({ save, intervalMs: INTERVAL }))

			machine.mutate(draft => {
				draft.count = 1
			})

			await vi.advanceTimersByTimeAsync(INTERVAL)

			expect(onError).toHaveBeenCalled()
			expect(machine.hasUnsavedChanges()).toBe(true)
		})

		it('setAutoSaveInterval restarts the timer with the new cadence', async () => {
			const save = vi.fn()
			const machine = createMachine({ initialState: initialState() }).with(
				autosave<TestState>({ save, intervalMs: INTERVAL })
			)

			machine.setAutoSaveInterval(INTERVAL * 10)
			machine.mutate(draft => {
				draft.count = 1
			})

			await vi.advanceTimersByTimeAsync(INTERVAL)
			expect(save).not.toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(INTERVAL * 9)
			expect(save).toHaveBeenCalledTimes(1)
		})

		it('rejects a non-positive interval update', () => {
			const machine = createMachine({ initialState: initialState() }).with(
				autosave<TestState>({ save: () => {}, intervalMs: INTERVAL })
			)

			expect(() => machine.setAutoSaveInterval(0)).toThrow('positive')
		})

		it('stops saving after destroy', async () => {
			const save = vi.fn()
			const machine = createMachine({ initialState: initialState() }).with(
				autosave<TestState>({ save, intervalMs: INTERVAL })
			)

			machine.mutate(draft => {
				draft.count = 1
			})
			machine.destroy()

			await vi.advanceTimersByTimeAsync(INTERVAL * 2)

			expect(save).not.toHaveBeenCalled()
		})
	})

	describe('loadFromServer', () => {
		it('applies server state, clears history and resets dirty', async () => {
			const machine = createMachine({ initialState: initialState() })
				.with(history<TestState>())
				.with(
					autosave<TestState>({
						save: () => {},
						load: () => ({ count: 99 }),
						intervalMs: INTERVAL,
					})
				)

			machine.mutate(draft => {
				draft.count = 1
			})
			expect(machine.canUndo()).toBe(true)

			await expect(machine.loadFromServer()).resolves.toBe(true)

			expect(machine.getState()).toEqual({ count: 99 })
			expect(machine.canUndo()).toBe(false)
			expect(machine.hasUnsavedChanges()).toBe(false)
		})

		it('returns false when the server has nothing', async () => {
			const machine = createMachine({ initialState: initialState() }).with(
				autosave<TestState>({ save: () => {}, load: () => null, intervalMs: INTERVAL })
			)

			await expect(machine.loadFromServer()).resolves.toBe(false)
			expect(machine.getState().count).toBe(0)
		})

		it('returns false when no load function is configured', async () => {
			const machine = createMachine({ initialState: initialState() }).with(
				autosave<TestState>({ save: () => {}, intervalMs: INTERVAL })
			)

			await expect(machine.loadFromServer()).resolves.toBe(false)
		})

		it('reports load failures and returns false', async () => {
			const onError = vi.fn()
			const machine = createMachine({ initialState: initialState() })
				.with({ name: 'errors', onError })
				.with(
					autosave<TestState>({
						save: () => {},
						load: () => {
							throw new Error('offline')
						},
						intervalMs: INTERVAL,
					})
				)

			await expect(machine.loadFromServer()).resolves.toBe(false)
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({ message: 'offline' }),
				'persist'
			)
		})
	})
})
