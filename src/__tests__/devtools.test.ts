import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createMachine, type PluginContext } from '../core'
import { devtools } from '../plugins/devtools'
import { history } from '../plugins/history'

interface TestState {
	count: number
	name: string
}

const initialState = (): TestState => ({ count: 0, name: 'test' })

type DispatchMessage = {
	type: string
	payload?: { type: string; [key: string]: unknown }
	state?: string
}

describe('plugins/devtools', () => {
	let mockConnection: {
		init: ReturnType<typeof vi.fn>
		send: ReturnType<typeof vi.fn>
		subscribe: ReturnType<typeof vi.fn>
		unsubscribe: ReturnType<typeof vi.fn>
	}
	let mockExtension: { connect: ReturnType<typeof vi.fn> }

	const dispatch = (message: DispatchMessage): void => {
		const subscribeCallback = mockConnection.subscribe.mock.calls[0]?.[0]
		subscribeCallback(message)
	}

	beforeEach(() => {
		mockConnection = {
			init: vi.fn(),
			send: vi.fn(),
			subscribe: vi.fn(() => vi.fn()),
			unsubscribe: vi.fn(),
		}
		mockExtension = {
			connect: vi.fn(() => mockConnection),
		}
		;(window as unknown as Record<string, unknown>).__REDUX_DEVTOOLS_EXTENSION__ = mockExtension
	})

	afterEach(() => {
		delete (window as unknown as Record<string, unknown>).__REDUX_DEVTOOLS_EXTENSION__
	})

	it('connects and sends the initial state on install', () => {
		createMachine({ initialState: initialState() }).with(
			devtools<TestState>({ name: 'TestApp', maxAge: 10 })
		)

		expect(mockExtension.connect).toHaveBeenCalledWith(
			expect.objectContaining({ name: 'TestApp', maxAge: 10 })
		)
		expect(mockConnection.init).toHaveBeenCalledWith({ count: 0, name: 'test' })
	})

	it('sends commits with description and patch count', () => {
		const machine = createMachine({ initialState: initialState() }).with(devtools<TestState>())

		machine.mutate(draft => {
			draft.count = 1
		}, 'increment')

		expect(mockConnection.send).toHaveBeenCalledWith(
			{ type: 'increment', patches: 1 },
			expect.objectContaining({ count: 1 }),
			{},
			expect.any(String)
		)
	})

	it('falls back to the operation name when a commit has no description', () => {
		const machine = createMachine({ initialState: initialState() }).with(devtools<TestState>())

		machine.mutate(draft => {
			draft.count = 1
		})

		expect(mockConnection.send).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'mutate' }),
			expect.anything(),
			{},
			expect.any(String)
		)
	})

	it('sends external updates from other plugins, labeled by source', () => {
		let capturedCtx!: PluginContext<TestState>
		createMachine({ initialState: initialState() })
			.with({
				name: 'sync',
				onInit: (ctx: PluginContext<TestState>) => {
					capturedCtx = ctx
				},
			})
			.with(devtools<TestState>())

		capturedCtx.replaceState({ count: 9, name: 'remote' }, { source: 'sync' })

		expect(mockConnection.send).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'external:sync' }),
			expect.objectContaining({ count: 9 }),
			{},
			expect.any(String)
		)
	})

	it('shows undo operations coming from the history plugin', () => {
		const machine = createMachine({ initialState: initialState() })
			.with(devtools<TestState>())
			.with(history<TestState>())

		machine.mutate(draft => {
			draft.count = 1
		}, 'increment')
		mockConnection.send.mockClear()

		machine.undo()

		expect(mockConnection.send).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'increment' }),
			expect.objectContaining({ count: 0 }),
			{},
			expect.any(String)
		)
	})

	describe('time travel', () => {
		it('applies JUMP_TO_STATE via replaceState and clears history', () => {
			const machine = createMachine({ initialState: initialState() })
				.with(devtools<TestState>())
				.with(history<TestState>())

			machine.mutate(draft => {
				draft.count = 1
			})
			expect(machine.canUndo()).toBe(true)
			mockConnection.send.mockClear()

			dispatch({
				type: 'DISPATCH',
				payload: { type: 'JUMP_TO_STATE' },
				state: JSON.stringify({ count: 77, name: 'jumped' }),
			})

			expect(machine.getState()).toEqual({ count: 77, name: 'jumped' })
			expect(machine.canUndo()).toBe(false)
			// Our own time travel must not echo back to the extension
			expect(mockConnection.send).not.toHaveBeenCalled()
		})

		it('rejects prototype pollution in time-travel payloads', () => {
			const machine = createMachine({ initialState: initialState() }).with(
				devtools<TestState>()
			)

			dispatch({
				type: 'DISPATCH',
				payload: { type: 'JUMP_TO_STATE' },
				state: `{"count":5,"__proto__":{"polluted":true}}`,
			})

			expect(({} as Record<string, unknown>).polluted).toBeUndefined()
			expect(Object.prototype.hasOwnProperty.call(machine.getState(), '__proto__')).toBe(
				false
			)
		})
	})

	it('disconnects on destroy', () => {
		const machine = createMachine({ initialState: initialState() }).with(devtools<TestState>())

		const unsubscribe = mockConnection.subscribe.mock.results[0]?.value
		machine.destroy()

		expect(unsubscribe).toHaveBeenCalled()
		expect(mockConnection.unsubscribe).toHaveBeenCalled()
	})

	it('stays inert when the extension is missing', () => {
		delete (window as unknown as Record<string, unknown>).__REDUX_DEVTOOLS_EXTENSION__

		const machine = createMachine({ initialState: initialState() }).with(devtools<TestState>())

		machine.mutate(draft => {
			draft.count = 1
		})

		expect(machine.getState().count).toBe(1)
		expect(mockExtension.connect).not.toHaveBeenCalled()
	})
})
