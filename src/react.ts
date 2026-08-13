/*
 *   IMPORTS
 ***************************************************************************************************/
import {
	createContext,
	createElement,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
	type ReactElement,
	type ReactNode,
} from 'react'
import { useSyncExternalStoreWithSelector } from 'use-sync-external-store/shim/with-selector'
import type { Draft } from 'immer'
import type { Machine } from './core'
import type { MachineMap, Registry, RegistryState } from './registry'
import type { HistoryApi } from './plugins/history'
import type { PersistApi } from './plugins/persist'
import type { AutosaveApi } from './plugins/autosave'

/*
 *   CORE HOOKS
 ***************************************************************************************************/
export function useMachine<T extends object>(machine: Machine<T>) {
	const subscribe = useCallback(
		(onStoreChange: () => void) => machine.subscribe(onStoreChange),
		[machine]
	)

	const getSnapshot = useCallback(() => machine.getState(), [machine])
	const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

	const mutate = useCallback(
		(recipe: (draft: Draft<T>) => void, description?: string) => {
			machine.mutate(recipe, description)
		},
		[machine]
	)

	const batch = useCallback(
		(mutations: Array<(draft: Draft<T>) => void>, description?: string) => {
			machine.batch(mutations, description)
		},
		[machine]
	)

	return { state, mutate, batch }
}

export function useSlice<T extends object, TSelected>(
	machine: Machine<T>,
	selector: (state: T) => TSelected,
	equalityFn: (a: TSelected, b: TSelected) => boolean = Object.is
) {
	const subscribe = useCallback(
		(onStoreChange: () => void) => machine.subscribe(onStoreChange),
		[machine]
	)

	const getSnapshot = useCallback(() => machine.getState(), [machine])

	return useSyncExternalStoreWithSelector(
		subscribe,
		getSnapshot,
		getSnapshot,
		selector,
		equalityFn
	)
}

export function useSubscription<T extends object>(
	machine: Machine<T>,
	callback: (state: T) => void
) {
	const callbackRef = useRef(callback)

	useEffect(() => {
		callbackRef.current = callback
	}, [callback])

	useEffect(() => {
		return machine.subscribe(state => callbackRef.current(state))
	}, [machine])
}

/*
 *   REGISTRY HOOKS
 ***************************************************************************************************/
export function useRegistry<M extends MachineMap>(registry: Registry<M>) {
	const subscribe = useCallback(
		(onStoreChange: () => void) => registry.subscribe(onStoreChange),
		[registry]
	)
	const getSnapshot = useCallback(() => registry.getState(), [registry])

	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useRegistrySlice<M extends MachineMap, TSelected>(
	registry: Registry<M>,
	selector: (state: RegistryState<M>) => TSelected,
	equalityFn: (a: TSelected, b: TSelected) => boolean = Object.is
) {
	const subscribe = useCallback(
		(onStoreChange: () => void) => registry.subscribe(onStoreChange),
		[registry]
	)

	const getSnapshot = useCallback(() => registry.getState(), [registry])

	return useSyncExternalStoreWithSelector(
		subscribe,
		getSnapshot,
		getSnapshot,
		selector,
		equalityFn
	)
}

/*
 *   SCOPED MACHINES
 ***************************************************************************************************/
// A module-level machine is shared by every concurrent request on a server.
// A scope builds one machine per render tree instead.

/** Read structurally, so plugin-wrapped machines still match. */
type ScopedState<M> = M extends { getState(): infer T } ? T : never

interface SeedableMachine {
	set(partial: object, description?: string): void
}

export interface MachineScopeProviderProps<T> {
	state?: Partial<T>
	children?: ReactNode
}

export interface MachineScope<M> {
	Provider: (props: MachineScopeProviderProps<ScopedState<M>>) => ReactElement
	useScopedMachine: () => M
}

function isSeedable(value: unknown): value is SeedableMachine {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as SeedableMachine).set === 'function'
	)
}

function seedMachine(machine: unknown, state: object | undefined): void {
	if (state === undefined || !isSeedable(machine)) {
		return
	}

	machine.set(state, 'scope seed')
}

/** By value, so a re-render that rebuilds an equal object does not re-seed. */
function sameSeed(a: object | undefined, b: object | undefined): boolean {
	if (a === b) {
		return true
	}

	if (a === undefined || b === undefined) {
		return false
	}

	const keys = Object.keys(a)
	if (keys.length !== Object.keys(b).length) {
		return false
	}

	return keys.every(
		key =>
			key in b &&
			Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
	)
}

export function createMachineScope<M>(factory: () => M, name = 'Machine'): MachineScope<M> {
	const ScopeContext = createContext<M | null>(null)
	ScopeContext.displayName = `${name}Scope`

	function Provider({ state, children }: MachineScopeProviderProps<ScopedState<M>>) {
		// Seeded in the initializer so the first render never sees an empty store.
		const [machine] = useState(() => {
			const created = factory()
			seedMachine(created, state)
			return created
		})

		const lastSeed = useRef(state)

		useEffect(() => {
			if (sameSeed(lastSeed.current, state)) {
				return
			}

			lastSeed.current = state
			seedMachine(machine, state)
		}, [machine, state])

		return createElement(ScopeContext.Provider, { value: machine }, children)
	}

	Provider.displayName = `${name}ScopeProvider`

	function useScopedMachine(): M {
		const machine = useContext(ScopeContext)

		if (machine === null) {
			throw new Error(
				`[Clutch] The ${name} scope was read outside its Provider. Render the Provider returned by createMachineScope above this component.`
			)
		}

		return machine
	}

	return { Provider, useScopedMachine }
}

/*
 *   PLUGIN HOOKS
 ***************************************************************************************************/
// These require the matching plugin's API on the machine type, so calling
// them against a machine without that plugin is a compile error

export function useMachineHistory<T extends object>(machine: Machine<T> & HistoryApi) {
	const subscribe = useCallback(
		(onStoreChange: () => void) => machine.subscribe(onStoreChange),
		[machine]
	)

	const getSnapshot = useCallback(() => machine.getHistoryInfo(), [machine])
	const historyInfo = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

	const undo = useCallback(() => machine.undo(), [machine])
	const redo = useCallback(() => machine.redo(), [machine])
	const clearHistory = useCallback(() => machine.clearHistory(), [machine])

	return { ...historyInfo, undo, redo, clearHistory }
}

export function useHydration<T extends object>(machine: Machine<T> & PersistApi) {
	const subscribe = useCallback(
		(onStoreChange: () => void) => machine.subscribe(onStoreChange),
		[machine]
	)

	const getSnapshot = useCallback(() => machine.isHydrated(), [machine])
	const isHydrated = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

	useEffect(() => {
		machine.hydrate()
	}, [machine])

	return { isHydrated }
}

export function useAutosave<T extends object>(machine: Machine<T> & AutosaveApi) {
	const [isSaving, setIsSaving] = useState(false)
	const [isLoading, setIsLoading] = useState(false)
	const [lastSaved, setLastSaved] = useState<Date | null>(null)
	const [saveError, setSaveError] = useState<string | null>(null)
	const [loadError, setLoadError] = useState<string | null>(null)
	const subscribe = useCallback(
		(onStoreChange: () => void) => machine.subscribe(onStoreChange),
		[machine]
	)

	const getSnapshot = useCallback(() => machine.hasUnsavedChanges(), [machine])
	const hasUnsavedChanges = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

	const save = useCallback(async () => {
		if (isSaving) {
			return false
		}

		setIsSaving(true)
		setSaveError(null)

		try {
			await machine.forceSave()
			setLastSaved(new Date())
			return true
		} catch (error) {
			setSaveError(error instanceof Error ? error.message : 'Save failed')
			return false
		} finally {
			setIsSaving(false)
		}
	}, [machine, isSaving])

	const load = useCallback(async () => {
		if (isLoading) {
			return false
		}

		setIsLoading(true)
		setLoadError(null)

		try {
			const success = await machine.loadFromServer()
			if (success) {
				setLastSaved(new Date())
			}
			return success
		} catch (error) {
			setLoadError(error instanceof Error ? error.message : 'Load failed')
			return false
		} finally {
			setIsLoading(false)
		}
	}, [machine, isLoading])

	const clearSaveError = useCallback(() => setSaveError(null), [])
	const clearLoadError = useCallback(() => setLoadError(null), [])

	return {
		isSaving,
		isLoading,
		hasUnsavedChanges,
		lastSaved,
		saveError,
		loadError,
		save,
		load,
		clearSaveError,
		clearLoadError,
	}
}
