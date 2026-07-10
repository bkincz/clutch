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
	version: number | undefined
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
				version: undefined,
			},
		}

		expect(sharedMachine('app:player', build)).toBe(foreign)
	})

	it('warns when the registering copy of clutch is a different version', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		;(globalThis as { [REGISTRY_KEY]?: Record<string, SharedEntry> })[REGISTRY_KEY] = {
			'app:player': {
				machine: build(),
				clutchVersion: '0.0.1',
				contract: undefined,
				version: undefined,
			},
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

	/*
	 *   VERSION + MIGRATION
	 ***************************************************************************************************/
	interface PlayerStateV2 extends PlayerState {
		volume: number
	}
	const buildV2 = () =>
		createMachine<PlayerStateV2>({ initialState: { track: null, playing: false, volume: 1 } })

	it('migrates the shared state up in place when a newer version joins', () => {
		const v1 = sharedMachine('app:player', build, { version: 1 })
		v1.mutate(draft => {
			draft.track = 'neon-skyline'
			draft.playing = true
		})
		const seen = vi.fn()
		v1.subscribe(seen)

		const v2 = sharedMachine('app:player', buildV2, {
			version: 2,
			migrate: prev => ({ ...(prev as PlayerState), volume: 0.5 }),
		})

		// Same instance: the newcomer gets the original machine, not a fresh one.
		expect(v2).toBe(v1 as unknown as typeof v2)
		// The live state was migrated in place, so v1's own reference sees it.
		expect(v1.getState()).toEqual({ track: 'neon-skyline', playing: true, volume: 0.5 })
		expect(seen).toHaveBeenCalledWith(expect.objectContaining({ volume: 0.5 }))
	})

	it('warns and leaves state alone when a newer version has no migrate', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const v1 = sharedMachine('app:player', build, { version: 1 })
		v1.mutate(draft => {
			draft.track = 'x'
		})

		sharedMachine('app:player', buildV2, { version: 2 })

		expect(warn).toHaveBeenCalledWith(expect.stringContaining('no migrate()'))
		expect(v1.getState()).toEqual({ track: 'x', playing: false })
	})

	it('warns when an older version joins state it cannot migrate down to', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		sharedMachine('app:player', buildV2, { version: 2 })
		sharedMachine('app:player', build, { version: 1 })

		expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot migrate down'))
	})

	it('stays quiet and shares the instance when versions match', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const first = sharedMachine('app:player', build, { version: 2 })
		const second = sharedMachine('app:player', build, { version: 2 })

		expect(second).toBe(first)
		expect(warn).not.toHaveBeenCalled()
	})

	it('skips migration when the shared entry is not a clutch machine', () => {
		;(globalThis as { [REGISTRY_KEY]?: Record<string, SharedEntry> })[REGISTRY_KEY] = {
			'app:player': {
				machine: { notAMachine: true },
				clutchVersion: CLUTCH_VERSION,
				contract: undefined,
				version: 1,
			},
		}

		expect(() =>
			sharedMachine('app:player', buildV2, { version: 2, migrate: prev => prev })
		).not.toThrow()
	})

	it('keeps the shared state when migrate throws', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const v1 = sharedMachine('app:player', build, { version: 1 })
		v1.mutate(draft => {
			draft.track = 'safe'
		})

		sharedMachine('app:player', buildV2, {
			version: 2,
			migrate: () => {
				throw new Error('bad migration')
			},
		})

		expect(warn).toHaveBeenCalledWith(expect.stringContaining('bad migration'))
		expect(v1.getState()).toEqual({ track: 'safe', playing: false })
	})
})
