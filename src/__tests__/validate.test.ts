import { describe, it, expect, vi } from 'vitest'
import { createMachine, MachineError, type PluginContext } from '../core'
import { validate, type StandardSchemaV1 } from '../plugins/validate'

interface TestState {
	count: number
}

const initialState = (): TestState => ({ count: 0 })

function nonNegativeCountSchema(options: { async?: boolean } = {}): StandardSchemaV1<TestState> {
	return {
		'~standard': {
			version: 1,
			vendor: 'clutch-test',
			validate: value => {
				const state = value as TestState
				const result =
					typeof state?.count === 'number' && state.count >= 0
						? { value: state }
						: { issues: [{ message: 'count must be a non-negative number' }] }
				return options.async ? Promise.resolve(result) : result
			},
		},
	}
}

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

	/*
	 *   STANDARD SCHEMA
	 ***************************************************************************************************/
	it('accepts a Standard Schema and vetoes commits that violate it', () => {
		const machine = createMachine({ initialState: initialState() }).with(
			validate(nonNegativeCountSchema())
		)

		expect(() =>
			machine.mutate(draft => {
				draft.count = -1
			})
		).toThrow('count must be a non-negative number')
		expect(machine.getState().count).toBe(0)

		machine.mutate(draft => {
			draft.count = 3
		})
		expect(machine.getState().count).toBe(3)
	})

	it('reports schema failures on external state', () => {
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
			.with(validate(nonNegativeCountSchema()))

		capturedCtx.replaceState({ count: -7 }, { source: 'sync' })

		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({
				message: expect.stringContaining('count must be a non-negative'),
			}),
			'validate'
		)
	})

	it('rejects an async schema, since commits are synchronous', () => {
		const machine = createMachine({ initialState: initialState() }).with(
			validate(nonNegativeCountSchema({ async: true }))
		)

		expect(() =>
			machine.mutate(draft => {
				draft.count = 1
			})
		).toThrow('Async schema validation is not supported')
	})

	it('rejects a validator that is neither a function nor a schema', () => {
		expect(() => validate({} as unknown as () => boolean)).toThrow(MachineError)
	})
})
