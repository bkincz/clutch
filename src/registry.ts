/*
 *   IMPORTS
 ***************************************************************************************************/
import { MachineError, type Machine } from './core'
import type { HistoryApi } from './plugins/history'
import type { PersistApi } from './plugins/persist'
import type { AutosaveApi } from './plugins/autosave'

/*
 *   TYPES
 ***************************************************************************************************/
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MachineMap = Record<string, Machine<any>>

export type RegistryState<M extends MachineMap> = {
	[K in keyof M]: M[K] extends Machine<infer S> ? S : never
}

export type RegistryListener<M extends MachineMap> = (state: RegistryState<M>) => void

/*
 *   REGISTRY
 ***************************************************************************************************/
export class Registry<M extends MachineMap> {
	// Direct typed access: registry.machines.user keeps the plugin extensions
	// that were installed on that machine
	public readonly machines: M

	private listeners: Set<RegistryListener<M>> = new Set()
	private unsubscribers: (() => void)[] = []
	private cached: RegistryState<M> | null = null
	private isDestroyed = false

	constructor(machines: M) {
		this.machines = machines

		for (const machine of Object.values(machines)) {
			this.unsubscribers.push(
				machine.subscribe(() => {
					this.cached = null
					this.notify()
				})
			)
		}
	}

	/*
	 * STATE ACCESS
	 ***************************************************************************************************/
	public getState(): RegistryState<M> {
		this.assertNotDestroyed()

		if (!this.cached) {
			const combined = {} as RegistryState<M>
			for (const key of Object.keys(this.machines) as (keyof M)[]) {
				const machine = this.machines[key]
				if (machine) {
					combined[key] = machine.getState()
				}
			}
			this.cached = combined
		}

		return this.cached
	}

	public subscribe(listener: RegistryListener<M>): () => void {
		this.assertNotDestroyed()

		if (typeof listener !== 'function') {
			throw new MachineError('Listener must be a function', 'VALIDATION_ERROR')
		}

		this.listeners.add(listener)

		return () => {
			this.listeners.delete(listener)
		}
	}

	/*
	 * COORDINATED OPERATIONS
	 ***************************************************************************************************/
	public resetAll(): void {
		this.assertNotDestroyed()

		for (const machine of Object.values(this.machines)) {
			machine.reset()
		}
	}

	public hydrateAll(): void {
		this.assertNotDestroyed()

		for (const machine of Object.values(this.machines)) {
			;(machine as Partial<PersistApi>).hydrate?.()
		}
	}

	public flushAll(): void {
		this.assertNotDestroyed()

		for (const machine of Object.values(this.machines)) {
			;(machine as Partial<PersistApi>).flush?.()
		}
	}

	public async forceSaveAll(): Promise<void> {
		this.assertNotDestroyed()

		const saves: Promise<void>[] = []

		for (const machine of Object.values(this.machines)) {
			const candidate = machine as Partial<AutosaveApi>
			if (typeof candidate.forceSave === 'function') {
				saves.push(
					candidate.forceSave().catch(() => {
						// Already reported through the machine's own onError plugins
					})
				)
			}
		}

		await Promise.all(saves)
	}

	public hasUnsavedChanges(): boolean {
		for (const machine of Object.values(this.machines)) {
			if ((machine as Partial<AutosaveApi>).hasUnsavedChanges?.()) {
				return true
			}
		}
		return false
	}

	public clearAllHistory(): void {
		this.assertNotDestroyed()

		for (const machine of Object.values(this.machines)) {
			;(machine as Partial<HistoryApi>).clearHistory?.()
		}
	}

	public destroyAll(): void {
		if (this.isDestroyed) {
			return
		}

		for (const unsubscribe of this.unsubscribers) {
			unsubscribe()
		}
		this.unsubscribers = []

		for (const machine of Object.values(this.machines)) {
			machine.destroy()
		}

		this.listeners.clear()
		this.isDestroyed = true
	}

	/*
	 *   PRIVATE METHODS
	 ***************************************************************************************************/
	private assertNotDestroyed(): void {
		if (this.isDestroyed) {
			throw new MachineError('Cannot operate on destroyed Registry', 'DESTROYED')
		}
	}

	private notify(): void {
		if (this.listeners.size === 0) {
			return
		}

		const combined = this.getState()

		this.listeners.forEach(listener => {
			try {
				listener(combined)
			} catch {
				// One broken listener should not stop the others
			}
		})
	}
}

/*
 *   FACTORY
 ***************************************************************************************************/
export function createRegistry<M extends MachineMap>(machines: M): Registry<M> {
	return new Registry(machines)
}
