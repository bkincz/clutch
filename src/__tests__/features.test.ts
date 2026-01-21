import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StateMachine, type Middleware } from '../machine'

interface TestState {
	count: number
	name: string
	secret?: string
}

class TestMachine extends StateMachine<TestState> {
	constructor(config: any) {
		super(config)
	}
}

describe('New Features Integration Tests', () => {
	beforeEach(() => {
		localStorage.clear()
	})

	afterEach(() => {
		localStorage.clear()
	})

	describe('Middleware', () => {
		it('should execute middleware before mutation', () => {
			const executionLog: string[] = []

			const loggingMiddleware: Middleware<TestState> = (_ctx, next, draft) => {
				executionLog.push('before')
				next(draft)
				executionLog.push('after')
			}

			const machine = new TestMachine({
				initialState: { count: 0, name: 'test' },
				middleware: [loggingMiddleware],
			})

			machine.mutate(draft => {
				draft.count = 5
				executionLog.push('mutate')
			})

			expect(executionLog).toEqual(['before', 'mutate', 'after'])
			expect(machine.getState().count).toBe(5)
		})

		it('should allow validation in middleware', () => {
			const validationMiddleware: Middleware<TestState> = (_ctx, next, draft) => {
				next(draft)
				if (draft.count < 0) {
					throw new Error('Invalid count')
				}
			}

			const machine = new TestMachine({
				initialState: { count: 0, name: 'test' },
				middleware: [validationMiddleware],
			})

			expect(() => {
				machine.mutate(draft => {
					draft.count = -1
				})
			}).toThrow('Invalid count')

			expect(machine.getState().count).toBe(0)
		})

		it('should compose multiple middleware', () => {
			const m1: Middleware<TestState> = (_ctx, next, draft) => {
				draft.name = `${draft.name}-m1`
				next(draft)
			}

			const m2: Middleware<TestState> = (_ctx, next, draft) => {
				draft.name = `${draft.name}-m2`
				next(draft)
			}

			const machine = new TestMachine({
				initialState: { count: 0, name: 'start' },
				middleware: [m1, m2],
			})

			machine.mutate(draft => {
				draft.name = `${draft.name}-mutate`
			})

			expect(machine.getState().name).toContain('m1')
			expect(machine.getState().name).toContain('m2')
			expect(machine.getState().name).toContain('mutate')
		})
	})

	describe('Selective Persistence', () => {
		it('should accept filter configuration', () => {
			// Test that the config is accepted without errors
			const machine = new TestMachine({
				initialState: { count: 0, name: 'test', secret: 'password' },
				persistenceKey: 'test-exclude',
				persistenceFilter: {
					exclude: ['secret'],
				},
			})

			machine.mutate(draft => {
				draft.count = 10
			})

			expect(machine.getState().count).toBe(10)
		})

		it('should accept include filter configuration', () => {
			const machine = new TestMachine({
				initialState: { count: 0, name: 'test', secret: 'password' },
				persistenceKey: 'test-include',
				persistenceFilter: {
					include: ['count', 'name'],
				},
			})

			machine.mutate(draft => {
				draft.name = 'updated'
			})

			expect(machine.getState().name).toBe('updated')
		})

		it('should accept custom filter configuration', () => {
			const machine = new TestMachine({
				initialState: { count: 0, name: 'test', secret: 'password' },
				persistenceKey: 'test-custom',
				persistenceFilter: {
					custom: (state: TestState) => ({ count: state.count, name: state.name }),
				},
			})

			machine.mutate(draft => {
				draft.count = 99
			})

			expect(machine.getState().count).toBe(99)
		})
	})

	describe('DevTools Integration', () => {
		let mockConnection: any

		beforeEach(() => {
			mockConnection = {
				init: vi.fn(),
				send: vi.fn(),
				subscribe: vi.fn(() => vi.fn()),
				unsubscribe: vi.fn(),
			}

			// @ts-ignore
			global.window = {
				__REDUX_DEVTOOLS_EXTENSION__: {
					connect: vi.fn(() => mockConnection),
				},
			} as any
		})

		afterEach(() => {
			// @ts-ignore
			delete global.window
		})

		it('should connect to DevTools when enabled', () => {
			new TestMachine({
				initialState: { count: 0, name: 'test' },
				enableDevTools: true,
			})

			expect(mockConnection.init).toHaveBeenCalled()
		})

		it('should send mutations to DevTools', () => {
			const machine = new TestMachine({
				initialState: { count: 0, name: 'test' },
				enableDevTools: true,
			})

			machine.mutate(draft => {
				draft.count = 5
			}, 'test mutation')

			expect(mockConnection.send).toHaveBeenCalledWith(
				expect.objectContaining({ type: 'test mutation' }),
				expect.objectContaining({ count: 5 }),
				{},
				expect.any(String)
			)
		})

		it('should not crash when DevTools is unavailable', () => {
			// @ts-ignore
			delete global.window

			expect(() => {
				new TestMachine({
					initialState: { count: 0, name: 'test' },
					enableDevTools: true,
				})
			}).not.toThrow()
		})
	})

	describe('Multi-instance Sync', () => {
		let mockChannel: any

		beforeEach(() => {
			mockChannel = {
				postMessage: vi.fn(),
				close: vi.fn(),
				addEventListener: vi.fn(),
			}

			// @ts-ignore
			global.BroadcastChannel = vi.fn(() => mockChannel)
		})

		afterEach(() => {
			// @ts-ignore
			delete global.BroadcastChannel
		})

		it('should create BroadcastChannel when enabled', () => {
			new TestMachine({
				initialState: { count: 0, name: 'test' },
				enableSync: true,
			})

			// @ts-ignore
			expect(global.BroadcastChannel).toHaveBeenCalled()
		})

		it('should broadcast mutations', () => {
			const machine = new TestMachine({
				initialState: { count: 0, name: 'test' },
				enableSync: { mergeStrategy: 'latest' },
			})

			machine.mutate(draft => {
				draft.count = 10
			})

			// Should post at least one message (may include initial sync request)
			expect(mockChannel.postMessage).toHaveBeenCalled()
		})

		it('should not crash when BroadcastChannel is unavailable', () => {
			// @ts-ignore
			delete global.BroadcastChannel

			expect(() => {
				new TestMachine({
					initialState: { count: 0, name: 'test' },
					enableSync: true,
				})
			}).not.toThrow()
		})
	})

	describe('Feature Combinations', () => {
		it('should work with all features enabled', () => {
			const middleware: Middleware<TestState> = (_ctx, next, draft) => {
				next(draft)
				if (draft.count > 100) {
					draft.count = 100
				}
			}

			const machine = new TestMachine({
				initialState: { count: 0, name: 'test', secret: 'password' },
				middleware: [middleware],
				persistenceKey: 'test-all-features',
				persistenceFilter: {
					exclude: ['secret'],
				},
				enableDevTools: false,
				enableSync: false,
			})

			machine.mutate(draft => {
				draft.count = 150
			})

			// Middleware should cap at 100
			expect(machine.getState().count).toBe(100)
		})
	})
})
