/*
 *   IMPORTS
 ***************************************************************************************************/
import { produce, enablePatches, applyPatches, type Patch, type Draft } from 'immer'

enablePatches()

/*
 *   ERROR TYPES
 ***************************************************************************************************/
export class MachineError extends Error {
	public readonly code: string

	constructor(message: string, code: string) {
		super(message)
		this.name = 'MachineError'
		this.code = code
	}
}

/*
 *   TYPES
 ***************************************************************************************************/
export type CommitOperation = 'mutate' | 'batch'

export interface CommitPayload<T> {
	state: T
	patches: Patch[]
	inversePatches: Patch[]
	description: string | undefined
	operation: CommitOperation
	timestamp: number
}

export interface ExternalStateMeta {
	source: string
	patches?: Patch[]
	description?: string
}

export interface PluginContext<T extends object> {
	getState(): T
	/**
	 * Replaces state from outside the normal mutation path, e.g. a remote
	 * update, hydration, or time travel. Subscribers are notified and every
	 * plugin except the one named in `meta.source` gets `onExternalState`.
	 */
	replaceState(state: T, meta: ExternalStateMeta): void
	applyPatches(patches: Patch[], meta: Omit<ExternalStateMeta, 'patches'>): void
	subscribe(listener: (state: T) => void): () => void
	emitError(error: Error, operation: string): void
}

export type EmptyExtension = Record<never, never>

export interface Plugin<T extends object, Ext extends object = EmptyExtension> {
	name: string
	/** Whatever this returns gets merged onto the machine by `.with()` and shows up in its type. */
	onInit?(ctx: PluginContext<T>): Ext | void
	/** Throw here to veto the commit before any state is applied. */
	onBeforeCommit?(payload: CommitPayload<T>): void
	onCommit?(payload: CommitPayload<T>): void
	onExternalState?(state: T, meta: ExternalStateMeta): void
	onError?(error: Error, operation: string): void
	onDestroy?(finalState: T): void
}

export interface MachineConfig<T extends object> {
	initialState: T
}

const toError = (value: unknown): Error =>
	value instanceof Error ? value : new Error(String(value))

/*
 *   MACHINE
 ***************************************************************************************************/
export class Machine<T extends object> {
	private state: T
	private listeners: Set<(state: T) => void> = new Set()
	private plugins: Plugin<T, object>[] = []
	private isDestroyed = false
	private readonly ctx: PluginContext<T>

	constructor(config: MachineConfig<T>) {
		if (
			!config.initialState ||
			typeof config.initialState !== 'object' ||
			config.initialState === null
		) {
			throw new MachineError('Initial state must be an object', 'VALIDATION_ERROR')
		}

		this.state = config.initialState

		this.ctx = {
			getState: () => this.getState(),
			replaceState: (state, meta) => this.applyExternalState(state, meta),
			applyPatches: (patches, meta) => {
				const next = applyPatches(this.state, patches) as T
				this.applyExternalState(next, { ...meta, patches })
			},
			subscribe: listener => this.subscribe(listener),
			emitError: (error, operation) => this.emitError(error, operation),
		}
	}

	/*
	 * PLUGIN INSTALLATION
	 */
	public with<Ext extends object>(plugin: Plugin<T, Ext>): this & Ext {
		this.assertNotDestroyed()

		if (this.plugins.some(installed => installed.name === plugin.name)) {
			throw new MachineError(
				`Plugin "${plugin.name}" is already installed`,
				'DUPLICATE_PLUGIN'
			)
		}

		this.plugins.push(plugin as Plugin<T, object>)

		const extension = plugin.onInit?.(this.ctx)
		if (extension) {
			for (const key of Object.keys(extension)) {
				if (key in this) {
					throw new MachineError(
						`Plugin "${plugin.name}" extension "${key}" collides with an existing member`,
						'EXTENSION_COLLISION'
					)
				}
			}
			Object.assign(this, extension)
		}

		return this as this & Ext
	}

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
			throw new MachineError('Listener must be a function', 'VALIDATION_ERROR')
		}

		this.listeners.add(listener)

		return () => {
			this.listeners.delete(listener)
		}
	}

	public mutate(recipe: (draft: Draft<T>) => void, description?: string): void {
		this.assertNotDestroyed()

		if (typeof recipe !== 'function') {
			throw new MachineError('Recipe must be a function', 'VALIDATION_ERROR')
		}

		let patches: Patch[] = []
		let inversePatches: Patch[] = []

		const nextState = produce(this.state, recipe, (p, ip) => {
			patches = p
			inversePatches = ip
		})

		if (patches.length === 0) {
			return
		}

		this.commit(nextState, patches, inversePatches, description, 'mutate')
	}

	public batch(mutations: Array<(draft: Draft<T>) => void>, description?: string): void {
		this.assertNotDestroyed()

		if (!Array.isArray(mutations)) {
			throw new MachineError('Mutations must be an array', 'VALIDATION_ERROR')
		}

		if (mutations.length === 0) {
			return
		}

		const allPatches: Patch[] = []
		const allInversePatches: Patch[] = []

		const finalState = mutations.reduce((currentState, recipe, index) => {
			if (typeof recipe !== 'function') {
				throw new MachineError(
					`Mutation at index ${index} must be a function`,
					'VALIDATION_ERROR'
				)
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

		if (allPatches.length === 0) {
			return
		}

		this.commit(finalState, allPatches, allInversePatches, description, 'batch')
	}

	/*
	 * CLEANUP
	 */
	public destroy(): void {
		if (this.isDestroyed) {
			return
		}

		const finalState = this.state

		// Tear down in reverse install order since later plugins may depend on earlier ones
		for (let i = this.plugins.length - 1; i >= 0; i--) {
			try {
				this.plugins[i]?.onDestroy?.(finalState)
			} catch (error) {
				this.emitError(toError(error), `plugin:${this.plugins[i]?.name}:onDestroy`)
			}
		}

		this.isDestroyed = true
		this.listeners.clear()
		this.plugins = []
	}

	/*
	 *   PRIVATE METHODS
	 ***************************************************************************************************/
	private assertNotDestroyed(): void {
		if (this.isDestroyed) {
			throw new MachineError('Cannot operate on destroyed Machine', 'DESTROYED')
		}
	}

	private commit(
		nextState: T,
		patches: Patch[],
		inversePatches: Patch[],
		description: string | undefined,
		operation: CommitOperation
	): void {
		const payload: CommitPayload<T> = {
			state: nextState,
			patches,
			inversePatches,
			description,
			operation,
			timestamp: Date.now(),
		}

		for (const plugin of this.plugins) {
			plugin.onBeforeCommit?.(payload)
		}

		this.state = nextState
		this.notifyListeners()

		for (const plugin of this.plugins) {
			try {
				plugin.onCommit?.(payload)
			} catch (error) {
				this.emitError(toError(error), `plugin:${plugin.name}:onCommit`)
			}
		}
	}

	private applyExternalState(nextState: T, meta: ExternalStateMeta): void {
		this.assertNotDestroyed()

		this.state = nextState
		this.notifyListeners()

		for (const plugin of this.plugins) {
			if (plugin.name === meta.source) {
				continue
			}

			try {
				plugin.onExternalState?.(nextState, meta)
			} catch (error) {
				this.emitError(toError(error), `plugin:${plugin.name}:onExternalState`)
			}
		}
	}

	private notifyListeners(): void {
		this.listeners.forEach(listener => {
			try {
				listener(this.state)
			} catch (error) {
				this.emitError(toError(error), 'notify')
			}
		})
	}

	private emitError(error: Error, operation: string): void {
		let handled = false

		for (const plugin of this.plugins) {
			if (plugin.onError) {
				handled = true
				try {
					plugin.onError(error, operation)
				} catch {
					// A throwing error handler should not take down the rest
				}
			}
		}

		if (!handled) {
			// eslint-disable-next-line no-console
			console.error(`[Machine] Unhandled plugin error during ${operation}`, error)
		}
	}
}

/*
 *   FACTORY
 ***************************************************************************************************/
export function createMachine<T extends object>(config: MachineConfig<T>): Machine<T> {
	return new Machine(config)
}
