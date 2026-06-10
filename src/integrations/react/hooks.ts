/*
 *   IMPORTS
 ***************************************************************************************************/
import {
	type DependencyList,
	useEffect,
	useState,
	useCallback,
	useRef,
	useSyncExternalStore,
} from 'react'
import { StateMachine, type LifecycleEvent, type LifecyclePayloadMap } from '../../machine'
import { StateRegistry, type CombinedState, type MachineStates } from '../../store'

/*
 *   TYPES
 ***************************************************************************************************/
import type { Patch, Draft } from 'immer'

/*
 *   HOOKS
 ***************************************************************************************************/

export function useStateMachine<T extends object>(engine: StateMachine<T>) {
	const subscribe = useCallback(
		(onStoreChange: () => void) => {
			return engine.subscribe(onStoreChange)
		},
		[engine]
	)

	const getSnapshot = useCallback(() => engine.getState(), [engine])
	const getServerSnapshot = useCallback(() => engine.getState(), [engine])
	const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

	useEffect(() => {
		engine.hydrateFromPersisted()
	}, [engine])

	const mutate = useCallback(
		(recipe: (draft: Draft<T>) => void, description?: string) => {
			engine.mutate(recipe, description)
		},
		[engine]
	)

	const batch = useCallback(
		(mutations: Array<(draft: Draft<T>) => void>, description?: string) => {
			engine.batch(mutations, description)
		},
		[engine]
	)

	return {
		state,
		mutate,
		batch,
	}
}

export function useStateSlice<T extends object, TSelected>(
	engine: StateMachine<T>,
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
		(onStoreChange: () => void) => {
			return engine.subscribe(onStoreChange)
		},
		[engine]
	)

	// Recompute on every read so a changed selector never serves stale values,
	// and reuse the previous reference when equal so React can skip the re-render
	const getSnapshot = useCallback(() => {
		const newSelected = selectorRef.current(engine.getState())

		if (
			!hasSelectedRef.current ||
			!equalityFnRef.current(selectedRef.current as TSelected, newSelected)
		) {
			selectedRef.current = newSelected
			hasSelectedRef.current = true
		}

		return selectedRef.current as TSelected
	}, [engine])

	useEffect(() => {
		engine.hydrateFromPersisted()
	}, [engine])

	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useStateActions<T extends object>(engine: StateMachine<T>) {
	const mutate = useCallback(
		(recipe: (draft: Draft<T>) => void, description?: string) => {
			engine.mutate(recipe, description)
		},
		[engine]
	)

	const batch = useCallback(
		(mutations: Array<(draft: Draft<T>) => void>, description?: string) => {
			engine.batch(mutations, description)
		},
		[engine]
	)

	const undo = useCallback(() => {
		return engine.undo()
	}, [engine])

	const redo = useCallback(() => {
		return engine.redo()
	}, [engine])

	const forceSave = useCallback(async () => {
		return engine.forceSave()
	}, [engine])

	const loadFromServer = useCallback(async () => {
		return engine.loadFromServerManually()
	}, [engine])

	const clearHistory = useCallback(() => {
		engine.clearHistory()
	}, [engine])

	return {
		mutate,
		batch,
		undo,
		redo,
		forceSave,
		loadFromServer,
		clearHistory,
	}
}

export function useStateHistory<T extends object>(engine: StateMachine<T>) {
	const subscribe = useCallback(
		(onStoreChange: () => void) => {
			return engine.subscribe(onStoreChange)
		},
		[engine]
	)

	const getSnapshot = useCallback(() => engine.getHistoryInfo(), [engine])
	const getServerSnapshot = useCallback(() => engine.getHistoryInfo(), [engine])
	const historyInfo = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

	const undo = useCallback(() => {
		return engine.undo()
	}, [engine])

	const redo = useCallback(() => {
		return engine.redo()
	}, [engine])

	const clearHistory = useCallback(() => {
		engine.clearHistory()
	}, [engine])

	return {
		...historyInfo,
		undo,
		redo,
		clearHistory,
	}
}

export function useDeferredHydration<T extends object>(engine: StateMachine<T>) {
	const [isHydrated, setIsHydrated] = useState(() => engine.isHydrated)

	useEffect(() => {
		engine.hydrateFromPersisted()
		setIsHydrated(engine.isHydrated)
	}, [engine])

	return { isHydrated }
}

export function useStatePersist<T extends object>(engine: StateMachine<T>) {
	const [isSaving, setIsSaving] = useState(false)
	const [isLoading, setIsLoading] = useState(false)
	const [lastSaved, setLastSaved] = useState<Date | null>(null)
	const [saveError, setSaveError] = useState<string | null>(null)
	const [loadError, setLoadError] = useState<string | null>(null)
	const [hasUnsavedChanges, setHasUnsavedChanges] = useState(() => engine.hasUnsavedChanges())

	useEffect(() => {
		const updateUnsavedStatus = () => {
			setHasUnsavedChanges(engine.hasUnsavedChanges())
		}

		const unsubscribe = engine.subscribe(updateUnsavedStatus)
		return unsubscribe
	}, [engine])

	const save = useCallback(async () => {
		if (isSaving) {
			return false
		}

		setIsSaving(true)
		setSaveError(null)

		try {
			await engine.forceSave()
			setLastSaved(new Date())
			return true
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Save failed'
			setSaveError(errorMessage)
			return false
		} finally {
			setIsSaving(false)
		}
	}, [engine, isSaving])

	const load = useCallback(async () => {
		if (isLoading) {
			return false
		}

		setIsLoading(true)
		setLoadError(null)

		try {
			const success = await engine.loadFromServerManually()
			if (success) {
				setLastSaved(new Date())
			}
			return success
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Load failed'
			setLoadError(errorMessage)
			return false
		} finally {
			setIsLoading(false)
		}
	}, [engine, isLoading])

	const clearSaveError = useCallback(() => {
		setSaveError(null)
	}, [])

	const clearLoadError = useCallback(() => {
		setLoadError(null)
	}, [])

	return {
		isSaving,
		isLoading,
		hasUnsavedChanges,
		lastSaved,
		saveError,
		loadError,
		clearSaveError,
		clearLoadError,
		save,
		load,
	}
}

export function useStateMachineFull<T extends object>(engine: StateMachine<T>) {
	const { state, mutate, batch } = useStateMachine(engine)
	const actions = useStateActions(engine)
	const history = useStateHistory(engine)
	const persistence = useStatePersist(engine)

	return {
		state,
		mutate,
		batch,
		history: {
			canUndo: history.canUndo,
			canRedo: history.canRedo,
			historyLength: history.historyLength,
			currentIndex: history.currentIndex,
			lastAction: history.lastAction,
			undo: history.undo,
			redo: history.redo,
			clearHistory: history.clearHistory,
		},
		persistence: {
			isSaving: persistence.isSaving,
			isLoading: persistence.isLoading,
			hasUnsavedChanges: persistence.hasUnsavedChanges,
			lastSaved: persistence.lastSaved,
			saveError: persistence.saveError,
			loadError: persistence.loadError,
			save: persistence.save,
			load: persistence.load,
			clearSaveError: persistence.clearSaveError,
			clearLoadError: persistence.clearLoadError,
		},
		forceSave: actions.forceSave,
		loadFromServer: actions.loadFromServer,
	}
}

export function useOptimisticUpdate<T extends object>(engine: StateMachine<T>) {
	const mutateOptimistic = useCallback(
		async (
			optimisticUpdate: (draft: Draft<T>) => void,
			serverUpdate: () => Promise<void>,
			description?: string
		) => {
			// Rollback reverts exactly this change, so mutations landing in between survive
			let inversePatches: Patch[] = []
			const off = engine.on('afterMutate', payload => {
				inversePatches = payload.inversePatches
			})

			try {
				engine.mutate(optimisticUpdate, `${description} (optimistic)`)
			} finally {
				off()
			}

			try {
				await serverUpdate()
			} catch (error) {
				if (inversePatches.length > 0) {
					engine.applyPatchSet(inversePatches, `${description} (rollback)`)
				}
				throw error
			}
		},
		[engine]
	)

	return { mutateOptimistic }
}

export function useDebouncedStateUpdate<T extends object>(engine: StateMachine<T>, delay = 300) {
	const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

	const debouncedMutate = useCallback(
		(recipe: (draft: Draft<T>) => void, description?: string) => {
			if (timeoutRef.current) {
				clearTimeout(timeoutRef.current)
			}
			timeoutRef.current = setTimeout(() => {
				engine.mutate(recipe, description)
			}, delay)
		},
		[engine, delay]
	)

	useEffect(() => {
		return () => {
			if (timeoutRef.current) {
				clearTimeout(timeoutRef.current)
			}
		}
	}, [])

	return { debouncedMutate }
}

export function useStateSubscription<T extends object>(
	engine: StateMachine<T>,
	callback: (state: T) => void,
	deps: DependencyList = []
) {
	useEffect(() => {
		const unsubscribe = engine.subscribe(callback)
		return unsubscribe
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [engine, callback, ...deps])
}

export function useLifecycleEvent<T extends object, E extends LifecycleEvent>(
	engine: StateMachine<T>,
	event: E,
	listener: (payload: LifecyclePayloadMap<T>[E]) => void
) {
	const listenerRef = useRef(listener)
	listenerRef.current = listener

	useEffect(() => {
		return engine.on(event, payload => listenerRef.current(payload))
	}, [engine, event])
}

export function useShallowEqual<T>(value: T): T {
	const [state, setState] = useState(value)
	const prevValueRef = useRef(value)

	if (prevValueRef.current !== value) {
		let shouldUpdate = false

		if (
			typeof value === 'object' &&
			value !== null &&
			typeof state === 'object' &&
			state !== null
		) {
			const keys1 = Object.keys(state as Record<string, unknown>)
			const keys2 = Object.keys(value as Record<string, unknown>)

			if (keys1.length !== keys2.length) {
				shouldUpdate = true
			} else {
				for (const key of keys2) {
					if (
						(state as Record<string, unknown>)[key] !==
						(value as Record<string, unknown>)[key]
					) {
						shouldUpdate = true
						break
					}
				}
			}
		} else if (state !== value) {
			shouldUpdate = true
		}

		if (shouldUpdate) {
			setState(value)
		}

		prevValueRef.current = value
	}

	return state
}

export function createStateMachineHooks<T extends object>(engine: StateMachine<T>) {
	return {
		useState: () => useStateMachine(engine),
		useSlice: <TSelected>(
			selector: (state: T) => TSelected,
			equalityFn?: (a: TSelected, b: TSelected) => boolean
		) => useStateSlice(engine, selector, equalityFn),
		useActions: () => useStateActions(engine),
		useHistory: () => useStateHistory(engine),
		usePersistence: () => useStatePersist(engine),
		useComplete: () => useStateMachineFull(engine),
		useOptimistic: () => useOptimisticUpdate(engine),
		useDebounced: (delay?: number) => useDebouncedStateUpdate(engine, delay),
		useSubscription: (callback: (state: T) => void, deps?: DependencyList) =>
			useStateSubscription(engine, callback, deps),
		useLifecycle: <E extends LifecycleEvent>(
			event: E,
			listener: (payload: LifecyclePayloadMap<T>[E]) => void
		) => useLifecycleEvent(engine, event, listener),
	}
}

/*
 *   REGISTRY HOOKS
 ***************************************************************************************************/

export function useRegistry<T extends MachineStates>(store: StateRegistry<T>) {
	const subscribe = useCallback(
		(onStoreChange: () => void) => {
			return store.subscribe(onStoreChange)
		},
		[store]
	)

	const getSnapshot = useCallback(() => store.getState(), [store])

	const getServerSnapshot = useCallback(() => store.getState(), [store])

	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

export function useRegistrySlice<T extends MachineStates, TSelected>(
	store: StateRegistry<T>,
	selector: (state: CombinedState<T>) => TSelected,
	equalityFn: (a: TSelected, b: TSelected) => boolean = Object.is
) {
	const selectorRef = useRef(selector)
	const equalityFnRef = useRef(equalityFn)
	const selectedRef = useRef<TSelected | undefined>(undefined)
	const hasSelectedRef = useRef(false)

	selectorRef.current = selector
	equalityFnRef.current = equalityFn

	const subscribe = useCallback(
		(onStoreChange: () => void) => {
			return store.subscribe(onStoreChange)
		},
		[store]
	)

	// Same snapshot strategy as useStateSlice
	const getSnapshot = useCallback(() => {
		const newSelected = selectorRef.current(store.getState())

		if (
			!hasSelectedRef.current ||
			!equalityFnRef.current(selectedRef.current as TSelected, newSelected)
		) {
			selectedRef.current = newSelected
			hasSelectedRef.current = true
		}

		return selectedRef.current as TSelected
	}, [store])

	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useRegistryMachine<T extends MachineStates, K extends keyof T>(
	store: StateRegistry<T>,
	machineName: K
) {
	const subscribe = useCallback(
		(onStoreChange: () => void) => {
			return store.subscribeToMachine(machineName, () => {
				onStoreChange()
			})
		},
		[store, machineName]
	)

	const getSnapshot = useCallback(() => store.getMachineState(machineName), [store, machineName])

	const getServerSnapshot = useCallback(
		() => store.getMachineState(machineName),
		[store, machineName]
	)

	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

export function useRegistryActions<T extends MachineStates>(store: StateRegistry<T>) {
	const resetAll = useCallback(() => {
		store.resetAll()
	}, [store])

	const forceSaveAll = useCallback(async () => {
		return store.forceSaveAll()
	}, [store])

	const clearAllHistory = useCallback(() => {
		store.clearAllHistory()
	}, [store])

	const destroyAll = useCallback(() => {
		store.destroyAll()
	}, [store])

	const hasUnsavedChanges = useCallback(() => {
		return store.hasUnsavedChanges()
	}, [store])

	return {
		resetAll,
		forceSaveAll,
		clearAllHistory,
		destroyAll,
		hasUnsavedChanges,
	}
}

export function createRegistryHooks<T extends MachineStates>(store: StateRegistry<T>) {
	return {
		useRegistry: () => useRegistry(store),
		useSlice: <TSelected>(
			selector: (state: CombinedState<T>) => TSelected,
			equalityFn?: (a: TSelected, b: TSelected) => boolean
		) => useRegistrySlice(store, selector, equalityFn),
		useMachine: <K extends keyof T>(machineName: K) => useRegistryMachine(store, machineName),
		useActions: () => useRegistryActions(store),
	}
}
