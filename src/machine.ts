/*
 *   IMPORTS
 ***************************************************************************************************/
import { produce, enablePatches, applyPatches, type Patch, type Draft } from 'immer'
import { DevToolsConnector, type DevToolsConfig } from './devtools'
import { StateSyncManager, type SyncConfig } from './sync'

enablePatches()

/*
 *   CONSTANTS
 ***************************************************************************************************/
const DEFAULT_AUTO_SAVE_INTERVAL_MS = 5 * 60 * 1000
const DEFAULT_MAX_HISTORY_SIZE = 50
const PERSIST_DEBOUNCE_MS = 300
const MAX_PERSIST_CHARS = 5 * 1024 * 1024

/*
 *   ERROR TYPES
 ***************************************************************************************************/
export class StateMachineError extends Error {
	public readonly code: string

	constructor(message: string, code: string) {
		super(message)
		this.name = 'StateMachineError'
		this.code = code
	}
}

export class StateValidationError extends StateMachineError {
	constructor(message: string) {
		super(message, 'VALIDATION_ERROR')
	}
}

export class StatePersistenceError extends StateMachineError {
	constructor(message: string) {
		super(message, 'PERSISTENCE_ERROR')
	}
}

/*
 *   TYPES
 ***************************************************************************************************/
export type MiddlewareContext<T> = {
	state: T
	description: string | undefined
	operation: MutationOperation
	timestamp: number
}

export type MiddlewareNext<T> = (draft: Draft<T>) => void

export type Middleware<T> = (
	context: MiddlewareContext<T>,
	next: MiddlewareNext<T>,
	draft: Draft<T>
) => void

export type PersistenceFilter<T> = {
	exclude?: (keyof T)[]
	include?: (keyof T)[]
	custom?: (state: T) => Partial<T>
}

export interface StateConfig<T extends object> {
	initialState: T
	persistenceKey?: string
	autoSaveIntervalMs?: number
	maxHistorySize?: number
	enablePersistence?: boolean
	enableAutoSave?: boolean
	enableLogging?: boolean
	validateState?: (state: T) => boolean
	middleware?: Middleware<T>[]
	persistenceFilter?: PersistenceFilter<T>
	enableDevTools?: boolean | DevToolsConfig
	enableSync?: boolean | SyncConfig
	deferredHydration?: boolean
}

interface InternalStateConfig<T extends object> {
	initialState: T
	persistenceKey: string | null
	autoSaveIntervalMs: number
	maxHistorySize: number
	enablePersistence: boolean
	enableAutoSave: boolean
	enableLogging: boolean
	validateState: (state: T) => boolean
	middleware: Middleware<T>[]
	persistenceFilter: PersistenceFilter<T> | null
	deferredHydration: boolean
	enableSync: boolean | SyncConfig
}

export interface StateSnapshot {
	patches: Patch[]
	inversePatches: Patch[]
	timestamp: number
	description?: string
}

export interface PersistedState<T> {
	state: T
	timestamp: number
}

export interface StateHistoryInfo {
	canUndo: boolean
	canRedo: boolean
	historyLength: number
	currentIndex: number
	lastAction: string | null
}

/*
 *   LIFECYCLE EVENT TYPES
 ***************************************************************************************************/
export type LifecycleEvent = 'afterMutate' | 'error' | 'destroy'

export type MutationOperation = 'mutate' | 'batch' | 'undo' | 'redo'

export interface AfterMutatePayload<T> {
	state: T
	patches: Patch[]
	inversePatches: Patch[]
	description: string | undefined
	operation: MutationOperation
}

export interface ErrorPayload {
	error: Error
	operation: MutationOperation | 'persist' | 'validate'
}

export interface DestroyPayload<T> {
	finalState: T
}

export type LifecyclePayloadMap<T> = {
	afterMutate: AfterMutatePayload<T>
	error: ErrorPayload
	destroy: DestroyPayload<T>
}

export type LifecycleListener<T, E extends LifecycleEvent> = (
	payload: LifecyclePayloadMap<T>[E]
) => void

/* eslint-disable no-console */
const createLogger = (enabled: boolean) => ({
	debug: enabled
		? (msg: string, ...args: unknown[]) => console.debug(`[StateMachine] ${msg}`, ...args)
		: () => {},
	info: enabled
		? (msg: string, ...args: unknown[]) => console.info(`[StateMachine] ${msg}`, ...args)
		: () => {},
	warn: enabled
		? (msg: string, ...args: unknown[]) => console.warn(`[StateMachine] ${msg}`, ...args)
		: () => {},
	error: enabled
		? (msg: string, ...args: unknown[]) => console.error(`[StateMachine] ${msg}`, ...args)
		: () => {},
})
/* eslint-enable no-console */

/*
 *   STATE MACHINE
 ***************************************************************************************************/
export class StateMachine<T extends object> {
	protected state: T
	protected config: InternalStateConfig<T>
	protected listeners: Set<(state: T) => void> = new Set()
	protected history: StateSnapshot[] = []
	protected historyIndex = -1
	protected isDirty = false
	protected autoSaveTimer: ReturnType<typeof setInterval> | null = null
	protected isDestroyed = false
	protected _hydrated = false
	protected logger: ReturnType<typeof createLogger>
	private persistTimer: ReturnType<typeof setTimeout> | null = null
	private pagehideHandler: (() => void) | null = null
	private historyInfoCache: StateHistoryInfo | null = null
	protected eventListeners: Map<
		LifecycleEvent,
		Set<LifecycleListener<T, LifecycleEvent>>
	> | null = null
	protected devtools: DevToolsConnector<T> | null = null
	protected syncManager: StateSyncManager<T> | null = null

	constructor(config: StateConfig<T>) {
		this.validateConfig(config)

		this.config = {
			initialState: config.initialState,
			persistenceKey: config.persistenceKey || null,
			autoSaveIntervalMs: config.autoSaveIntervalMs ?? DEFAULT_AUTO_SAVE_INTERVAL_MS,
			maxHistorySize: config.maxHistorySize ?? DEFAULT_MAX_HISTORY_SIZE,
			enablePersistence: config.enablePersistence ?? true,
			enableAutoSave: config.enableAutoSave ?? true,
			enableLogging: config.enableLogging ?? false,
			validateState: config.validateState ?? (() => true),
			middleware: config.middleware ?? [],
			persistenceFilter: config.persistenceFilter ?? null,
			deferredHydration: config.deferredHydration ?? false,
			enableSync: config.enableSync ?? false,
		}

		this.logger = createLogger(this.config.enableLogging)

		if (
			typeof window !== 'undefined' &&
			this.config.enablePersistence &&
			this.config.persistenceKey
		) {
			this.pagehideHandler = () => this.flushPersist()
			window.addEventListener('pagehide', this.pagehideHandler)
		}

		try {
			this.state =
				(!this.config.deferredHydration && this.loadPersistedState()) || config.initialState
			this.validateCurrentState()
		} catch (error) {
			this.logger.warn('Failed to load persisted state, using initial state', error)
			this.state = config.initialState
			this.validateCurrentState()
		}

		if (!this.config.deferredHydration && this.config.enableAutoSave) {
			this.startAutoSave()
		}

		if (config.enableDevTools) {
			this.initializeDevTools(config.enableDevTools)
		}

		// With deferredHydration, sync starts in hydrateFromPersisted() so a remote
		// full-sync response can't overwrite persisted state before it's read
		if (config.enableSync && !this.config.deferredHydration) {
			this.initializeSync(config.enableSync)
		}

		this.logger.info('StateMachine initialized', {
			persistenceKey: this.config.persistenceKey,
			autoSaveIntervalMs: this.config.autoSaveIntervalMs,
			maxHistorySize: this.config.maxHistorySize,
		})
	}

	protected async saveToServer(_state: T): Promise<void> {}
	protected async loadFromServer(): Promise<T | null> {
		return null
	}

	public get isHydrated(): boolean {
		return !this.config.deferredHydration || this._hydrated
	}

	public hydrateFromPersisted(): void {
		if (!this.config.deferredHydration || this._hydrated || this.isDestroyed) {
			return
		}

		this._hydrated = true

		try {
			const persisted = this.loadPersistedState()
			if (persisted) {
				this.state = persisted
				this.validateCurrentState()
				this.notifyListeners()
				this.logger.debug('Deferred hydration applied persisted state')
			}
		} catch (error) {
			this.logger.warn('Deferred hydration failed, keeping current state', error)
		}

		if (this.config.enableAutoSave && !this.autoSaveTimer) {
			this.startAutoSave()
		}

		if (this.config.enableSync && !this.syncManager) {
			this.initializeSync(this.config.enableSync)
		}
	}

	/*
	 *   PUBLIC
	 ***************************************************************************************************/

	/*
	 * CORE METHODS
	 */
	public getState(): T {
		this.assertNotDestroyed()
		return this.state
	}

	public subscribe(listener: (state: T) => void): () => void {
		this.assertNotDestroyed()

		if (typeof listener !== 'function') {
			throw new StateValidationError('Listener must be a function')
		}

		this.listeners.add(listener)

		this.logger.debug('Listener subscribed', {
			totalListeners: this.listeners.size,
		})

		return () => {
			this.listeners.delete(listener)
			this.logger.debug('Listener unsubscribed', {
				totalListeners: this.listeners.size,
			})
		}
	}

	public mutate(recipe: (draft: Draft<T>) => void, description?: string): void {
		this.assertNotDestroyed()

		if (typeof recipe !== 'function') {
			throw new StateValidationError('Recipe must be a function')
		}

		try {
			const finalRecipe = this.composeMiddleware(recipe, description, 'mutate')

			let patches: Patch[] = []
			let inversePatches: Patch[] = []

			const nextState = produce(this.state, finalRecipe, (p, ip) => {
				patches = p
				inversePatches = ip
			})

			if (patches.length > 0) {
				this.validateState(nextState)
				this.saveToHistory(patches, inversePatches, description)
				this.commit(nextState, patches, inversePatches, description, 'mutate')

				this.logger.debug('State mutated', {
					description,
					patchCount: patches.length,
					historySize: this.history.length,
				})
			}
		} catch (error) {
			this.logger.error('State mutation failed', { description, error })

			this.emit('error', {
				error: error instanceof Error ? error : new Error(String(error)),
				operation: 'mutate',
			})

			if (error instanceof StateValidationError) {
				throw error
			}

			throw new StateMachineError(
				`State mutation failed: ${
					error instanceof Error ? error.message : 'Unknown error'
				}`,
				'MUTATION_ERROR'
			)
		}
	}

	public batch(mutations: Array<(draft: Draft<T>) => void>, description?: string): void {
		this.assertNotDestroyed()

		if (!Array.isArray(mutations)) {
			throw new StateValidationError('Mutations must be an array')
		}

		if (mutations.length === 0) {
			this.logger.debug('Empty batch operation ignored')
			return
		}

		try {
			const allPatches: Patch[] = []
			const allInversePatches: Patch[] = []

			const finalState = mutations.reduce((currentState, recipe, index) => {
				if (typeof recipe !== 'function') {
					throw new StateValidationError(`Mutation at index ${index} must be a function`)
				}

				const finalRecipe = this.composeMiddleware(recipe, description, 'batch')

				let patches: Patch[] = []
				let inversePatches: Patch[] = []

				const nextState = produce(currentState, finalRecipe, (p, ip) => {
					patches = p
					inversePatches = ip
				})

				allPatches.push(...patches)
				allInversePatches.unshift(...inversePatches)

				return nextState
			}, this.state)

			if (allPatches.length > 0) {
				this.validateState(finalState)
				this.saveToHistory(allPatches, allInversePatches, description || 'Batch operation')
				this.commit(finalState, allPatches, allInversePatches, description, 'batch')

				this.logger.debug('Batch operation completed', {
					description,
					mutationCount: mutations.length,
					patchCount: allPatches.length,
				})
			}
		} catch (error) {
			this.logger.error('Batch operation failed', { description, error })

			this.emit('error', {
				error: error instanceof Error ? error : new Error(String(error)),
				operation: 'batch',
			})

			throw new StateMachineError(
				`Batch operation failed: ${
					error instanceof Error ? error.message : 'Unknown error'
				}`,
				'BATCH_ERROR'
			)
		}
	}

	/*
	 * UNDO/REDO METHODS
	 */
	public undo(): boolean {
		this.assertNotDestroyed()

		if (!this.canUndo()) {
			this.logger.debug('Undo operation ignored - no history available')
			return false
		}

		try {
			const snapshot = this.history[this.historyIndex]
			if (!snapshot) {
				return false
			}
			const newState = applyPatches(this.state, snapshot.inversePatches) as T

			this.validateState(newState)
			this.historyIndex--
			this.historyInfoCache = null
			this.commit(
				newState,
				snapshot.inversePatches,
				snapshot.patches,
				snapshot.description,
				'undo'
			)

			this.logger.debug('Undo operation completed', {
				description: snapshot.description,
				newHistoryIndex: this.historyIndex,
			})

			return true
		} catch (error) {
			this.logger.error('Undo operation failed', error)

			this.emit('error', {
				error: error instanceof Error ? error : new Error(String(error)),
				operation: 'undo',
			})

			return false
		}
	}

	public redo(): boolean {
		this.assertNotDestroyed()

		if (!this.canRedo()) {
			this.logger.debug('Redo operation ignored - no future history available')
			return false
		}

		try {
			this.historyIndex++
			const snapshot = this.history[this.historyIndex]
			if (!snapshot) {
				this.historyIndex--
				return false
			}
			const newState = applyPatches(this.state, snapshot.patches) as T

			this.validateState(newState)
			this.historyInfoCache = null
			this.commit(
				newState,
				snapshot.patches,
				snapshot.inversePatches,
				snapshot.description,
				'redo'
			)

			this.logger.debug('Redo operation completed', {
				description: snapshot.description,
				newHistoryIndex: this.historyIndex,
			})

			return true
		} catch (error) {
			this.logger.error('Redo operation failed', error)

			this.emit('error', {
				error: error instanceof Error ? error : new Error(String(error)),
				operation: 'redo',
			})

			this.historyIndex--
			this.historyInfoCache = null
			return false
		}
	}

	public applyPatchSet(patches: Patch[], description?: string): void {
		this.mutate(draft => {
			applyPatches(draft, patches)
		}, description)
	}

	public canUndo(): boolean {
		return this.historyIndex >= 0
	}

	public canRedo(): boolean {
		return this.historyIndex < this.history.length - 1
	}

	/*
	 * HISTORY METHODS
	 */
	public getHistoryInfo(): StateHistoryInfo {
		// Keep this referentially stable between history changes, since
		// useSyncExternalStore compares snapshots with Object.is
		if (!this.historyInfoCache) {
			this.historyInfoCache = {
				canUndo: this.canUndo(),
				canRedo: this.canRedo(),
				historyLength: this.history.length,
				currentIndex: this.historyIndex,
				lastAction: this.history[this.historyIndex]?.description || null,
			}
		}
		return this.historyInfoCache
	}

	public clearHistory(): void {
		this.assertNotDestroyed()

		const oldLength = this.history.length
		this.history = []
		this.historyIndex = -1
		this.historyInfoCache = null

		this.logger.info('History cleared', { previousLength: oldLength })
	}

	/*
	 * LIFECYCLE EVENT METHODS
	 */
	public on<E extends LifecycleEvent>(event: E, listener: LifecycleListener<T, E>): () => void {
		this.assertNotDestroyed()

		if (!this.eventListeners) {
			this.eventListeners = new Map()
		}

		let listeners = this.eventListeners.get(event)
		if (!listeners) {
			listeners = new Set()
			this.eventListeners.set(event, listeners)
		}

		listeners.add(listener as LifecycleListener<T, LifecycleEvent>)

		this.logger.debug('Lifecycle listener added', {
			event,
			totalListeners: listeners.size,
		})

		return () => {
			const eventSet = this.eventListeners?.get(event)
			if (eventSet) {
				eventSet.delete(listener as LifecycleListener<T, LifecycleEvent>)

				if (eventSet.size === 0) {
					this.eventListeners?.delete(event)
					if (this.eventListeners?.size === 0) {
						this.eventListeners = null
					}
				}
			}
			this.logger.debug('Lifecycle listener removed', { event })
		}
	}

	/*
	 * SAVE/LOAD METHODS
	 */
	public async forceSave(): Promise<void> {
		this.assertNotDestroyed()

		if (!this.isDirty) {
			this.logger.debug('Force save skipped - no changes')
			return
		}

		try {
			this.logger.debug('Force save started')

			await this.saveToServer(this.state)
			this.persistNow()
			this.isDirty = false

			this.logger.info('Force save completed successfully')
		} catch (error) {
			this.logger.error('Force save failed', error)

			this.emit('error', {
				error: error instanceof Error ? error : new Error(String(error)),
				operation: 'persist',
			})

			throw new StatePersistenceError(
				`Force save failed: ${error instanceof Error ? error.message : 'Unknown error'}`
			)
		}
	}

	public hasUnsavedChanges(): boolean {
		return this.isDirty
	}

	public setAutoSaveInterval(ms: number): void {
		this.assertNotDestroyed()

		if (typeof ms !== 'number' || ms <= 0) {
			throw new StateValidationError('Auto-save interval must be a positive number')
		}

		this.config.autoSaveIntervalMs = ms
		this.restartAutoSave()

		this.logger.info('Auto-save interval updated', { ms })
	}

	public async loadFromServerManually(): Promise<boolean> {
		this.assertNotDestroyed()

		try {
			this.logger.debug('Manual server load started')

			const serverState = await this.loadFromServer()
			if (serverState) {
				this.validateState(serverState)
				this.state = serverState
				this.isDirty = false
				this.clearHistory()
				this.notifyListeners()
				this.persistNow()

				this.logger.info('Manual server load completed successfully')
				return true
			}

			this.logger.debug('No server state available')
			return false
		} catch (error) {
			this.logger.error('Manual server load failed', error)
			return false
		}
	}

	/*
	 * RESET METHODS
	 */
	public reset(): void {
		this.assertNotDestroyed()

		const initialState = this.config.initialState

		this.logger.debug('Resetting state to initial state')
		this.validateState(initialState)

		this.history = []
		this.historyIndex = -1
		this.historyInfoCache = null

		this.setState(initialState)

		if (this.devtools) {
			this.devtools.send('State Reset', initialState, [])
		}

		if (this.syncManager) {
			this.syncManager.broadcastChange(initialState, [], [], 'State Reset')
		}

		this.logger.info('State reset to initial state')
	}

	public getInitialState(): T {
		return this.config.initialState
	}

	/*
	 * CLEANUP METHODS
	 */
	public destroy(): void {
		if (this.isDestroyed) {
			return
		}

		this.logger.info('Destroying StateMachine')
		this.emit('destroy', { finalState: this.state })

		this.flushPersist()

		if (this.pagehideHandler) {
			window.removeEventListener('pagehide', this.pagehideHandler)
			this.pagehideHandler = null
		}

		this.isDestroyed = true
		this.listeners.clear()

		if (this.autoSaveTimer) {
			clearInterval(this.autoSaveTimer)
			this.autoSaveTimer = null
		}

		if (this.devtools) {
			this.devtools.disconnect()
			this.devtools = null
		}

		if (this.syncManager) {
			this.syncManager.destroy()
			this.syncManager = null
		}

		this.history = []
		this.listeners = new Set()
		this.eventListeners = null

		this.logger.info('StateMachine destroyed')
	}

	/*
	 *   PROTECTED METHODS
	 ***************************************************************************************************/

	protected setState(newState: T, markDirty = true): void {
		this.state = newState

		if (markDirty) {
			this.isDirty = true
		}

		this.notifyListeners()
		this.schedulePersist()
	}

	private commit(
		nextState: T,
		patches: Patch[],
		inversePatches: Patch[],
		description: string | undefined,
		operation: MutationOperation
	): void {
		// Undo/redo revert to states that were already saved, so they don't mark dirty
		this.setState(nextState, operation === 'mutate' || operation === 'batch')

		this.emit('afterMutate', {
			state: nextState,
			patches,
			inversePatches,
			description,
			operation,
		})

		if (this.devtools) {
			this.devtools.send(description || operation, nextState, patches)
		}

		if (this.syncManager) {
			this.syncManager.broadcastChange(nextState, patches, inversePatches, description)
		}
	}

	protected emit<E extends LifecycleEvent>(event: E, payload: LifecyclePayloadMap<T>[E]): void {
		const listeners = this.eventListeners?.get(event)
		if (!listeners?.size) {
			return
		}

		listeners.forEach(listener => {
			try {
				listener(payload)
			} catch (error) {
				this.logger.error(`Lifecycle event listener error for '${event}'`, error)
			}
		})
	}

	/*
	 *   PRIVATE METHODS
	 ***************************************************************************************************/

	/*
	 * STATE VALIDATION
	 */
	private assertNotDestroyed(): void {
		if (this.isDestroyed) {
			throw new StateMachineError('Cannot operate on destroyed StateMachine', 'DESTROYED')
		}
	}

	private validateConfig(config: StateConfig<T>): void {
		if (
			!config.initialState ||
			typeof config.initialState !== 'object' ||
			config.initialState === null
		) {
			throw new StateValidationError('Initial state must be an object')
		}

		if (config.autoSaveIntervalMs !== undefined && config.autoSaveIntervalMs <= 0) {
			throw new StateValidationError('Auto-save interval must be positive')
		}

		if (config.maxHistorySize !== undefined && config.maxHistorySize <= 0) {
			throw new StateValidationError('Max history size must be positive')
		}
	}

	private validateCurrentState(): void {
		this.validateState(this.state)
	}

	protected validateState(state: T): void {
		if (!this.config.validateState(state)) {
			throw new StateValidationError('State validation failed')
		}
	}

	private notifyListeners(): void {
		if (this.listeners.size === 0) {
			return
		}

		const frozenState = this.state
		let errorCount = 0

		this.listeners.forEach(listener => {
			try {
				listener(frozenState)
			} catch (error) {
				errorCount++
				this.logger.error('Listener notification failed', error)
			}
		})

		if (errorCount > 0) {
			this.logger.warn(`${errorCount} listener(s) failed during notification`)
		}
	}

	/*
	 * HISTORY
	 */
	private saveToHistory(patches: Patch[], inversePatches: Patch[], description?: string): void {
		if (this.historyIndex < this.history.length - 1) {
			this.history = this.history.slice(0, this.historyIndex + 1)
		}

		const snapshot: StateSnapshot = {
			patches,
			inversePatches,
			timestamp: Date.now(),
		}

		if (description) {
			snapshot.description = description
		}

		this.history.push(snapshot)

		this.historyIndex++
		this.historyInfoCache = null

		if (this.history.length > this.config.maxHistorySize) {
			this.history.shift()
			this.historyIndex--
			this.logger.debug('History trimmed to max size', {
				maxSize: this.config.maxHistorySize,
			})
		}
	}

	/*
	 * MIDDLEWARE
	 */
	private composeMiddleware(
		recipe: (draft: Draft<T>) => void,
		description: string | undefined,
		operation: MutationOperation = 'mutate'
	): (draft: Draft<T>) => void {
		if (this.config.middleware.length === 0) {
			return recipe
		}

		const context: MiddlewareContext<T> = {
			state: this.state,
			description: description,
			operation,
			timestamp: Date.now(),
		}

		Object.freeze(context)

		return this.config.middleware.reduceRight<(draft: Draft<T>) => void>(
			(next, middleware) => draft => middleware(context, next, draft),
			recipe
		)
	}

	/*
	 * DEVTOOLS
	 */
	private initializeDevTools(config: boolean | DevToolsConfig): void {
		const devtoolsConfig = typeof config === 'boolean' ? { name: 'StateMachine' } : config

		this.devtools = new DevToolsConnector(
			devtoolsConfig.name || 'StateMachine',
			devtoolsConfig,
			(newState: T) => this.handleDevToolsTimeTravel(newState)
		)

		this.devtools.init(this.state)
	}

	private handleDevToolsTimeTravel(newState: T): void {
		try {
			this.validateState(newState)
			this.state = newState
			this.clearHistory()
			this.notifyListeners()
			this.logger.debug('DevTools time-travel applied')
		} catch (error) {
			this.logger.error('DevTools time-travel failed', error)
		}
	}

	/*
	 * SYNC
	 */
	private initializeSync(config: boolean | SyncConfig): void {
		const syncConfig = typeof config === 'boolean' ? {} : config

		this.syncManager = new StateSyncManager(
			syncConfig,
			() => this.state,
			(newState, patches) => this.handleRemoteStateUpdate(newState, patches)
		)
	}

	private handleRemoteStateUpdate(newState: T, patches?: Patch[]): void {
		// Dropped updates are recovered by the post-hydration requestFullSync
		if (!this.isHydrated) {
			this.logger.debug('Skipping remote state update before hydration')
			return
		}

		try {
			if (patches) {
				const patchedState = applyPatches(this.state, patches) as T
				this.validateState(patchedState)
				this.state = patchedState
			} else {
				this.validateState(newState)
				this.state = newState
			}

			this.notifyListeners()
			this.schedulePersist()

			this.logger.debug('Applied remote state update')
		} catch (error) {
			this.logger.error('Failed to apply remote state update', error)
		}
	}

	/*
	 * PERSISTENCE
	 */
	private filterStateForPersistence(state: T): Partial<T> {
		if (!this.config.persistenceFilter) {
			return state
		}

		const filter = this.config.persistenceFilter

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

	private schedulePersist(): void {
		if (typeof window === 'undefined') {
			return
		}
		if (!this.config.enablePersistence || !this.config.persistenceKey) {
			return
		}
		if (this.persistTimer) {
			return
		}

		this.persistTimer = setTimeout(() => {
			this.persistTimer = null
			this.persistNow()
		}, PERSIST_DEBOUNCE_MS)
	}

	private flushPersist(): void {
		if (this.persistTimer) {
			clearTimeout(this.persistTimer)
			this.persistTimer = null
			this.persistNow()
		}
	}

	private persistNow(): void {
		if (typeof window === 'undefined') {
			return
		}
		if (!this.config.enablePersistence || !this.config.persistenceKey) {
			return
		}

		try {
			const stateToSave = this.filterStateForPersistence(this.state)

			const persistedState: PersistedState<Partial<T>> = {
				state: stateToSave,
				timestamp: Date.now(),
			}

			const serialized = JSON.stringify(persistedState)

			if (serialized.length > MAX_PERSIST_CHARS) {
				this.logger.warn(
					`State too large to persist: ${(serialized.length / 1024 / 1024).toFixed(2)}MB exceeds ${(MAX_PERSIST_CHARS / 1024 / 1024).toFixed(2)}MB limit`
				)

				this.emit('error', {
					error: new StatePersistenceError('State too large for localStorage'),
					operation: 'persist',
				})

				return
			}

			localStorage.setItem(this.config.persistenceKey, serialized)
		} catch (error) {
			if (error instanceof Error && error.name === 'QuotaExceededError') {
				this.logger.error('localStorage quota exceeded')
				this.emit('error', {
					error: new StatePersistenceError('localStorage quota exceeded'),
					operation: 'persist',
				})
			} else {
				this.logger.warn('Failed to persist state to localStorage', error)
			}
		}
	}

	private loadPersistedState(): T | null {
		if (typeof window === 'undefined') {
			return null
		}
		if (!this.config.enablePersistence || !this.config.persistenceKey) {
			return null
		}

		try {
			const stored = localStorage.getItem(this.config.persistenceKey)
			if (!stored) {
				return null
			}

			const parsed = JSON.parse(stored, (key, value) => {
				if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
					this.logger.warn('Detected prototype pollution attempt in persisted state')
					return undefined
				}
				return value
			})

			if (!parsed || typeof parsed !== 'object' || !parsed.state) {
				this.logger.warn('Invalid persisted state structure')
				return null
			}

			const persistedState = parsed as PersistedState<Partial<T>>

			if (
				Object.prototype.hasOwnProperty.call(persistedState, '__proto__') ||
				Object.prototype.hasOwnProperty.call(persistedState, 'constructor') ||
				Object.prototype.hasOwnProperty.call(persistedState.state, '__proto__') ||
				Object.prototype.hasOwnProperty.call(persistedState.state, 'constructor')
			) {
				this.logger.warn('Detected prototype pollution in persisted state')
				return null
			}

			const mergedState = {
				...this.config.initialState,
				...persistedState.state,
			} as T

			this.logger.debug('Loaded persisted state', {
				timestamp: persistedState.timestamp,
			})

			return mergedState
		} catch (error) {
			this.logger.warn('Failed to load persisted state', error)
			return null
		}
	}

	/*
	 * AUTO SAVE
	 */
	private startAutoSave(): void {
		if (typeof window === 'undefined') {
			return
		}
		if (!this.config.enableAutoSave) {
			return
		}

		this.autoSaveTimer = setInterval(async () => {
			if (this.isDirty && !this.isDestroyed) {
				try {
					await this.forceSave()
				} catch (error) {
					this.logger.error('Auto-save failed', error)
				}
			}
		}, this.config.autoSaveIntervalMs)

		this.logger.debug('Auto-save started', {
			intervalMs: this.config.autoSaveIntervalMs,
		})
	}

	private restartAutoSave(): void {
		if (this.autoSaveTimer) {
			clearInterval(this.autoSaveTimer)
		}
		this.startAutoSave()
	}
}

/*
 *   FACTORY
 ***************************************************************************************************/
export function createStateMachine<T extends object>(config: StateConfig<T>): StateMachine<T> {
	return new StateMachine(config)
}
