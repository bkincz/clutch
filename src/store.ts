/*
 *   IMPORTS
 ***************************************************************************************************/
import { StateMachine, StateMachineError } from './machine'

/*
 *   TYPES
 ***************************************************************************************************/

/**
 * Configuration options for the StateRegistry
 */
export interface RegistryConfig {
	/** Enable logging for store operations */
	enableLogging?: boolean
}

/**
 * Base constraint for machine registry - maps string keys to object state types
 */
export type MachineStates = Record<string, object>

/**
 * Maps machine names to their state types
 */
export type MachineRegistry<T extends MachineStates> = {
	[K in keyof T]: StateMachine<T[K]>
}

/**
 * Combined state from all registered machines
 */
export type CombinedState<T extends MachineStates> = {
	[K in keyof T]: T[K]
}

/**
 * Listener function for combined state changes
 */
export type RegistryListener<T extends MachineStates> = (state: CombinedState<T>) => void

/**
 * Listener function for individual machine state changes
 */
export type MachineListener<S extends object> = (state: S) => void

// Compact logger
/* eslint-disable no-console */
const createLogger = (enabled: boolean) => ({
	debug: enabled
		? (msg: string, ...args: unknown[]) => console.debug(`[StateRegistry] ${msg}`, ...args)
		: () => {},
	info: enabled
		? (msg: string, ...args: unknown[]) => console.info(`[StateRegistry] ${msg}`, ...args)
		: () => {},
	warn: enabled
		? (msg: string, ...args: unknown[]) => console.warn(`[StateRegistry] ${msg}`, ...args)
		: () => {},
	error: enabled
		? (msg: string, ...args: unknown[]) => console.error(`[StateRegistry] ${msg}`, ...args)
		: () => {},
})
/* eslint-enable no-console */

/*
 *   STATE STORE
 ***************************************************************************************************/

export class StateRegistry<T extends MachineStates> {
	private machines: Map<keyof T, StateMachine<T[keyof T]>> = new Map()
	private listeners: Set<RegistryListener<T>> = new Set()
	private machineUnsubscribers: Map<keyof T, () => void> = new Map()
	private isDestroyed = false
	private logger: ReturnType<typeof createLogger>

	constructor(config: RegistryConfig = {}) {
		this.logger = createLogger(config.enableLogging ?? false)
		this.logger.info('StateRegistry initialized')
	}

	/*
	 *   REGISTRATION
	 */

	public register<K extends keyof T>(name: K, machine: StateMachine<T[K]>): void {
		this.assertNotDestroyed()

		if (this.machines.has(name)) {
			throw new StateMachineError(
				`Machine with name "${String(name)}" is already registered`,
				'DUPLICATE_REGISTRATION'
			)
		}

		this.machines.set(name, machine as unknown as StateMachine<T[keyof T]>)

		// Subscribe to machine changes to notify store listeners
		const unsubscribe = machine.subscribe(() => {
			this.notifyListeners()
		})
		this.machineUnsubscribers.set(name, unsubscribe)

		this.logger.debug('Machine registered', { name })
	}

	public unregister<K extends keyof T>(name: K): void {
		this.assertNotDestroyed()

		if (!this.machines.has(name)) {
			this.logger.warn('Attempted to unregister non-existent machine', { name })
			return
		}

		// Unsubscribe from machine
		const unsubscribe = this.machineUnsubscribers.get(name)
		if (unsubscribe) {
			unsubscribe()
			this.machineUnsubscribers.delete(name)
		}

		this.machines.delete(name)
		this.logger.debug('Machine unregistered', { name })
	}

	public has<K extends keyof T>(name: K): boolean {
		return this.machines.has(name)
	}

	public getMachine<K extends keyof T>(name: K): StateMachine<T[K]> | undefined {
		return this.machines.get(name) as StateMachine<T[K]> | undefined
	}

	public getMachineNames(): (keyof T)[] {
		return Array.from(this.machines.keys())
	}

	/*
	 *   STATE ACCESS
	 */

	public getState(): CombinedState<T> {
		this.assertNotDestroyed()

		const combinedState = {} as CombinedState<T>

		this.machines.forEach((machine, name) => {
			combinedState[name as keyof T] = machine.getState() as T[keyof T]
		})

		return combinedState
	}

	public getMachineState<K extends keyof T>(name: K): T[K] | undefined {
		const machine = this.machines.get(name)
		return machine?.getState() as T[K] | undefined
	}

	/*
	 *   SUBSCRIPTIONS
	 */

	public subscribe(listener: RegistryListener<T>): () => void {
		this.assertNotDestroyed()

		if (typeof listener !== 'function') {
			throw new StateMachineError('Listener must be a function', 'INVALID_LISTENER')
		}

		this.listeners.add(listener)

		// Call listener immediately with current state
		try {
			listener(this.getState())
		} catch (error) {
			this.logger.error('Initial listener call failed', error)
		}

		this.logger.debug('Store listener subscribed', { totalListeners: this.listeners.size })

		return () => {
			this.listeners.delete(listener)
			this.logger.debug('Store listener unsubscribed', {
				totalListeners: this.listeners.size,
			})
		}
	}

	public subscribeToMachine<K extends keyof T>(
		name: K,
		listener: MachineListener<T[K]>
	): () => void {
		this.assertNotDestroyed()

		const machine = this.machines.get(name)
		if (!machine) {
			throw new StateMachineError(
				`Machine "${String(name)}" is not registered`,
				'MACHINE_NOT_FOUND'
			)
		}

		return machine.subscribe(listener as (state: T[keyof T]) => void)
	}

	/*
	 *   COORDINATED OPERATIONS
	 */

	public resetAll(): void {
		this.assertNotDestroyed()

		this.logger.info('Resetting all machines')

		this.machines.forEach((machine, name) => {
			try {
				machine.reset()
				this.logger.debug('Machine reset', { name })
			} catch (error) {
				this.logger.error('Failed to reset machine', { name, error })
			}
		})
	}

	public async forceSaveAll(): Promise<void> {
		this.assertNotDestroyed()

		this.logger.info('Force saving all machines')

		const promises: Promise<void>[] = []

		this.machines.forEach((machine, name) => {
			promises.push(
				machine.forceSave().catch(error => {
					this.logger.error('Failed to force save machine', { name, error })
				})
			)
		})

		await Promise.all(promises)
	}

	public hasUnsavedChanges(): boolean {
		for (const machine of this.machines.values()) {
			if (machine.hasUnsavedChanges()) {
				return true
			}
		}
		return false
	}

	public clearAllHistory(): void {
		this.assertNotDestroyed()

		this.logger.info('Clearing history on all machines')

		this.machines.forEach((machine, name) => {
			try {
				machine.clearHistory()
				this.logger.debug('Machine history cleared', { name })
			} catch (error) {
				this.logger.error('Failed to clear machine history', { name, error })
			}
		})
	}

	public destroyAll(): void {
		if (this.isDestroyed) {
			return
		}

		this.logger.info('Destroying all machines and store')

		// Unsubscribe from all machines first
		this.machineUnsubscribers.forEach(unsubscribe => {
			unsubscribe()
		})
		this.machineUnsubscribers.clear()

		// Destroy all machines
		this.machines.forEach((machine, name) => {
			try {
				machine.destroy()
				this.logger.debug('Machine destroyed', { name })
			} catch (error) {
				this.logger.error('Failed to destroy machine', { name, error })
			}
		})

		// Clear store state
		this.machines.clear()
		this.listeners.clear()
		this.isDestroyed = true

		this.logger.info('StateRegistry destroyed')
	}

	/*
	 *   PRIVATE METHODS
	 */

	private assertNotDestroyed(): void {
		if (this.isDestroyed) {
			throw new StateMachineError('Cannot operate on destroyed StateRegistry', 'DESTROYED')
		}
	}

	private notifyListeners(): void {
		if (this.listeners.size === 0) {
			return
		}

		const combinedState = this.getState()

		this.listeners.forEach(listener => {
			try {
				listener(combinedState)
			} catch (error) {
				this.logger.error('Listener notification failed', error)
			}
		})
	}
}
