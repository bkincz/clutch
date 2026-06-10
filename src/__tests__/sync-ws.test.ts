import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StateSyncManager } from '../sync'
import { WebSocketTransport } from '../transports/websocket'
import type { SyncTransport, TransportStatus } from '../transports/types'

interface TestState {
	count: number
	name: string
}

/*
 *   MOCK WEBSOCKET
 ***************************************************************************************************/
class MockWebSocket {
	static instances: MockWebSocket[] = []

	readyState = 0 // CONNECTING
	sent: string[] = []
	closed = false
	listeners: Record<string, Array<(event: any) => void>> = {}

	constructor(
		public url: string,
		public protocols?: string | string[]
	) {
		MockWebSocket.instances.push(this)
	}

	send(data: string): void {
		this.sent.push(data)
	}

	close(): void {
		this.closed = true
	}

	addEventListener(type: string, listener: (event: any) => void): void {
		;(this.listeners[type] ??= []).push(listener)
	}

	dispatch(type: string, event: any = {}): void {
		if (type === 'open') {
			this.readyState = 1
		}
		if (type === 'close') {
			this.readyState = 3
		}
		for (const listener of this.listeners[type] ?? []) {
			listener(event)
		}
	}

	static last(): MockWebSocket {
		return MockWebSocket.instances[MockWebSocket.instances.length - 1]
	}
}

const createTransport = (
	config: Partial<ConstructorParameters<typeof WebSocketTransport>[0]> = {}
) =>
	new WebSocketTransport({
		url: 'wss://example.test/sync',
		webSocketCtor: MockWebSocket as any,
		...config,
	})

/*
 *   WEBSOCKET TRANSPORT
 ***************************************************************************************************/
describe('WebSocketTransport', () => {
	let statuses: TransportStatus[]

	beforeEach(() => {
		vi.useFakeTimers()
		MockWebSocket.instances = []
		statuses = []
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	const startConnected = (config: Record<string, unknown> = {}) => {
		const transport = createTransport(config)
		transport.onStatusChange(status => statuses.push(status))
		transport.start()
		MockWebSocket.last().dispatch('open')
		return transport
	}

	it('should connect on start and report status', () => {
		startConnected()

		expect(MockWebSocket.instances).toHaveLength(1)
		expect(MockWebSocket.last().url).toBe('wss://example.test/sync')
		expect(statuses).toEqual(['connecting', 'connected'])
	})

	it('should JSON-serialize outgoing and parse incoming messages', () => {
		const transport = startConnected()
		const handler = vi.fn()
		transport.onMessage(handler)

		transport.send({ type: 'state_update', state: { count: 1 } })
		expect(MockWebSocket.last().sent).toContain(
			JSON.stringify({ type: 'state_update', state: { count: 1 } })
		)

		MockWebSocket.last().dispatch('message', {
			data: JSON.stringify({ type: 'patches', version: 3 }),
		})
		expect(handler).toHaveBeenCalledWith({ type: 'patches', version: 3 })
	})

	it('should drop malformed inbound frames', () => {
		const transport = startConnected()
		const handler = vi.fn()
		transport.onMessage(handler)

		expect(() => MockWebSocket.last().dispatch('message', { data: 'not json{' })).not.toThrow()
		expect(handler).not.toHaveBeenCalled()
	})

	it('should queue messages while disconnected and flush FIFO on open', () => {
		const transport = createTransport()
		transport.onStatusChange(status => statuses.push(status))
		transport.start()

		transport.send({ seq: 1 })
		transport.send({ seq: 2 })
		expect(MockWebSocket.last().sent).toHaveLength(0)

		MockWebSocket.last().dispatch('open')

		expect(MockWebSocket.last().sent).toEqual([
			JSON.stringify({ seq: 1 }),
			JSON.stringify({ seq: 2 }),
		])
	})

	it('should emit connected only after the queue is flushed', () => {
		const transport = createTransport()
		let sentAtConnect = -1
		transport.onStatusChange(status => {
			if (status === 'connected') {
				sentAtConnect = MockWebSocket.last().sent.length
			}
		})
		transport.start()
		transport.send({ seq: 1 })

		MockWebSocket.last().dispatch('open')

		expect(sentAtConnect).toBe(1)
	})

	it('should drop the oldest message on queue overflow and report it', () => {
		const onError = vi.fn()
		const transport = createTransport({ maxQueueSize: 2, onError })
		transport.start()

		transport.send({ seq: 1 })
		transport.send({ seq: 2 })
		transport.send({ seq: 3 })

		MockWebSocket.last().dispatch('open')

		expect(MockWebSocket.last().sent).toEqual([
			JSON.stringify({ seq: 2 }),
			JSON.stringify({ seq: 3 }),
		])
		expect(onError).toHaveBeenCalled()
	})

	it('should reconnect with exponential backoff after close', () => {
		vi.spyOn(Math, 'random').mockReturnValue(1)
		const transport = startConnected({ reconnect: { baseDelayMs: 500 } })

		MockWebSocket.last().dispatch('close')
		expect(statuses).toContain('disconnected')
		expect(MockWebSocket.instances).toHaveLength(1)

		// First retry after baseDelay * 2^0
		vi.advanceTimersByTime(500)
		expect(MockWebSocket.instances).toHaveLength(2)

		// Second retry window doubles
		MockWebSocket.last().dispatch('close')
		vi.advanceTimersByTime(500)
		expect(MockWebSocket.instances).toHaveLength(2)
		vi.advanceTimersByTime(500)
		expect(MockWebSocket.instances).toHaveLength(3)

		// Successful open resets the attempt counter
		MockWebSocket.last().dispatch('open')
		MockWebSocket.last().dispatch('close')
		vi.advanceTimersByTime(500)
		expect(MockWebSocket.instances).toHaveLength(4)

		transport.destroy()
	})

	it('should stop reconnecting after maxRetries', () => {
		vi.spyOn(Math, 'random').mockReturnValue(1)
		const onError = vi.fn()
		startConnected({ reconnect: { baseDelayMs: 100, maxRetries: 2 }, onError })

		MockWebSocket.last().dispatch('close')
		vi.advanceTimersByTime(100)
		MockWebSocket.last().dispatch('close')
		vi.advanceTimersByTime(200)
		expect(MockWebSocket.instances).toHaveLength(3)

		MockWebSocket.last().dispatch('close')
		vi.advanceTimersByTime(60000)
		expect(MockWebSocket.instances).toHaveLength(3)
		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining('max retries') })
		)
	})

	it('should not reconnect when reconnect is disabled or after destroy', () => {
		const transport = startConnected({ reconnect: false })
		MockWebSocket.last().dispatch('close')
		vi.advanceTimersByTime(60000)
		expect(MockWebSocket.instances).toHaveLength(1)
		transport.destroy()

		MockWebSocket.instances = []
		const transport2 = startConnected({})
		transport2.destroy()
		MockWebSocket.last().dispatch('close')
		vi.advanceTimersByTime(60000)
		expect(MockWebSocket.instances).toHaveLength(1)
	})

	it('should send heartbeat pings and close on missing pong', () => {
		startConnected({ heartbeatIntervalMs: 1000, heartbeatTimeoutMs: 400 })
		const socket = MockWebSocket.last()

		vi.advanceTimersByTime(1000)
		expect(socket.sent).toContain(JSON.stringify({ type: 'ping' }))

		vi.advanceTimersByTime(400)
		expect(socket.closed).toBe(true)
	})

	it('should intercept pongs without forwarding them to the handler', () => {
		const transport = startConnected({ heartbeatIntervalMs: 1000, heartbeatTimeoutMs: 400 })
		const handler = vi.fn()
		transport.onMessage(handler)
		const socket = MockWebSocket.last()

		vi.advanceTimersByTime(1000)
		socket.dispatch('message', { data: JSON.stringify({ type: 'pong' }) })

		vi.advanceTimersByTime(400)
		expect(socket.closed).toBe(false)
		expect(handler).not.toHaveBeenCalled()
	})

	it('should append the auth token as a query parameter', async () => {
		const transport = createTransport({ getAuthToken: async () => 'secret token' })
		transport.start()
		await vi.advanceTimersByTimeAsync(0)

		expect(MockWebSocket.last().url).toBe('wss://example.test/sync?token=secret%20token')
		transport.destroy()
	})

	it('should send the auth token as the first frame in message mode', async () => {
		const transport = createTransport({
			getAuthToken: () => 'tok',
			authMode: 'message',
		})
		transport.start()
		transport.send({ seq: 1 })
		await vi.advanceTimersByTimeAsync(0)

		MockWebSocket.last().dispatch('open')

		expect(MockWebSocket.last().url).toBe('wss://example.test/sync')
		expect(MockWebSocket.last().sent[0]).toBe(JSON.stringify({ type: 'auth', token: 'tok' }))
		expect(MockWebSocket.last().sent[1]).toBe(JSON.stringify({ seq: 1 }))
		transport.destroy()
	})

	it('should be safe to send after destroy', () => {
		const transport = startConnected()
		transport.destroy()

		expect(() => transport.send({ seq: 1 })).not.toThrow()
	})
})

/*
 *   SERVER VERSION PROTOCOL (StateSyncManager)
 ***************************************************************************************************/
describe('StateSyncManager server-version ordering', () => {
	interface FakeTransport extends SyncTransport {
		sent: any[]
		deliver: (message: unknown) => void
		emitStatus: (status: TransportStatus) => void
	}

	let transport: FakeTransport
	let currentState: TestState
	let applied: Array<{ state: TestState; patches?: any[] }>
	let ownInstanceId: string

	const createFakeTransport = (): FakeTransport => {
		let messageHandler: ((message: unknown) => void) | null = null
		let statusHandler: ((status: TransportStatus) => void) | null = null

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

	const createManager = (config: Record<string, unknown> = {}) => {
		const manager = new StateSyncManager<TestState>(
			{ transport, ...config },
			() => currentState,
			(state, patches) => {
				applied.push({ state, patches })
			}
		)
		ownInstanceId = transport.sent[0].instanceId
		return manager
	}

	const versioned = (version: number, overrides: Record<string, unknown> = {}) => ({
		type: 'state_update',
		instanceId: 'remote_instance',
		timestamp: Date.now(),
		state: { count: version, name: 'remote' },
		patches: undefined,
		inversePatches: undefined,
		description: undefined,
		version,
		...overrides,
	})

	const fullSyncRequests = () => transport.sent.filter(m => m.type === 'full_sync')

	beforeEach(() => {
		transport = createFakeTransport()
		currentState = { count: 0, name: 'test' }
		applied = []
	})

	it('should apply in-order versioned updates', () => {
		createManager()

		transport.deliver(versioned(1))
		transport.deliver(versioned(2))

		expect(applied.map(a => a.state.count)).toEqual([1, 2])
	})

	it('should drop stale and duplicate versions', () => {
		createManager()

		transport.deliver(versioned(2))
		transport.deliver(versioned(2))
		transport.deliver(versioned(1))

		expect(applied).toHaveLength(1)
		expect(applied[0].state.count).toBe(2)
	})

	it('should advance the cursor on self-echo without applying', () => {
		createManager({ mergeStrategy: 'patches' })

		transport.deliver(versioned(1, { instanceId: ownInstanceId }))
		expect(applied).toHaveLength(0)

		// Next remote patch at version 2 is in-order, not a gap
		transport.deliver(
			versioned(2, {
				type: 'patches',
				state: undefined,
				patches: [{ op: 'replace', path: ['count'], value: 5 }],
			})
		)

		expect(applied).toHaveLength(1)
		expect(applied[0].state.count).toBe(5)
		expect(fullSyncRequests()).toHaveLength(1) // only the initial one
	})

	it('should drop gapped patches and request a resync exactly once', () => {
		createManager({ mergeStrategy: 'patches' })

		transport.deliver(versioned(1))
		expect(fullSyncRequests()).toHaveLength(1)

		const gappedPatch = (version: number) =>
			versioned(version, {
				type: 'patches',
				state: undefined,
				patches: [{ op: 'replace', path: ['count'], value: version }],
			})

		transport.deliver(gappedPatch(5))
		transport.deliver(gappedPatch(6))

		expect(applied).toHaveLength(1) // only the initial state_update
		expect(fullSyncRequests()).toHaveLength(2) // exactly one resync request

		// Resync answer (versioned full state) recovers and clears the pending flag
		transport.deliver(versioned(7))
		expect(applied).toHaveLength(2)
		expect(applied[1].state.count).toBe(7)
	})

	it('should apply gapped full-state updates', () => {
		createManager()

		transport.deliver(versioned(1))
		transport.deliver(versioned(10))

		expect(applied.map(a => a.state.count)).toEqual([1, 10])
		expect(fullSyncRequests()).toHaveLength(1)
	})

	it('should reset the version cursor and resync on reconnect', () => {
		createManager()

		transport.deliver(versioned(5))
		expect(applied).toHaveLength(1)

		transport.emitStatus('connected')
		expect(fullSyncRequests()).toHaveLength(2)

		// Server restarted with a fresh counter: version 1 must be accepted again
		transport.deliver(versioned(1))
		expect(applied).toHaveLength(2)
	})

	it('should ignore timestamps on versioned messages', () => {
		createManager()

		transport.deliver(versioned(1, { timestamp: Date.now() - 999999 }))

		expect(applied).toHaveLength(1)
	})

	it('should still validate versioned payloads', () => {
		createManager()

		transport.deliver(
			versioned(1, { state: JSON.parse('{"count": 1, "name": "x", "constructor": {}}') })
		)

		expect(applied).toHaveLength(0)
	})

	it('should answer full-sync requests regardless of clock skew', () => {
		createManager()
		currentState = { count: 42, name: 'current' }

		transport.deliver({
			type: 'full_sync',
			instanceId: 'remote_instance',
			timestamp: Date.now() - 999999,
		})

		const updates = transport.sent.filter(m => m.type === 'state_update')
		expect(updates).toHaveLength(1)
		expect(updates[0].state.count).toBe(42)
	})

	it('should not answer its own echoed full-sync request', () => {
		createManager()

		transport.deliver({
			type: 'full_sync',
			instanceId: ownInstanceId,
			timestamp: Date.now(),
		})

		expect(transport.sent.filter(m => m.type === 'state_update')).toHaveLength(0)
	})
})
