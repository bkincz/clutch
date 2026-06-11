import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Middleware } from '../machine'
import { createV2Machine } from '../compat'
import type { TransportStatus } from '../transports/types'

interface TestState {
	count: number
	name: string
}

const initialState = (): TestState => ({ count: 0, name: 'test' })

const createMockTransport = () => {
	const sent: Array<{ type: string }> = []
	let messageHandler: ((message: unknown) => void) | null = null

	return {
		sent,
		send: vi.fn((message: unknown) => {
			sent.push(message as { type: string })
		}),
		onMessage: (handler: (message: unknown) => void) => {
			messageHandler = handler
		},
		onStatusChange: (_handler: (status: TransportStatus) => void) => {},
		start: vi.fn(),
		destroy: vi.fn(),
		receive: (message: unknown) => messageHandler?.(message),
	}
}

describe('compat createV2Machine', () => {
	beforeEach(() => {
		;(localStorage.setItem as unknown as ReturnType<typeof vi.fn>).mockClear()
	})

	describe('full v2 surface on a minimal config', () => {
		it('exposes every v2 method even when features are not configured', async () => {
			const machine = createV2Machine({ initialState: initialState() })

			machine.mutate(draft => {
				draft.count = 1
			})
			expect(machine.undo()).toBe(true)
			expect(machine.getState().count).toBe(0)

			// Unconfigured features answer like v2 no-ops instead of crashing
			expect(machine.hydrate()).toBe(false)
			expect(machine.isHydrated()).toBe(true)
			expect(() => machine.flush()).not.toThrow()
			expect(() => machine.startSync()).not.toThrow()
			expect(() => machine.hydrateFromPersisted()).not.toThrow()

			machine.mutate(draft => {
				draft.count = 2
			})
			await expect(machine.forceSave()).resolves.toBeUndefined()
			expect(machine.hasUnsavedChanges()).toBe(false)
		})
	})

	it('honors maxHistorySize', () => {
		const machine = createV2Machine({ initialState: initialState(), maxHistorySize: 1 })

		machine.mutate(draft => {
			draft.count = 1
		})
		machine.mutate(draft => {
			draft.count = 2
		})

		expect(machine.undo()).toBe(true)
		expect(machine.undo()).toBe(false)
		expect(machine.getState().count).toBe(1)
	})

	it('wires validateState as a commit veto', () => {
		const machine = createV2Machine({
			initialState: initialState(),
			validateState: state => state.count >= 0,
		})

		expect(() =>
			machine.mutate(draft => {
				draft.count = -1
			})
		).toThrow('State validation failed')
		expect(machine.getState().count).toBe(0)
	})

	it('runs v2 recipe middleware in v2 order', () => {
		const order: string[] = []

		const middleware1: Middleware<TestState> = (_ctx, next, draft) => {
			order.push('m1-before')
			next(draft)
			order.push('m1-after')
		}
		const middleware2: Middleware<TestState> = (ctx, next, draft) => {
			order.push(`m2-before:${ctx.operation}`)
			next(draft)
			order.push('m2-after')
		}

		const machine = createV2Machine({
			initialState: initialState(),
			middleware: [middleware1, middleware2],
		})

		machine.mutate(draft => {
			draft.count = 1
			order.push('recipe')
		})

		expect(order).toEqual(['m1-before', 'm2-before:mutate', 'recipe', 'm2-after', 'm1-after'])
		expect(machine.getState().count).toBe(1)
	})

	describe('persistence', () => {
		it('writes through localStorage on flush', () => {
			const machine = createV2Machine({
				initialState: initialState(),
				persistenceKey: 'compat-key',
			})

			machine.mutate(draft => {
				draft.count = 3
			})
			machine.flush()

			expect(localStorage.setItem).toHaveBeenCalledWith(
				'compat-key',
				expect.stringContaining('"count":3')
			)
		})

		it('defers hydration until hydrateFromPersisted()', () => {
			const machine = createV2Machine({
				initialState: initialState(),
				persistenceKey: 'compat-key',
				deferredHydration: true,
			})

			expect(machine.isHydrated()).toBe(false)
			machine.hydrateFromPersisted()
			expect(machine.isHydrated()).toBe(true)
		})
	})

	it('connects to DevTools when enabled', () => {
		const mockConnection = {
			init: vi.fn(),
			send: vi.fn(),
			subscribe: vi.fn(() => vi.fn()),
			unsubscribe: vi.fn(),
		}
		const mockExtension = { connect: vi.fn(() => mockConnection) }
		;(window as unknown as Record<string, unknown>).__REDUX_DEVTOOLS_EXTENSION__ = mockExtension

		try {
			createV2Machine({
				initialState: initialState(),
				enableDevTools: { name: 'CompatApp' },
			})

			expect(mockExtension.connect).toHaveBeenCalledWith(
				expect.objectContaining({ name: 'CompatApp' })
			)
			expect(mockConnection.init).toHaveBeenCalled()
		} finally {
			delete (window as unknown as Record<string, unknown>).__REDUX_DEVTOOLS_EXTENSION__
		}
	})

	describe('sync', () => {
		it('starts immediately without deferred hydration', () => {
			const transport = createMockTransport()

			createV2Machine({
				initialState: initialState(),
				enableSync: { transport },
			})

			expect(transport.start).toHaveBeenCalled()
			expect(transport.sent[0]).toMatchObject({ type: 'full_sync' })
		})

		it('waits for hydrateFromPersisted when hydration is deferred', () => {
			const transport = createMockTransport()

			const machine = createV2Machine({
				initialState: initialState(),
				enableSync: { transport },
				deferredHydration: true,
			})

			expect(transport.start).not.toHaveBeenCalled()

			machine.hydrateFromPersisted()

			expect(transport.start).toHaveBeenCalled()
			expect(transport.sent[0]).toMatchObject({ type: 'full_sync' })
		})
	})

	describe('server persistence callbacks', () => {
		it('forceSave runs saveToServer and then flushes localStorage', async () => {
			const saveToServer = vi.fn()
			const machine = createV2Machine({
				initialState: initialState(),
				persistenceKey: 'compat-key',
				saveToServer,
			})

			machine.mutate(draft => {
				draft.count = 4
			})
			await machine.forceSave()

			expect(saveToServer).toHaveBeenCalledWith(expect.objectContaining({ count: 4 }))
			expect(localStorage.setItem).toHaveBeenCalledWith(
				'compat-key',
				expect.stringContaining('"count":4')
			)
		})

		it('loadFromServerManually applies server state', async () => {
			const machine = createV2Machine({
				initialState: initialState(),
				loadFromServer: () => ({ count: 99, name: 'server' }),
			})

			await expect(machine.loadFromServerManually()).resolves.toBe(true)
			expect(machine.getState()).toEqual({ count: 99, name: 'server' })
		})
	})

	describe('enableAutoSave: false', () => {
		beforeEach(() => {
			vi.useFakeTimers()
		})

		afterEach(() => {
			vi.useRealTimers()
		})

		it('keeps forceSave but never saves on a timer', async () => {
			const saveToServer = vi.fn()
			const machine = createV2Machine({
				initialState: initialState(),
				enableAutoSave: false,
				autoSaveIntervalMs: 1000,
				saveToServer,
			})

			machine.mutate(draft => {
				draft.count = 1
			})

			await vi.advanceTimersByTimeAsync(3000)
			expect(saveToServer).not.toHaveBeenCalled()

			await machine.forceSave()
			expect(saveToServer).toHaveBeenCalledTimes(1)
		})
	})

	describe('lifecycle events', () => {
		it('bridges afterMutate and destroy, with working unsubscribe', () => {
			const machine = createV2Machine({ initialState: initialState() })
			const afterMutate = vi.fn()
			const onDestroy = vi.fn()

			const off = machine.on('afterMutate', afterMutate)
			machine.on('destroy', onDestroy)

			machine.mutate(draft => {
				draft.count = 1
			}, 'increment')

			expect(afterMutate).toHaveBeenCalledWith(
				expect.objectContaining({
					description: 'increment',
					operation: 'mutate',
					state: expect.objectContaining({ count: 1 }),
				})
			)

			off()
			machine.mutate(draft => {
				draft.count = 2
			})
			expect(afterMutate).toHaveBeenCalledTimes(1)

			machine.destroy()
			expect(onDestroy).toHaveBeenCalledWith({
				finalState: expect.objectContaining({ count: 2 }),
			})
		})
	})

	it('applyPatchSet applies patches as an undoable mutation', () => {
		const machine = createV2Machine({ initialState: initialState() })

		machine.applyPatchSet([{ op: 'replace', path: ['count'], value: 8 }], 'patched')

		expect(machine.getState().count).toBe(8)
		expect(machine.undo()).toBe(true)
		expect(machine.getState().count).toBe(0)
	})
})
