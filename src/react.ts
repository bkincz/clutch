/*
 *   IMPORTS
 ***************************************************************************************************/
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
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
	const selectorRef = useRef(selector)
	const equalityFnRef = useRef(equalityFn)
	const selectedRef = useRef<TSelected | undefined>(undefined)
	const hasSelectedRef = useRef(false)

	selectorRef.current = selector
	equalityFnRef.current = equalityFn

	const subscribe = useCallback(
		(onStoreChange: () => void) => machine.subscribe(onStoreChange),
		[machine]
	)

	const getSnapshot = useCallback(() => {
		const newSelected = selectorRef.current(machine.getState())

		if (
			!hasSelectedRef.current ||
			!equalityFnRef.current(selectedRef.current as TSelected, newSelected)
		) {
			selectedRef.current = newSelected
			hasSelectedRef.current = true
		}

		return selectedRef.current as TSelected
	}, [machine])

	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useSubscription<T extends object>(
	machine: Machine<T>,
	callback: (state: T) => void
) {
	const callbackRef = useRef(callback)
	callbackRef.current = callback

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
	const selectorRef = useRef(selector)
	const equalityFnRef = useRef(equalityFn)
	const selectedRef = useRef<TSelected | undefined>(undefined)
	const hasSelectedRef = useRef(false)

	selectorRef.current = selector
	equalityFnRef.current = equalityFn

	const subscribe = useCallback(
		(onStoreChange: () => void) => registry.subscribe(onStoreChange),
		[registry]
	)

	const getSnapshot = useCallback(() => {
		const newSelected = selectorRef.current(registry.getState())

		if (
			!hasSelectedRef.current ||
			!equalityFnRef.current(selectedRef.current as TSelected, newSelected)
		) {
			selectedRef.current = newSelected
			hasSelectedRef.current = true
		}

		return selectedRef.current as TSelected
	}, [registry])

	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
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
	const [isHydrated, setIsHydrated] = useState(() => machine.isHydrated())

	useEffect(() => {
		machine.hydrate()
		setIsHydrated(machine.isHydrated())
	}, [machine])

	return { isHydrated }
}

export function useAutosave<T extends object>(machine: Machine<T> & AutosaveApi) {
	const [isSaving, setIsSaving] = useState(false)
	const [isLoading, setIsLoading] = useState(false)
	const [lastSaved, setLastSaved] = useState<Date | null>(null)
	const [saveError, setSaveError] = useState<string | null>(null)
	const [loadError, setLoadError] = useState<string | null>(null)
	const [hasUnsavedChanges, setHasUnsavedChanges] = useState(() => machine.hasUnsavedChanges())

	useEffect(() => {
		setHasUnsavedChanges(machine.hasUnsavedChanges())
		return machine.subscribe(() => setHasUnsavedChanges(machine.hasUnsavedChanges()))
	}, [machine])

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
			setHasUnsavedChanges(machine.hasUnsavedChanges())
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
			setHasUnsavedChanges(machine.hasUnsavedChanges())
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
