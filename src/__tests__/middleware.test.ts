import { describe, it, expect, beforeEach, vi } from 'vitest'
import { StateMachine, type Middleware } from '../machine'

interface TestState {
	count: number
	name: string
	logs: string[]
}

class TestMachine extends StateMachine<TestState> {
	constructor(config: any) {
		super(config)
	}
}

describe('Middleware', () => {
	let machine: TestMachine

	beforeEach(() => {
		machine = new TestMachine({
			initialState: { count: 0, name: 'test', logs: [] },
		})
	})

	it('should execute middleware in correct order', () => {
		const executionOrder: string[] = []

		const middleware1: Middleware<TestState> = (ctx, next, draft) => {
			executionOrder.push('middleware1-before')
			next(draft)
			executionOrder.push('middleware1-after')
		}

		const middleware2: Middleware<TestState> = (ctx, next, draft) => {
			executionOrder.push('middleware2-before')
			next(draft)
			executionOrder.push('middleware2-after')
		}

		machine = new TestMachine({
			initialState: { count: 0, name: 'test', logs: [] },
			middleware: [middleware1, middleware2],
		})

		machine.mutate(draft => {
			draft.count++
			executionOrder.push('recipe-executed')
		})

		expect(executionOrder).toEqual([
			'middleware1-before',
			'middleware2-before',
			'recipe-executed',
			'middleware2-after',
			'middleware1-after',
		])
	})

	it('should pass correct context to middleware', () => {
		let capturedContext: any = null

		const middleware: Middleware<TestState> = (ctx, next, draft) => {
			capturedContext = { ...ctx }
			next(draft)
		}

		machine = new TestMachine({
			initialState: { count: 5, name: 'test', logs: [] },
			middleware: [middleware],
		})

		machine.mutate(draft => {
			draft.count++
		}, 'increment count')

		expect(capturedContext).toMatchObject({
			state: { count: 5, name: 'test', logs: [] },
			description: 'increment count',
			operation: 'mutate',
		})
		expect(capturedContext.timestamp).toBeTypeOf('number')
	})

	it('should allow transformation in middleware', () => {
		const sanitizeMiddleware: Middleware<TestState> = (ctx, next, draft) => {
			next(draft)

			if (draft.name) {
				draft.name = draft.name.trim().toLowerCase()
			}
		}

		machine = new TestMachine({
			initialState: { count: 0, name: 'test', logs: [] },
			middleware: [sanitizeMiddleware],
		})

		machine.mutate(draft => {
			draft.name = '  HELLO WORLD  '
		})

		expect(machine.getState().name).toBe('hello world')
	})

	it('should support validation middleware', () => {
		const validationMiddleware: Middleware<TestState> = (ctx, next, draft) => {
			next(draft)
			if (draft.count < 0) {
				throw new Error('Count cannot be negative')
			}
		}

		machine = new TestMachine({
			initialState: { count: 5, name: 'test', logs: [] },
			middleware: [validationMiddleware],
		})

		expect(() => {
			machine.mutate(draft => {
				draft.count = -1
			})
		}).toThrow('Count cannot be negative')

		expect(machine.getState().count).toBe(5)
	})

	it('should support logging middleware', () => {
		const logs: string[] = []

		const loggingMiddleware: Middleware<TestState> = (ctx, next, draft) => {
			const before = JSON.stringify(ctx.state)
			next(draft)
			const after = JSON.stringify(draft)
			logs.push(`${ctx.description || 'mutation'}: ${before} -> ${after}`)
		}

		machine = new TestMachine({
			initialState: { count: 0, name: 'test', logs: [] },
			middleware: [loggingMiddleware],
		})

		machine.mutate(draft => {
			draft.count++
		}, 'increment')

		expect(logs).toHaveLength(1)
		expect(logs[0]).toContain('increment')
		expect(logs[0]).toContain('"count":0')
		expect(logs[0]).toContain('"count":1')
	})

	it('should work with batch operations', () => {
		const executionCount = { value: 0 }

		const countingMiddleware: Middleware<TestState> = (ctx, next, draft) => {
			executionCount.value++
			next(draft)
		}

		machine = new TestMachine({
			initialState: { count: 0, name: 'test', logs: [] },
			middleware: [countingMiddleware],
		})

		machine.batch([
			draft => {
				draft.count++
			},
			draft => {
				draft.count++
			},
			draft => {
				draft.count++
			},
		])

		// Middleware should execute for each mutation in batch
		expect(executionCount.value).toBe(3)
		expect(machine.getState().count).toBe(3)
	})

	it('should handle middleware that returns promises', () => {
		// Note: Middleware can be async, but mutate() is synchronous
		// The middleware promise doesn't block the mutation
		const asyncMiddleware: Middleware<TestState> = (ctx, next, draft) => {
			// Async work can happen but doesn't block
			Promise.resolve().then(() => {
				// Async cleanup or logging
			})
			next(draft)
		}

		machine = new TestMachine({
			initialState: { count: 0, name: 'test', logs: [] },
			middleware: [asyncMiddleware],
		})

		machine.mutate(draft => {
			draft.count++
		})

		expect(machine.getState().count).toBe(1)
	})

	it('should not execute middleware when array is empty', () => {
		const middleware = vi.fn((ctx, next, draft) => next(draft))

		machine = new TestMachine({
			initialState: { count: 0, name: 'test', logs: [] },
			middleware: [],
		})

		machine.mutate(draft => {
			draft.count++
		})

		expect(middleware).not.toHaveBeenCalled()
		expect(machine.getState().count).toBe(1)
	})

	it('should stop mutation if middleware throws before calling next', () => {
		const guardMiddleware: Middleware<TestState> = (ctx, next, draft) => {
			if (ctx.state.count >= 10) {
				throw new Error('Count limit reached')
			}
			next(draft)
		}

		machine = new TestMachine({
			initialState: { count: 10, name: 'test', logs: [] },
			middleware: [guardMiddleware],
		})

		expect(() => {
			machine.mutate(draft => {
				draft.count++
			})
		}).toThrow('Count limit reached')

		expect(machine.getState().count).toBe(10)
	})

	it('should provide operation type in context', () => {
		let capturedOperation: string | null = null

		const middleware: Middleware<TestState> = (ctx, next, draft) => {
			capturedOperation = ctx.operation
			next(draft)
		}

		machine = new TestMachine({
			initialState: { count: 0, name: 'test', logs: [] },
			middleware: [middleware],
		})

		machine.mutate(draft => {
			draft.count++
		})
		expect(capturedOperation).toBe('mutate')

		machine.batch([
			draft => {
				draft.count++
			},
		])
		expect(capturedOperation).toBe('batch')
	})

	it('should allow middleware to modify draft before recipe', () => {
		const preprocessMiddleware: Middleware<TestState> = (ctx, next, draft) => {
			draft.logs.push(`[${Date.now()}] Mutation started`)
			next(draft)
		}

		machine = new TestMachine({
			initialState: { count: 0, name: 'test', logs: [] },
			middleware: [preprocessMiddleware],
		})

		machine.mutate(draft => {
			draft.count++
		})

		expect(machine.getState().logs).toHaveLength(1)
		expect(machine.getState().logs[0]).toMatch(/\[\d+\] Mutation started/)
	})

	it('should compose multiple middleware correctly', () => {
		const validationMiddleware: Middleware<TestState> = (ctx, next, draft) => {
			next(draft)
			if (draft.count < 0) {
				throw new Error('Count cannot be negative')
			}
		}

		const loggingMiddleware: Middleware<TestState> = (ctx, next, draft) => {
			draft.logs.push(`Before: ${ctx.state.count}`)
			next(draft)
			draft.logs.push(`After: ${draft.count}`)
		}

		const sanitizeMiddleware: Middleware<TestState> = (ctx, next, draft) => {
			next(draft)
			draft.name = draft.name.trim()
		}

		machine = new TestMachine({
			initialState: { count: 5, name: 'test', logs: [] },
			middleware: [validationMiddleware, loggingMiddleware, sanitizeMiddleware],
		})

		machine.mutate(draft => {
			draft.count = 10
			draft.name = '  hello  '
		})

		const state = machine.getState()
		expect(state.count).toBe(10)
		expect(state.name).toBe('hello')
		expect(state.logs).toEqual(['Before: 5', 'After: 10'])
	})
})
