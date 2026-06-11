/*
 *   IMPORTS
 ***************************************************************************************************/
import { applyPatches, type Patch, type Draft } from 'immer'
import { createMachine, type Machine, type CommitPayload } from './core'
import { history, type HistoryApi } from './plugins/history'
import { persist, type PersistApi, type PersistConfig } from './plugins/persist'
import { devtools } from './plugins/devtools'
import { sync, type SyncApi, type SyncPluginConfig } from './plugins/sync'
import { validate } from './plugins/validate'
import { autosave, type AutosaveApi, type AutosaveConfig } from './plugins/autosave'
import type { StateConfig, Middleware, MutationOperation } from './machine'

/*
 *   TYPES
 ***************************************************************************************************/
export interface V2CompatConfig<T extends object> extends StateConfig<T> {
	saveToServer?: (state: T) => void | Promise<void>
	loadFromServer?: () => T | null | Promise<T | null>
}

export type V2LifecycleEvent = 'afterMutate' | 'error' | 'destroy'

export type V2LifecyclePayloadMap<T> = {
	afterMutate: CommitPayload<T>
	error: { error: Error; operation: string }
	destroy: { finalState: T }
}

export type V2Machine<T extends object> = Machine<T> &
	HistoryApi &
	PersistApi &
	AutosaveApi &
	SyncApi & {
		hydrateFromPersisted(): void
		loadFromServerManually(): Promise<boolean>
		applyPatchSet(patches: Patch[], description?: string): void
		on<E extends V2LifecycleEvent>(
			event: E,
			listener: (payload: V2LifecyclePayloadMap<T>[E]) => void
		): () => void
	}

type ListenerSets<T> = {
	[E in V2LifecycleEvent]: Set<(payload: V2LifecyclePayloadMap<T>[E]) => void>
}

/*
 *   FACTORY
 ***************************************************************************************************/
/**
 * Builds a v3 plugin machine from a v2 StateConfig, as a one-release
 * migration bridge. Known divergences from v2:
 * - enableLogging is ignored, v3 has no built-in logger
 * - isHydrated is a method, not a getter property
 * - undo/redo do not fire afterMutate
 * - validateState vetoes commits but only reports on remote/external updates
 * - resets stay local instead of broadcasting to sync peers
 */

export function createV2Machine<T extends object>(config: V2CompatConfig<T>): V2Machine<T> {
	const deferred = config.deferredHydration ?? false
	const persistenceEnabled = (config.enablePersistence ?? true) && !!config.persistenceKey
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let machine: any = createMachine<T>({ initialState: config.initialState })

	if (config.validateState) {
		machine = machine.with(validate<T>(config.validateState))
	}

	machine = machine.with(history<T>({ maxSize: config.maxHistorySize ?? 50 }))

	if (persistenceEnabled) {
		const persistConfig: PersistConfig<T> = { key: config.persistenceKey as string }
		if (config.persistenceFilter) {
			persistConfig.filter = config.persistenceFilter
		}
		if (deferred) {
			persistConfig.deferred = true
		}
		machine = machine.with(persist<T>(persistConfig))
	}

	if (config.enableDevTools) {
		machine = machine.with(
			devtools<T>(typeof config.enableDevTools === 'boolean' ? {} : config.enableDevTools)
		)
	}

	if (config.enableSync) {
		const syncConfig: SyncPluginConfig =
			typeof config.enableSync === 'boolean' ? {} : { ...config.enableSync }
		syncConfig.autoStart = !deferred
		machine = machine.with(sync<T>(syncConfig))
	}

	const autosaveConfig: AutosaveConfig<T> = {
		save: async (state: T) => {
			if (config.saveToServer) {
				await config.saveToServer(state)
			}
			;(machine as Partial<PersistApi>).flush?.()
		},
		auto: config.enableAutoSave ?? true,
	}
	if (config.loadFromServer) {
		autosaveConfig.load = config.loadFromServer
	}
	if (config.autoSaveIntervalMs) {
		autosaveConfig.intervalMs = config.autoSaveIntervalMs
	}
	machine = machine.with(autosave<T>(autosaveConfig))

	const listeners: ListenerSets<T> = {
		afterMutate: new Set(),
		error: new Set(),
		destroy: new Set(),
	}

	machine = machine.with({
		name: 'v2-events',
		onCommit: (payload: CommitPayload<T>) => {
			listeners.afterMutate.forEach(listener => listener(payload))
		},
		onError: (error: Error, operation: string) => {
			listeners.error.forEach(listener => listener({ error, operation }))
		},
		onDestroy: (finalState: T) => {
			listeners.destroy.forEach(listener => listener({ finalState }))
		},
	})

	if (!persistenceEnabled) {
		Object.assign(machine, {
			hydrate: () => false,
			isHydrated: () => true,
			flush: () => {},
			clearPersisted: () => {},
		})
	}

	if (!config.enableSync) {
		Object.assign(machine, { startSync: () => {} })
	}

	if (config.enableSync && deferred && persistenceEnabled) {
		const originalHydrate = machine.hydrate as () => boolean
		machine.hydrate = () => {
			const applied = originalHydrate()
			machine.startSync()
			return applied
		}
	}

	/*
	 * V2 METHOD ALIASES
	 ***************************************************************************************************/
	machine.hydrateFromPersisted = () => {
		machine.hydrate()
		machine.startSync()
	}

	machine.loadFromServerManually = () => machine.loadFromServer()

	machine.applyPatchSet = (patches: Patch[], description?: string) => {
		machine.mutate((draft: Draft<T>) => {
			applyPatches(draft, patches)
		}, description)
	}

	machine.on = <E extends V2LifecycleEvent>(
		event: E,
		listener: (payload: V2LifecyclePayloadMap<T>[E]) => void
	) => {
		listeners[event].add(listener)
		return () => {
			listeners[event].delete(listener)
		}
	}

	/*
	 * V2 RECIPE MIDDLEWARE
	 ***************************************************************************************************/
	if (config.middleware && config.middleware.length > 0) {
		const middleware = config.middleware as Middleware<T>[]

		const compose = (
			recipe: (draft: Draft<T>) => void,
			description: string | undefined,
			operation: MutationOperation
		) => {
			const context = Object.freeze({
				state: machine.getState() as T,
				description,
				operation,
				timestamp: Date.now(),
			})

			return middleware.reduceRight<(draft: Draft<T>) => void>(
				(next, mw) => draft => mw(context, next, draft),
				recipe
			)
		}

		const originalMutate = machine.mutate.bind(machine)
		const originalBatch = machine.batch.bind(machine)

		machine.mutate = (recipe: (draft: Draft<T>) => void, description?: string) =>
			originalMutate(compose(recipe, description, 'mutate'), description)

		machine.batch = (mutations: Array<(draft: Draft<T>) => void>, description?: string) =>
			originalBatch(
				mutations.map(recipe => compose(recipe, description, 'batch')),
				description
			)
	}

	return machine as V2Machine<T>
}
