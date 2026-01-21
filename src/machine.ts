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
const DEFAULT_AUTO_SAVE_INTERVAL = 5 // in minutes
const DEFAULT_MAX_HISTORY_SIZE = 50
const DEFAULT_VERSION = '1.0.0'
const NOTIFICATION_DEBOUNCE_MS = 16

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
) => void | Promise<void>

export type PersistenceFilter<T> = {
	exclude?: (keyof T)[]
	include?: (keyof T)[]
	custom?: (state: T) => Partial<T>
}

export interface StateConfig<T extends object> {
	initialState: T
	persistenceKey?: string
	autoSaveInterval?: number
	maxHistorySize?: number
	enablePersistence?: boolean
	enableAutoSave?: boolean
	enableLogging?: boolean
	validateState?: (state: T) => boolean
	middleware?: Middleware<T>[]
	persistenceFilter?: PersistenceFilter<T>
	enableDevTools?: boolean | DevToolsConfig
	enableSync?: boolean | SyncConfig
}

interface InternalStateConfig<T extends object> {
	initialState: T
	persistenceKey: string | null
	autoSaveInterval: number
	maxHistorySize: number
	enablePersistence: boolean
	enableAutoSave: boolean
	enableLogging: boolean
	validateState: (state: T) => boolean
	middleware: Middleware<T>[]
	persistenceFilter: PersistenceFilter<T> | null
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
	version: string
	checksum?: string
}

export interface StateHistoryInfo {
	canUndo: boolean
	canRedo: boolean
	historyLength: number
	currentIndex: number
	lastAction: string | null
	memoryUsage: number
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

// Compact logger - will be optimized out in production builds
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
 *   FUNCTIONS
 ***************************************************************************************************/
function debounce<T extends (...args: unknown[]) => void>(func: T, wait: number): T {
	let timeout: ReturnType<typeof setTimeout>
	return ((...args: Parameters<T>) => {
		clearTimeout(timeout)
		timeout = setTimeout(() => func(...args), wait)
	}) as T
}

// Compact utility functions
const calculateMemoryUsage = (data: unknown): number => {
	try {
		return new Blob([JSON.stringify(data)]).size
	} catch {
		return 0
	}
}

const generateChecksum = async (data: unknown): Promise<string> => {
	try {
		const str = JSON.stringify(data)

		// Use Web Crypto API if available (SHA-256)
		if (typeof crypto !== 'undefined' && crypto.subtle) {
			try {
				const encoder = new TextEncoder()
				const dataBuffer = encoder.encode(str)
				const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer)
				const hashArray = Array.from(new Uint8Array(hashBuffer))
				return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
			} catch {
				// Fall through to fallback if crypto fails
			}
		}

		// Fallback: Better non-cryptographic hash (djb2)
		let hash = 5381
		for (let i = 0; i < str.length; i++) {
			hash = (hash << 5) + hash + str.charCodeAt(i)
		}
		return Math.abs(hash).toString(36)
	} catch {
		return ''
	}
}

/*
 *   STATE MACHINE
 ***************************************************************************************************/
export abstract class StateMachine<T extends object> {
	protected state: T
	protected config: InternalStateConfig<T>
	protected listeners: Set<(state: T) => void> = new Set()
	protected history: StateSnapshot[] = []
	protected historyIndex = -1
	protected isDirty = false
	protected autoSaveTimer: ReturnType<typeof setInterval> | null = null
	protected isDestroyed = false
	protected logger: ReturnType<typeof createLogger>
	protected debouncedNotify: () => void
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
			autoSaveInterval: config.autoSaveInterval ?? DEFAULT_AUTO_SAVE_INTERVAL,
			maxHistorySize: config.maxHistorySize ?? DEFAULT_MAX_HISTORY_SIZE,
			enablePersistence: config.enablePersistence ?? true,
			enableAutoSave: config.enableAutoSave ?? true,
			enableLogging: config.enableLogging ?? false,
			validateState: config.validateState ?? (() => true),
			middleware: config.middleware ?? [],
			persistenceFilter: config.persistenceFilter ?? null,
		}

		this.logger = createLogger(this.config.enableLogging)
		this.debouncedNotify = debounce(() => this.notifyListeners(), NOTIFICATION_DEBOUNCE_MS)

		try {
			this.state = this.loadPersistedState() || config.initialState
			this.validateCurrentState()
		} catch (error) {
			this.logger.warn('Failed to load persisted state, using initial state', error)
			this.state = config.initialState

			// Validate the fallback initial state
			this.validateCurrentState()
		}

		if (this.config.enableAutoSave) {
			this.startAutoSave()
		}

		// Initialize DevTools if enabled
		if (config.enableDevTools) {
			this.initializeDevTools(config.enableDevTools)
		}

		// Initialize Sync if enabled
		if (config.enableSync) {
			this.initializeSync(config.enableSync)
		}

		this.logger.info('StateMachine initialized', {
			persistenceKey: this.config.persistenceKey,
			autoSaveInterval: this.config.autoSaveInterval,
			maxHistorySize: this.config.maxHistorySize,
		})
	}

	protected async saveToServer(_state: T): Promise<void> {}
	protected async loadFromServer(): Promise<T | null> {
		return null
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

		try {
			listener(this.state)
		} catch (error) {
			this.logger.error('Initial listener call failed', error)
		}

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
			// Execute middleware chain
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
				this.setState(nextState)

				this.emit('afterMutate', {
					state: nextState,
					patches,
					inversePatches,
					description,
					operation: 'mutate',
				})

				// Send to DevTools
				if (this.devtools) {
					this.devtools.send(description || 'State Mutated', nextState, patches)
				}

				// Broadcast to other tabs
				if (this.syncManager) {
					this.syncManager.broadcastChange(
						nextState,
						patches,
						inversePatches,
						description
					)
				}

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

			// Re-throw validation errors without wrapping them
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

				// Execute middleware chain for each mutation in batch
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
				this.setState(finalState)

				this.emit('afterMutate', {
					state: finalState,
					patches: allPatches,
					inversePatches: allInversePatches,
					description,
					operation: 'batch',
				})

				// Send to DevTools
				if (this.devtools) {
					this.devtools.send(description || 'Batch Operation', finalState, allPatches)
				}

				// Broadcast to other tabs
				if (this.syncManager) {
					this.syncManager.broadcastChange(
						finalState,
						allPatches,
						allInversePatches,
						description
					)
				}

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
			this.setState(newState, false)

			this.emit('afterMutate', {
				state: newState,
				patches: snapshot.inversePatches,
				inversePatches: snapshot.patches,
				description: snapshot.description,
				operation: 'undo',
			})

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
			this.setState(newState, false)

			this.emit('afterMutate', {
				state: newState,
				patches: snapshot.patches,
				inversePatches: snapshot.inversePatches,
				description: snapshot.description,
				operation: 'redo',
			})

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
			return false
		}
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
		return {
			canUndo: this.canUndo(),
			canRedo: this.canRedo(),
			historyLength: this.history.length,
			currentIndex: this.historyIndex,
			lastAction: this.history[this.historyIndex]?.description || null,
			memoryUsage: calculateMemoryUsage(this.history),
		}
	}

	public clearHistory(): void {
		this.assertNotDestroyed()

		const oldLength = this.history.length
		this.history = []
		this.historyIndex = -1

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
			this.persistToLocal()
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

	public setAutoSaveInterval(minutes: number): void {
		this.assertNotDestroyed()

		if (typeof minutes !== 'number' || minutes <= 0) {
			throw new StateValidationError('Auto-save interval must be a positive number')
		}

		this.config.autoSaveInterval = minutes
		this.restartAutoSave()

		this.logger.info('Auto-save interval updated', { minutes })
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
				this.persistToLocal()

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
	 * CLEANUP METHODS
	 */
	public destroy(): void {
		if (this.isDestroyed) {
			return
		}

		this.logger.info('Destroying StateMachine')
		this.emit('destroy', { finalState: this.state })

		this.isDestroyed = true
		this.listeners.clear()

		if (this.autoSaveTimer) {
			clearInterval(this.autoSaveTimer)
			this.autoSaveTimer = null
		}

		// Disconnect DevTools
		if (this.devtools) {
			this.devtools.disconnect()
			this.devtools = null
		}

		// Destroy sync manager
		if (this.syncManager) {
			this.syncManager.destroy()
			this.syncManager = null
		}

		// Clear references to help garbage collection
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

		this.debouncedNotify()
		this.persistToLocal()
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

		if (config.autoSaveInterval !== undefined && config.autoSaveInterval <= 0) {
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

		// Freeze context to prevent modification
		Object.freeze(context)

		// Compose middleware chain in reverse order with timeout protection
		const composed = this.config.middleware.reduceRight((next, middleware) => {
			return (draft: Draft<T>) => {
				let completed = false
				const timeoutMs = 5000

				const timer = setTimeout(() => {
					if (!completed) {
						const error = new StateMachineError(
							'Middleware execution timeout',
							'MIDDLEWARE_TIMEOUT'
						)
						this.logger.error('Middleware timeout', {
							description,
							operation,
							timeoutMs,
						})
						throw error
					}
				}, timeoutMs)

				try {
					middleware(context, next, draft)
					completed = true
					clearTimeout(timer)
				} catch (error) {
					completed = true
					clearTimeout(timer)
					throw error
				}
			}
		}, recipe)

		return composed
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
		// Time-travel from DevTools
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
		// State update from another tab
		try {
			if (patches) {
				// Apply patches approach
				const patchedState = applyPatches(this.state, patches) as T
				this.validateState(patchedState)
				this.state = patchedState
			} else {
				// Full state replacement
				this.validateState(newState)
				this.state = newState
			}

			this.notifyListeners()
			this.persistToLocal()

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

		// Custom filter takes precedence
		if (filter.custom) {
			return filter.custom(state)
		}

		// Exclude approach (blacklist)
		if (filter.exclude) {
			const filtered = { ...state }
			filter.exclude.forEach(key => {
				delete filtered[key]
			})
			return filtered
		}

		// Include approach (whitelist)
		if (filter.include) {
			const filtered: Partial<T> = {}
			filter.include.forEach(key => {
				filtered[key] = state[key]
			})
			return filtered
		}

		return state
	}

	private persistToLocal(): void {
		if (!this.config.enablePersistence || !this.config.persistenceKey) {
			return
		}

		// Use async IIFE to handle async checksum generation
		;(async () => {
			try {
				// Filter state before persisting
				const stateToSave = this.filterStateForPersistence(this.state)

				const checksum = await generateChecksum(stateToSave)

				const persistedState: PersistedState<Partial<T>> = {
					state: stateToSave,
					timestamp: Date.now(),
					version: DEFAULT_VERSION,
					checksum: checksum,
				}

				const serialized = JSON.stringify(persistedState)

				// Check size (5MB limit as conservative estimate for most browsers)
				const sizeInBytes = new Blob([serialized]).size
				const maxSizeBytes = 5 * 1024 * 1024 // 5MB

				if (sizeInBytes > maxSizeBytes) {
					this.logger.warn(
						`State too large to persist: ${(sizeInBytes / 1024 / 1024).toFixed(2)}MB exceeds ${(maxSizeBytes / 1024 / 1024).toFixed(2)}MB limit`
					)

					this.emit('error', {
						error: new StatePersistenceError('State too large for localStorage'),
						operation: 'persist',
					})

					return
				}

				if (this.config.persistenceKey) {
					localStorage.setItem(this.config.persistenceKey, serialized)
				}
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
		})()
	}

	private loadPersistedState(): T | null {
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

			if (persistedState.checksum) {
				generateChecksum(persistedState.state).then(expectedChecksum => {
					if (persistedState.checksum !== expectedChecksum) {
						this.logger.warn('Persisted state checksum mismatch detected')
					}
				})
			}

			// Merge persisted state with initial state (for filtered fields)
			const mergedState = {
				...this.config.initialState,
				...persistedState.state,
			} as T

			this.logger.debug('Loaded persisted state', {
				timestamp: persistedState.timestamp,
				version: persistedState.version,
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
		if (!this.config.enableAutoSave) {
			return
		}

		const interval = this.config.autoSaveInterval * 60 * 1000

		this.autoSaveTimer = setInterval(async () => {
			if (this.isDirty && !this.isDestroyed) {
				try {
					await this.forceSave()
				} catch (error) {
					this.logger.error('Auto-save failed', error)
				}
			}
		}, interval)

		this.logger.debug('Auto-save started', {
			intervalMinutes: this.config.autoSaveInterval,
		})
	}

	private restartAutoSave(): void {
		if (this.autoSaveTimer) {
			clearInterval(this.autoSaveTimer)
		}
		this.startAutoSave()
	}
}
