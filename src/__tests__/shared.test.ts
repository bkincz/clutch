import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createMachine } from '../core'
import { sharedMachine } from '../shared'
import { version as CLUTCH_VERSION } from '../../package.json'

interface PlayerState {
	track: string | null
	playing: boolean
}

const REGISTRY_KEY = '__clutchSharedMachines'

interface SharedEntry {
	machine: unknown
	clutchVersion: string
	contract: number | string | undefined
}

const build = () => createMachine<PlayerState>({ initialState: { track: null, playing: false } })

beforeEach(() => {
	delete (globalThis as { [REGISTRY_KEY]?: unknown })[REGISTRY_KEY]
})

afterEach(() => {
	delete (globalThis as { [REGISTRY_KEY]?: unknown })[REGISTRY_KEY]
	vi.restoreAllMocks()
})

describe('sharedMachine', () => {
	it('creates the machine once and returns the same instance for the same key', () => {
		const factory = vi.fn(build)
		const first = sharedMachine('app:player', factory)
		const second = sharedMachine('app:player', factory)

		expect(second).toBe(first)
		expect(factory).toHaveBeenCalledTimes(1)
	})

	it('keeps machines with different keys separate', () => {
		const player = sharedMachine('app:player', build)
		const cart = sharedMachine('app:cart', build)

		expect(cart).not.toBe(player)
	})

	it('shares state across callers, as separate app bundles would', () => {
		const first = sharedMachine('app:player', build)
		first.mutate(draft => {
			draft.track = 'neon-skyline'
			draft.playing = true
		})

		const second = sharedMachine('app:player', build)
		expect(second.getState()).toEqual({ track: 'neon-skyline', playing: true })
	})

	it('returns an instance registered by another copy of clutch', () => {
		const foreign = build()
		;(globalThis as { [REGISTRY_KEY]?: Record<string, SharedEntry> })[REGISTRY_KEY] = {
			'app:player': {
				machine: foreign,
				clutchVersion: CLUTCH_VERSION,
				contract: undefined,
			},
		}

		expect(sharedMachine('app:player', build)).toBe(foreign)
	})

	it('warns when the registering copy of clutch is a different version', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		;(globalThis as { [REGISTRY_KEY]?: Record<string, SharedEntry> })[REGISTRY_KEY] = {
			'app:player': { machine: build(), clutchVersion: '0.0.1', contract: undefined },
		}

		sharedMachine('app:player', build)
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('0.0.1'))
		expect(warn).toHaveBeenCalledWith(expect.stringContaining(CLUTCH_VERSION))
	})

	it('warns when two apps declare different contracts for the same key', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		sharedMachine('app:player', build, { contract: 1 })
		const machine = sharedMachine('app:player', build, { contract: 2 })

		expect(machine).toBeDefined()
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('contract mismatch'))
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('1'))
	})

	it('stays quiet when contracts agree', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		sharedMachine('app:player', build, { contract: 1 })
		sharedMachine('app:player', build, { contract: 1 })

		expect(warn).not.toHaveBeenCalled()
	})

	it('does not warn about contracts when the caller declares none', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		sharedMachine('app:player', build, { contract: 1 })
		sharedMachine('app:player', build)

		expect(warn).not.toHaveBeenCalled()
	})

	it('preserves plugin extensions on the shared instance', () => {
		const withApi = sharedMachine('app:player', () =>
			Object.assign(build(), { customMethod: () => 42 })
		)
		expect(withApi.customMethod()).toBe(42)

		const again = sharedMachine('app:player', () =>
			Object.assign(build(), { customMethod: () => 42 })
		)
		expect(again.customMethod()).toBe(42)
	})
})
