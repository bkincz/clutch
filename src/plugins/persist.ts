/*
 *   IMPORTS
 ***************************************************************************************************/
import { MachineError, type Plugin, type PluginContext } from '../core'

/*
 *   TYPES
 ***************************************************************************************************/
export interface PersistStorage {
	getItem(key: string): string | null
	setItem(key: string, value: string): void
	removeItem(key: string): void
}

export interface PersistFilter<T> {
	exclude?: (keyof T)[]
	include?: (keyof T)[]
	custom?: (state: T) => Partial<T>
}

export interface PersistedEnvelope<T> {
	state: T
	timestamp: number
	version?: number
}

export interface PersistConfig<T> {
	key: string
	storage?: PersistStorage
	debounceMs?: number
	maxChars?: number
	filter?: PersistFilter<T>
	deferred?: boolean
	version?: number
	migrate?: (persisted: Partial<T>, fromVersion: number) => Partial<T>
}

export interface PersistApi {
	hydrate(): boolean
	isHydrated(): boolean
	flush(): void
	clearPersisted(): void
}

const PERSIST_SOURCE = 'persist'
const DEFAULT_DEBOUNCE_MS = 300
const DEFAULT_MAX_CHARS = 5 * 1024 * 1024

const resolveDefaultStorage = (): PersistStorage | null => {
	try {
		if (typeof window === 'undefined' || !window.localStorage) {
			return null
		}
		return window.localStorage
	} catch {
		return null
	}
}

/*
 *   PLUGIN
 ***************************************************************************************************/
export function persist<T extends object>(config: PersistConfig<T>): Plugin<T, PersistApi> {
	if (!config.key) {
		throw new MachineError('Persist key is required', 'VALIDATION_ERROR')
	}

	const debounceMs = config.debounceMs ?? DEFAULT_DEBOUNCE_MS
	const maxChars = config.maxChars ?? DEFAULT_MAX_CHARS
	const storage = config.storage ?? resolveDefaultStorage()

	let ctx: PluginContext<T> | null = null
	let baseState: T | null = null
	let hydrated = false
	let timer: ReturnType<typeof setTimeout> | null = null
	let pagehideHandler: (() => void) | null = null

	const filterState = (state: T): Partial<T> => {
		const filter = config.filter
		if (!filter) {
			return state
		}

		if (filter.custom) {
			return filter.custom(state)
		}

		if (filter.exclude) {
			const filtered = { ...state }
			filter.exclude.forEach(key => {
				delete filtered[key]
			})
			return filtered
		}

		if (filter.include) {
			const filtered: Partial<T> = {}
			filter.include.forEach(key => {
				filtered[key] = state[key]
			})
			return filtered
		}

		return state
	}

	const persistNow = (): void => {
		if (!ctx || !storage) {
			return
		}

		try {
			const envelope: PersistedEnvelope<Partial<T>> = {
				state: filterState(ctx.getState()),
				timestamp: Date.now(),
			}
			if (config.version !== undefined) {
				envelope.version = config.version
			}

			const serialized = JSON.stringify(envelope)

			if (serialized.length > maxChars) {
				ctx.emitError(
					new MachineError('State too large to persist', 'PERSISTENCE_ERROR'),
					'persist'
				)
				return
			}

			storage.setItem(config.key, serialized)
		} catch (error) {
			if (error instanceof Error && error.name === 'QuotaExceededError') {
				ctx.emitError(
					new MachineError('Storage quota exceeded', 'PERSISTENCE_ERROR'),
					'persist'
				)
			}
		}
	}

	const schedule = (): void => {
		if (!storage || timer) {
			return
		}

		timer = setTimeout(() => {
			timer = null
			persistNow()
		}, debounceMs)
	}

	const flush = (): void => {
		if (timer) {
			clearTimeout(timer)
			timer = null
			persistNow()
		}
	}

	const loadPersisted = (): T | null => {
		if (!storage || !baseState) {
			return null
		}

		try {
			const stored = storage.getItem(config.key)
			if (!stored) {
				return null
			}

			const parsed = JSON.parse(stored, (key, value) => {
				if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
					return undefined
				}
				return value
			})

			if (!parsed || typeof parsed !== 'object' || !parsed.state) {
				return null
			}

			const envelope = parsed as PersistedEnvelope<Partial<T>>

			if (
				Object.prototype.hasOwnProperty.call(envelope, '__proto__') ||
				Object.prototype.hasOwnProperty.call(envelope, 'constructor') ||
				Object.prototype.hasOwnProperty.call(envelope.state, '__proto__') ||
				Object.prototype.hasOwnProperty.call(envelope.state, 'constructor')
			) {
				return null
			}

			let state = envelope.state
			const persistedVersion = envelope.version ?? 0
			const expectedVersion = config.version ?? 0

			if (persistedVersion !== expectedVersion) {
				if (!config.migrate) {
					console.warn(
						`[Clutch] Discarding "${config.key}": it was persisted as version ${persistedVersion}, this app expects ${expectedVersion} and no migrate() is configured.`
					)
					return null
				}
				state = config.migrate(state, persistedVersion)
			}

			return {
				...baseState,
				...state,
			} as T
		} catch {
			// Corrupt persisted data falls back to current state
			return null
		}
	}

	const hydrate = (): boolean => {
		if (!ctx || hydrated) {
			return false
		}

		hydrated = true

		const persisted = loadPersisted()
		if (!persisted) {
			return false
		}

		ctx.replaceState(persisted, { source: PERSIST_SOURCE, description: 'Hydration' })
		return true
	}

	const clearPersisted = (): void => {
		try {
			storage?.removeItem(config.key)
		} catch {
			// A failed removal is harmless
		}
	}

	return {
		name: PERSIST_SOURCE,

		onInit(context) {
			ctx = context
			baseState = context.getState()

			if (typeof window !== 'undefined' && storage) {
				pagehideHandler = flush
				window.addEventListener('pagehide', pagehideHandler)
			}

			if (!config.deferred) {
				hydrate()
			}

			return {
				hydrate,
				isHydrated: () => hydrated,
				flush,
				clearPersisted,
			}
		},

		// External updates (sync, undo via history) get persisted too. The core
		// skips our own source, so hydration never immediately rewrites storage.
		onCommit: () => schedule(),
		onExternalState: () => schedule(),

		onDestroy() {
			flush()

			if (pagehideHandler && typeof window !== 'undefined') {
				window.removeEventListener('pagehide', pagehideHandler)
				pagehideHandler = null
			}

			ctx = null
			baseState = null
		},
	}
}
