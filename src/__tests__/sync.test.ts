import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Patch } from 'immer'
import { createMachine, type PluginContext } from '../core'
import { sync } from '../plugins/sync'
import { history } from '../plugins/history'
import type { TransportStatus } from '../transports/types'

interface TestState {
	count: number
	name: string
}

const initialState = (): TestState => ({ count: 0, name: 'test' })

type SyncMessage = {
	type: 'state_update' | 'full_sync' | 'patches'
	instanceId: string
	timestamp: number
	state?: TestState
	patches?: Patch[]
	inversePatches?: Patch[]
	description?: string
}

const createMockTransport = () => {
	const sent: SyncMessage[] = []
	let messageHandler: ((message: unknown) => void) | null = null
	let statusHandler: ((status: TransportStatus) => void) | null = null

	return {
		sent,
		send: vi.fn((message: unknown) => {
			sent.push(message as SyncMessage)
		}),
		onMessage: (handler: (message: unknown) => void) => {
			messageHandler = handler
		},
		onStatusChange: (handler: (status: TransportStatus) => void) => {
			statusHandler = handler
		},
		start: vi.fn(),
		destroy: vi.fn(),
		receive: (message: Partial<SyncMessage>) => {
			messageHandler?.(message)
		},
		setStatus: (status: TransportStatus) => {
			statusHandler?.(status)
		},
	}
}

type MockTransport = ReturnType<typeof createMockTransport>

const remoteMessage = (overrides: Partial<SyncMessage>): Partial<SyncMessage> => ({
	instanceId: 'remote-instance',
	timestamp: Date.now(),
	...overrides,
})

describe('plugins/sync', () => {
	let transport: MockTransport

	beforeEach(() => {
		transport = createMockTransport()
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	const setup = () =>
		createMachine({ initialState: initialState() }).with(sync<TestState>({ transport }))

	it('starts the transport and requests a full sync on install', () => {
		setup()

		expect(transport.start).toHaveBeenCalled()
		expect(transport.sent[0]).toMatchObject({ type: 'full_sync' })
	})

	it('broadcasts commits as state updates after the sync debounce', () => {
		const machine = setup()

		machine.mutate(draft => {
			draft.count = 1
		}, 'increment')

		vi.advanceTimersByTime(50)

		const update = transport.sent.find(message => message.type === 'state_update')
		expect(update).toMatchObject({
			state: { count: 1, name: 'test' },
			description: 'increment',
		})
	})

	it('broadcasts patches when the merge strategy is patches', () => {
		const machine = createMachine({ initialState: initialState() }).with(
			sync<TestState>({ transport, mergeStrategy: 'patches' })
		)

		machine.mutate(draft => {
			draft.count = 1
		})

		vi.advanceTimersByTime(50)

		const update = transport.sent.find(message => message.type === 'patches')
		expect(update?.patches).toEqual([{ op: 'replace', path: ['count'], value: 1 }])
		expect(update?.state).toBeUndefined()
	})

	it('applies a remote state update', () => {
		const machine = setup()
		const listener = vi.fn()
		machine.subscribe(listener)

		transport.receive(
			remoteMessage({
				type: 'state_update',
				state: { count: 9, name: 'remote' },
			})
		)

		expect(machine.getState()).toEqual({ count: 9, name: 'remote' })
		expect(listener).toHaveBeenCalled()
	})

	it('applies remote patches without clearing installed history', () => {
		const machine = createMachine({ initialState: initialState() })
			.with(sync<TestState>({ transport }))
			.with(history<TestState>())

		machine.mutate(draft => {
			draft.count = 1
		})
		expect(machine.canUndo()).toBe(true)

		transport.receive(
			remoteMessage({
				type: 'patches',
				patches: [{ op: 'replace', path: ['name'], value: 'remote' }],
			})
		)

		expect(machine.getState().name).toBe('remote')
		expect(machine.canUndo()).toBe(true)
	})

	it('does not rebroadcast a remote update it just applied', () => {
		setup()
		const sendsBefore = transport.sent.length

		transport.receive(
			remoteMessage({
				type: 'state_update',
				state: { count: 9, name: 'remote' },
			})
		)

		vi.advanceTimersByTime(100)

		expect(transport.sent.length).toBe(sendsBefore)
	})

	it('answers a full-sync request from another instance with its state', () => {
		const machine = setup()

		machine.mutate(draft => {
			draft.count = 3
		})

		transport.receive(remoteMessage({ type: 'full_sync' }))

		const response = transport.sent.filter(message => message.type === 'state_update').pop()
		expect(response?.state).toEqual({ count: 3, name: 'test' })
	})

	it('broadcasts history undo to peers', () => {
		const machine = createMachine({ initialState: initialState() })
			.with(sync<TestState>({ transport }))
			.with(history<TestState>())

		machine.mutate(draft => {
			draft.count = 1
		}, 'increment')
		vi.advanceTimersByTime(50)

		machine.undo()
		vi.advanceTimersByTime(50)

		const updates = transport.sent.filter(message => message.type === 'state_update')
		expect(updates.pop()?.state).toMatchObject({ count: 0 })
	})

	it('keeps full-state replaces from other plugins local', () => {
		let capturedCtx!: PluginContext<TestState>
		createMachine({ initialState: initialState() })
			.with({
				name: 'devtools',
				onInit: (ctx: PluginContext<TestState>) => {
					capturedCtx = ctx
				},
			})
			.with(sync<TestState>({ transport }))

		const sendsBefore = transport.sent.length

		capturedCtx.replaceState({ count: 5, name: 'time-travel' }, { source: 'devtools' })
		vi.advanceTimersByTime(100)

		expect(transport.sent.length).toBe(sendsBefore)
	})

	it('rejects remote states carrying dangerous properties', () => {
		const machine = setup()

		transport.receive(
			remoteMessage({
				type: 'state_update',
				state: JSON.parse('{"count":5,"__proto__":{"polluted":true}}'),
			})
		)

		expect(machine.getState().count).toBe(0)
		expect(({} as Record<string, unknown>).polluted).toBeUndefined()
	})

	describe('autoStart: false', () => {
		it('stays idle until startSync() is called', () => {
			const machine = createMachine({ initialState: initialState() }).with(
				sync<TestState>({ transport, autoStart: false })
			)

			machine.mutate(draft => {
				draft.count = 1
			})
			vi.advanceTimersByTime(100)

			expect(transport.start).not.toHaveBeenCalled()
			expect(transport.sent.length).toBe(0)

			machine.startSync()

			expect(transport.start).toHaveBeenCalled()
			expect(transport.sent[0]).toMatchObject({ type: 'full_sync' })
		})

		it('startSync() is idempotent', () => {
			const machine = createMachine({ initialState: initialState() }).with(
				sync<TestState>({ transport, autoStart: false })
			)

			machine.startSync()
			machine.startSync()

			expect(transport.start).toHaveBeenCalledTimes(1)
		})
	})

	it('destroys the transport on machine destroy', () => {
		const machine = setup()

		machine.destroy()

		expect(transport.destroy).toHaveBeenCalled()
	})
})
