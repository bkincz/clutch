import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StateMachine } from '../machine'
import { StateSyncManager } from '../sync'
import { BroadcastChannelTransport } from '../transports/broadcast-channel'
import type { SyncTransport } from '../transports/types'

interface TestState {
	count: number
	name: string
}

class TestMachine extends StateMachine<TestState> {
	constructor(config: any) {
		super(config)
	}
}

/*
 *   FAKE TRANSPORT
 ***************************************************************************************************/
interface FakeTransport extends SyncTransport {
	sent: any[]
	deliver: (message: unknown) => void
	emitStatus: (status: 'connecting' | 'connected' | 'disconnected') => void
}

function createFakeTransport(): FakeTransport {
	let messageHandler: ((message: unknown) => void) | null = null
	let statusHandler: ((status: any) => void) | null = null

	return {
		sent: [],
		send(message: unknown) {
			this.sent.push(message)
		},
		onMessage(handler) {
			messageHandler = handler
		},
		onStatusChange(handler) {
			statusHandler = handler
		},
		destroy: vi.fn(),
		deliver(message: unknown) {
			messageHandler?.(message)
		},
		emitStatus(status) {
			statusHandler?.(status)
		},
	}
}

/*
 *   BROADCAST CHANNEL TRANSPORT
 ***************************************************************************************************/
describe('BroadcastChannelTransport', () => {
	let mockChannel: any
	let messageListener: ((event: any) => void) | undefined

	beforeEach(() => {
		messageListener = undefined
		mockChannel = {
			postMessage: vi.fn(),
			close: vi.fn(),
			addEventListener: vi.fn((_type: string, cb: (event: any) => void) => {
				messageListener = cb
			}),
		}

		// @ts-ignore
		global.BroadcastChannel = vi.fn(() => mockChannel)
	})

	afterEach(() => {
		// @ts-ignore
		delete global.BroadcastChannel
	})

	it('should create a channel with the configured name', () => {
		new BroadcastChannelTransport({ channel: 'custom-channel' })

		// @ts-ignore
		expect(global.BroadcastChannel).toHaveBeenCalledWith('custom-channel')
	})

	it('should use the default channel name when none is given', () => {
		new BroadcastChannelTransport()

		// @ts-ignore
		expect(global.BroadcastChannel).toHaveBeenCalledWith('clutch-state-sync')
	})

	it('should post messages on send', () => {
		const transport = new BroadcastChannelTransport()
		const message = { type: 'state_update', payload: 1 }

		transport.send(message)

		expect(mockChannel.postMessage).toHaveBeenCalledWith(message)
	})

	it('should forward inbound messages to the registered handler', () => {
		const transport = new BroadcastChannelTransport()
		const handler = vi.fn()

		transport.onMessage(handler)
		messageListener?.({ data: { type: 'full_sync' } })

		expect(handler).toHaveBeenCalledWith({ type: 'full_sync' })
	})

	it('should ignore inbound messages before a handler is registered', () => {
		new BroadcastChannelTransport()

		expect(() => messageListener?.({ data: { type: 'full_sync' } })).not.toThrow()
	})

	it('should close the channel on destroy', () => {
		const transport = new BroadcastChannelTransport()

		transport.destroy()

		expect(mockChannel.close).toHaveBeenCalled()
	})

	it('should be inert when BroadcastChannel is unsupported', () => {
		// @ts-ignore
		delete global.BroadcastChannel

		expect(() => {
			const transport = new BroadcastChannelTransport()
			transport.send({ type: 'state_update' })
			transport.onMessage(vi.fn())
			transport.destroy()
		}).not.toThrow()
	})
})

/*
 *   STATE SYNC MANAGER + INJECTED TRANSPORT
 ***************************************************************************************************/
describe('StateSyncManager with injected transport', () => {
	let transport: FakeTransport
	let currentState: TestState
	let applied: Array<{ state: TestState; patches?: any[] }>

	const createManager = (config: Record<string, unknown> = {}) =>
		new StateSyncManager<TestState>(
			{ transport, syncDebounce: 10, ...config },
			() => currentState,
			(state, patches) => {
				applied.push({ state, patches })
			}
		)

	beforeEach(() => {
		vi.useFakeTimers()
		transport = createFakeTransport()
		currentState = { count: 0, name: 'test' }
		applied = []
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	const remoteMessage = (overrides: Record<string, unknown>) => ({
		instanceId: 'remote_instance',
		timestamp: Date.now(),
		state: undefined,
		patches: undefined,
		inversePatches: undefined,
		description: undefined,
		...overrides,
	})

	it('should not construct a BroadcastChannel when a transport is injected', () => {
		const spy = vi.fn()
		// @ts-ignore
		global.BroadcastChannel = spy

		createManager()

		expect(spy).not.toHaveBeenCalled()
		// @ts-ignore
		delete global.BroadcastChannel
	})

	it('should request a full sync on initialization', () => {
		createManager()

		expect(transport.sent).toHaveLength(1)
		expect(transport.sent[0].type).toBe('full_sync')
	})

	it('should send debounced state updates through the transport', () => {
		const syncManager = createManager({ mergeStrategy: 'latest' })

		syncManager.broadcastChange({ count: 1, name: 'test' }, [], [])
		syncManager.broadcastChange({ count: 2, name: 'test' }, [], [])
		expect(transport.sent.filter(m => m.type === 'state_update')).toHaveLength(0)

		vi.advanceTimersByTime(20)

		const updates = transport.sent.filter(m => m.type === 'state_update')
		expect(updates).toHaveLength(1)
		expect(updates[0].state).toEqual({ count: 2, name: 'test' })
	})

	it('should apply remote full-state updates', () => {
		createManager({ mergeStrategy: 'latest' })

		transport.deliver(
			remoteMessage({ type: 'state_update', state: { count: 7, name: 'remote' } })
		)

		expect(applied).toHaveLength(1)
		expect(applied[0].state).toEqual({ count: 7, name: 'remote' })
	})

	it('should apply remote patches', () => {
		createManager({ mergeStrategy: 'patches' })

		transport.deliver(
			remoteMessage({
				type: 'patches',
				patches: [{ op: 'replace', path: ['count'], value: 42 }],
			})
		)

		expect(applied).toHaveLength(1)
		expect(applied[0].state.count).toBe(42)
	})

	it('should ignore messages from itself', () => {
		createManager()
		const ownInstanceId = transport.sent[0].instanceId

		transport.deliver(
			remoteMessage({
				type: 'state_update',
				instanceId: ownInstanceId,
				state: { count: 9, name: 'self' },
			})
		)

		expect(applied).toHaveLength(0)
	})

	it('should reject messages with out-of-window timestamps', () => {
		createManager()

		transport.deliver(
			remoteMessage({
				type: 'state_update',
				timestamp: Date.now() - 120000,
				state: { count: 9, name: 'old' },
			})
		)

		expect(applied).toHaveLength(0)
	})

	it('should reject stale messages older than the last applied one', () => {
		createManager()
		const now = Date.now()

		transport.deliver(
			remoteMessage({ type: 'state_update', timestamp: now, state: { count: 1, name: 'a' } })
		)
		transport.deliver(
			remoteMessage({
				type: 'state_update',
				timestamp: now - 1,
				state: { count: 2, name: 'b' },
			})
		)

		expect(applied).toHaveLength(1)
		expect(applied[0].state.count).toBe(1)
	})

	it('should reject states with dangerous properties', () => {
		createManager()

		transport.deliver(
			remoteMessage({
				type: 'state_update',
				state: JSON.parse('{"count": 1, "name": "x", "constructor": {}}'),
			})
		)

		expect(applied).toHaveLength(0)
	})

	it('should reject patches targeting dangerous paths', () => {
		createManager({ mergeStrategy: 'patches' })

		transport.deliver(
			remoteMessage({
				type: 'patches',
				patches: [{ op: 'replace', path: ['__proto__', 'polluted'], value: true }],
			})
		)

		expect(applied).toHaveLength(0)
	})

	it('should answer full-sync requests with the current state', () => {
		createManager()
		currentState = { count: 33, name: 'current' }

		transport.deliver(remoteMessage({ type: 'full_sync' }))

		const updates = transport.sent.filter(m => m.type === 'state_update')
		expect(updates).toHaveLength(1)
		expect(updates[0].state).toEqual({ count: 33, name: 'current' })
	})

	it('should destroy the transport on destroy', () => {
		const syncManager = createManager()

		syncManager.destroy()

		expect(transport.destroy).toHaveBeenCalled()
	})
})

/*
 *   DEFERRED HYDRATION + SYNC ORDERING
 ***************************************************************************************************/
describe('Deferred hydration sync ordering', () => {
	beforeEach(() => {
		localStorage.clear()
		// @ts-ignore
		global.BroadcastChannel = vi.fn(() => ({
			postMessage: vi.fn(),
			close: vi.fn(),
			addEventListener: vi.fn(),
		}))
	})

	afterEach(() => {
		localStorage.clear()
		// @ts-ignore
		delete global.BroadcastChannel
	})

	it('should not start sync before hydrateFromPersisted when hydration is deferred', () => {
		const machine = new TestMachine({
			initialState: { count: 0, name: 'test' },
			persistenceKey: 'deferred-sync-test',
			deferredHydration: true,
			enableSync: true,
		})

		// @ts-ignore
		expect(global.BroadcastChannel).not.toHaveBeenCalled()

		machine.hydrateFromPersisted()

		// @ts-ignore
		expect(global.BroadcastChannel).toHaveBeenCalled()
	})

	it('should start sync at construction when hydration is not deferred', () => {
		new TestMachine({
			initialState: { count: 0, name: 'test' },
			enableSync: true,
		})

		// @ts-ignore
		expect(global.BroadcastChannel).toHaveBeenCalled()
	})

	it('should ignore remote updates delivered before hydration', () => {
		const transport = createFakeTransport()
		const machine = new TestMachine({
			initialState: { count: 0, name: 'test' },
			persistenceKey: 'deferred-remote-test',
			deferredHydration: true,
			enableSync: { transport },
		})

		// Sync not initialized yet: transport has no handler, delivery is a no-op
		transport.deliver({
			type: 'state_update',
			instanceId: 'remote',
			timestamp: Date.now(),
			state: { count: 99, name: 'remote' },
		})

		expect(machine.getState().count).toBe(0)

		machine.hydrateFromPersisted()

		// Post-hydration, sync is live and a full-sync request was issued
		expect(transport.sent.some(m => m.type === 'full_sync')).toBe(true)
	})
})
