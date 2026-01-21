import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StateMachine } from '../machine'

interface TestState {
	count: number
	name: string
}

class TestMachine extends StateMachine<TestState> {
	constructor(config: any) {
		super(config)
	}
}

describe('DevTools Integration', () => {
	let mockExtension: any
	let mockConnection: any

	beforeEach(() => {
		// Mock Redux DevTools Extension
		mockConnection = {
			init: vi.fn(),
			send: vi.fn(),
			subscribe: vi.fn(() => vi.fn()), // Returns unsubscribe function
			unsubscribe: vi.fn(),
		}

		mockExtension = {
			connect: vi.fn(() => mockConnection),
		}

		// @ts-ignore - Mocking window object
		global.window = {
			__REDUX_DEVTOOLS_EXTENSION__: mockExtension,
		} as any
	})

	afterEach(() => {
		// @ts-ignore
		delete global.window
	})

	it('should connect to DevTools extension when enabled', () => {
		new TestMachine({
			initialState: { count: 0, name: 'test' },
			enableDevTools: true,
		})

		expect(mockExtension.connect).toHaveBeenCalledWith(
			expect.objectContaining({
				name: 'StateMachine',
			})
		)
	})

	it('should use custom name from config', () => {
		new TestMachine({
			initialState: { count: 0, name: 'test' },
			enableDevTools: {
				name: 'MyApp',
			},
		})

		expect(mockExtension.connect).toHaveBeenCalledWith(
			expect.objectContaining({
				name: 'MyApp',
			})
		)
	})

	it('should initialize DevTools with current state', () => {
		const initialState = { count: 5, name: 'test' }
		new TestMachine({
			initialState,
			enableDevTools: true,
		})

		expect(mockConnection.init).toHaveBeenCalledWith(initialState)
	})

	it('should send action to DevTools on mutate', () => {
		const machine = new TestMachine({
			initialState: { count: 0, name: 'test' },
			enableDevTools: true,
		})

		machine.mutate(draft => {
			draft.count++
		}, 'increment count')

		expect(mockConnection.send).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'increment count',
			}),
			{ count: 1, name: 'test' },
			{},
			expect.any(String)
		)
	})

	it('should send default action name if no description provided', () => {
		const machine = new TestMachine({
			initialState: { count: 0, name: 'test' },
			enableDevTools: true,
		})

		machine.mutate(draft => {
			draft.count++
		})

		expect(mockConnection.send).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'State Mutated',
			}),
			expect.any(Object),
			{},
			expect.any(String)
		)
	})

	it('should send batch operations to DevTools', () => {
		const machine = new TestMachine({
			initialState: { count: 0, name: 'test' },
			enableDevTools: true,
		})

		machine.batch(
			[
				draft => {
					draft.count++
				},
				draft => {
					draft.count++
				},
			],
			'batch increment'
		)

		expect(mockConnection.send).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'batch increment',
			}),
			{ count: 2, name: 'test' },
			{},
			expect.any(String)
		)
	})

	it('should handle time-travel from DevTools', () => {
		const machine = new TestMachine({
			initialState: { count: 0, name: 'test' },
			enableDevTools: true,
		})

		machine.mutate(draft => {
			draft.count = 5
		})

		// Simulate DevTools time-travel
		const subscribeCallback = mockConnection.subscribe.mock.calls[0][0]
		subscribeCallback({
			type: 'DISPATCH',
			payload: { type: 'JUMP_TO_STATE' },
			state: JSON.stringify({ count: 2, name: 'test' }),
		})

		expect(machine.getState()).toEqual({ count: 2, name: 'test' })
	})

	it('should clear history on time-travel', () => {
		const machine = new TestMachine({
			initialState: { count: 0, name: 'test' },
			enableDevTools: true,
		})

		machine.mutate(draft => {
			draft.count++
		})
		machine.mutate(draft => {
			draft.count++
		})

		expect(machine.canUndo()).toBe(true)

		// Time-travel
		const subscribeCallback = mockConnection.subscribe.mock.calls[0][0]
		subscribeCallback({
			type: 'DISPATCH',
			payload: { type: 'JUMP_TO_STATE' },
			state: JSON.stringify({ count: 1, name: 'test' }),
		})

		// History should be cleared after time-travel
		expect(machine.canUndo()).toBe(false)
	})

	it('should handle IMPORT_STATE from DevTools', () => {
		const machine = new TestMachine({
			initialState: { count: 0, name: 'test' },
			enableDevTools: true,
		})

		const subscribeCallback = mockConnection.subscribe.mock.calls[0][0]
		subscribeCallback({
			type: 'DISPATCH',
			payload: {
				type: 'IMPORT_STATE',
				nextLiftedState: {
					computedStates: [
						{ state: { count: 1, name: 'test' } },
						{ state: { count: 2, name: 'test' } },
						{ state: { count: 3, name: 'imported' } },
					],
				},
			},
		})

		expect(machine.getState()).toEqual({ count: 3, name: 'imported' })
	})

	it('should disconnect from DevTools on destroy', () => {
		const machine = new TestMachine({
			initialState: { count: 0, name: 'test' },
			enableDevTools: true,
		})

		const unsubscribe = mockConnection.subscribe.mock.results[0].value
		machine.destroy()

		expect(unsubscribe).toHaveBeenCalled()
		expect(mockConnection.unsubscribe).toHaveBeenCalled()
	})

	it('should gracefully handle missing DevTools extension', () => {
		// Remove extension
		// @ts-ignore
		global.window = {} as any

		// Should not throw
		expect(() => {
			new TestMachine({
				initialState: { count: 0, name: 'test' },
				enableDevTools: true,
			})
		}).not.toThrow()
	})

	it('should not send to DevTools when disabled', () => {
		const machine = new TestMachine({
			initialState: { count: 0, name: 'test' },
			enableDevTools: false,
		})

		machine.mutate(draft => {
			draft.count++
		})

		expect(mockExtension.connect).not.toHaveBeenCalled()
		expect(mockConnection.send).not.toHaveBeenCalled()
	})

	it('should include patch count in action payload', () => {
		const machine = new TestMachine({
			initialState: { count: 0, name: 'test' },
			enableDevTools: true,
		})

		machine.mutate(draft => {
			draft.count++
			draft.name = 'updated'
		})

		expect(mockConnection.send).toHaveBeenCalledWith(
			expect.objectContaining({
				patches: 2, // count and name changed
			}),
			expect.any(Object),
			{},
			expect.any(String)
		)
	})

	it('should support custom DevTools config', () => {
		new TestMachine({
			initialState: { count: 0, name: 'test' },
			enableDevTools: {
				name: 'CustomApp',
				maxAge: 100,
				latency: 300,
				features: {
					jump: true,
					skip: false,
					export: true,
					import: false,
				},
			},
		})

		expect(mockExtension.connect).toHaveBeenCalledWith(
			expect.objectContaining({
				name: 'CustomApp',
				maxAge: 100,
				latency: 300,
				features: {
					jump: true,
					skip: false,
					export: true,
					import: false,
				},
			})
		)
	})

	it('should handle time-travel validation errors gracefully', () => {
		const machine = new TestMachine({
			initialState: { count: 0, name: 'test' },
			validateState: (state: TestState) => state.count >= 0,
			enableDevTools: true,
		})

		const subscribeCallback = mockConnection.subscribe.mock.calls[0][0]

		// Try to time-travel to invalid state
		subscribeCallback({
			type: 'DISPATCH',
			payload: { type: 'JUMP_TO_STATE' },
			state: JSON.stringify({ count: -1, name: 'test' }),
		})

		// State should remain unchanged
		expect(machine.getState().count).toBe(0)
	})

	it('should work in non-browser environment', () => {
		// Remove window
		// @ts-ignore
		global.window = undefined

		// Should not throw
		expect(() => {
			new TestMachine({
				initialState: { count: 0, name: 'test' },
				enableDevTools: true,
			})
		}).not.toThrow()
	})
})
