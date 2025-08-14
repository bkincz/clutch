/*
 *   IMPORTS
 ***************************************************************************************************/
import { produce, enablePatches, applyPatches, type Patch, type Draft } from 'immer'

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
export interface StateConfig<T extends object> {
	initialState: T
	persistenceKey?: string
	autoSaveInterval?: number
	maxHistorySize?: number
	enablePersistence?: boolean
	enableAutoSave?: boolean
	enableLogging?: boolean
	validateState?: (state: T) => boolean
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

// Compact logger - will be optimized out in production builds
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

const generateChecksum = (data: unknown): string => {
	try {
		const str = JSON.stringify(data)
		let hash = 0
		for (let i = 0; i < str.length; i++) {
			hash = ((hash << 5) - hash + str.charCodeAt(i)) & hash
		}
		return hash.toString(36)
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

		this.logger.info('StateMachine initialized', {
			persistenceKey: this.config.persistenceKey,
			autoSaveInterval: this.config.autoSaveInterval,
			maxHistorySize: this.config.maxHistorySize,
		})
	}

	// TODO: Remove this and separate it from class in the future
	protected abstract saveToServer(state: T): Promise<void>
	protected abstract loadFromServer(): Promise<T | null>

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
			let patches: Patch[] = []
			let inversePatches: Patch[] = []

			const nextState = produce(this.state, recipe, (p, ip) => {
				patches = p
				inversePatches = ip
			})

			if (patches.length > 0) {
				this.validateState(nextState)
				this.saveToHistory(patches, inversePatches, description)
				this.setState(nextState)

				this.logger.debug('State mutated', {
					description,
					patchCount: patches.length,
					historySize: this.history.length,
				})
			}
		} catch (error) {
			this.logger.error('State mutation failed', { description, error })

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

				let patches: Patch[] = []
				let inversePatches: Patch[] = []

				const nextState = produce(currentState, recipe, (p, ip) => {
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

				this.logger.debug('Batch operation completed', {
					description,
					mutationCount: mutations.length,
					patchCount: allPatches.length,
				})
			}
		} catch (error) {
			this.logger.error('Batch operation failed', { description, error })
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

			this.logger.debug('Undo operation completed', {
				description: snapshot.description,
				newHistoryIndex: this.historyIndex,
			})

			return true
		} catch (error) {
			this.logger.error('Undo operation failed', error)
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

			this.logger.debug('Redo operation completed', {
				description: snapshot.description,
				newHistoryIndex: this.historyIndex,
			})

			return true
		} catch (error) {
			this.logger.error('Redo operation failed', error)
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

		this.isDestroyed = true
		this.listeners.clear()

		if (this.autoSaveTimer) {
			clearInterval(this.autoSaveTimer)
			this.autoSaveTimer = null
		}

		// Clear references to help garbage collection
		this.history = []
		this.listeners = new Set()

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
	 * PERSISTENCE
	 */
	private persistToLocal(): void {
		if (!this.config.enablePersistence || !this.config.persistenceKey) {
			return
		}

		try {
			const persistedState: PersistedState<T> = {
				state: this.state,
				timestamp: Date.now(),
				version: DEFAULT_VERSION,
				checksum: generateChecksum(this.state),
			}

			localStorage.setItem(this.config.persistenceKey, JSON.stringify(persistedState))
		} catch (error) {
			this.logger.warn('Failed to persist state to localStorage', error)
		}
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

			const persistedState: PersistedState<T> = JSON.parse(stored)

			// Validate checksum if present
			if (persistedState.checksum) {
				const expectedChecksum = generateChecksum(persistedState.state)
				if (persistedState.checksum !== expectedChecksum) {
					this.logger.warn('Persisted state checksum mismatch, ignoring')
					return null
				}
			}

			this.logger.debug('Loaded persisted state', {
				timestamp: persistedState.timestamp,
				version: persistedState.version,
			})

			return persistedState.state
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
