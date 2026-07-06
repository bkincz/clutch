import { describe, it, expect, vi } from 'vitest'
import { createMachine, MachineError, type PluginContext } from '../core'
import { validate } from '../plugins/validate'

interface TestState {
	count: number
}

const initialState = (): TestState => ({ count: 0 })

describe('plugins/validate', () => {
	it('requires a validator function', () => {
		expect(() => validate(null as unknown as () => boolean)).toThrow(MachineError)
	})

	it('vetoes commits that fail validation', () => {
		const machine = createMachine({ initialState: initialState() }).with(
			validate<TestState>(state => state.count >= 0)
		)
		const listener = vi.fn()
		machine.subscribe(listener)

		expect(() =>
			machine.mutate(draft => {
				draft.count = -1
			})
		).toThrow('State validation failed')

		expect(machine.getState().count).toBe(0)
		expect(listener).not.toHaveBeenCalled()
	})

	it('lets valid commits through', () => {
		const machine = createMachine({ initialState: initialState() }).with(
			validate<TestState>(state => state.count >= 0)
		)

		machine.mutate(draft => {
			draft.count = 5
		})

		expect(machine.getState().count).toBe(5)
	})

	it('vetoes invalid batches', () => {
		const machine = createMachine({ initialState: initialState() }).with(
			validate<TestState>(state => state.count >= 0)
		)

		expect(() =>
			machine.batch([
				draft => {
					draft.count = 1
				},
				draft => {
					draft.count = -5
				},
			])
		).toThrow('State validation failed')

		expect(machine.getState().count).toBe(0)
	})

	it('reports invalid external states without reverting them', () => {
		const onError = vi.fn()
		let capturedCtx!: PluginContext<TestState>
		const machine = createMachine({ initialState: initialState() })
			.with({ name: 'errors', onError })
			.with({
				name: 'sync',
				onInit: (ctx: PluginContext<TestState>) => {
					capturedCtx = ctx
				},
			})
			.with(validate<TestState>(state => state.count >= 0))

		capturedCtx.replaceState({ count: -7 }, { source: 'sync' })

		expect(machine.getState().count).toBe(-7)
		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({
				message: 'State validation failed for external update from "sync"',
			}),
			'validate'
		)
	})

	it('stays quiet for valid external states', () => {
		const onError = vi.fn()
		let capturedCtx!: PluginContext<TestState>
		createMachine({ initialState: initialState() })
			.with({ name: 'errors', onError })
			.with({
				name: 'sync',
				onInit: (ctx: PluginContext<TestState>) => {
					capturedCtx = ctx
				},
			})
			.with(validate<TestState>(state => state.count >= 0))

		capturedCtx.replaceState({ count: 7 }, { source: 'sync' })

		expect(onError).not.toHaveBeenCalled()
	})

	it('uses a returned string as the rejection message', () => {
		const machine = createMachine({ initialState: initialState() }).with(
			validate<TestState>(state => (state.count >= 0 ? true : 'count must not go negative'))
		)

		expect(() =>
			machine.mutate(draft => {
				draft.count = -1
			})
		).toThrow('count must not go negative')
		expect(machine.getState().count).toBe(0)
	})

	it('keeps the generic message for a plain false', () => {
		const machine = createMachine({ initialState: initialState() }).with(
			validate<TestState>(state => state.count >= 0)
		)

		expect(() =>
			machine.mutate(draft => {
				draft.count = -1
			})
		).toThrow('State validation failed')
	})
})
