/*
 *   IMPORTS
 ***************************************************************************************************/
import { type DependencyList, useEffect, useState, useCallback } from 'react'
import { StateMachine, type StateHistoryInfo } from './machine'

/*
 *   TYPES
 ***************************************************************************************************/
import type { Draft } from 'immer'

/*
 *   HOOKS
 ***************************************************************************************************/

/**
 * Basic hook to subscribe to a StateMachine instance
 */
export function useStateMachine<T extends object>(engine: StateMachine<T>) {
	const [state, setState] = useState(() => engine.getState())

	useEffect(() => {
		const unsubscribe = engine.subscribe(setState)
		return unsubscribe
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

/**
 * Hook to subscribe to a specific slice of state with a selector function
 */
export function useStateSlice<T extends object, TSelected>(
	engine: StateMachine<T>,
	selector: (state: T) => TSelected,
	equalityFn?: (a: TSelected, b: TSelected) => boolean
) {
	const [selectedState, setSelectedState] = useState(() => selector(engine.getState()))

	useEffect(() => {
		const unsubscribe = engine.subscribe(newState => {
			const newSelected = selector(newState)

			if (equalityFn) {
				if (!equalityFn(selectedState, newSelected)) {
					setSelectedState(newSelected)
				}
			} else if (selectedState !== newSelected) {
				setSelectedState(newSelected)
			}
		})

		return unsubscribe
	}, [engine, selector, selectedState, equalityFn])

	return selectedState
}

/**
 * Hook that provides StateMachine actions/methods
 */
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

/**
 * Hook specifically for undo/redo functionality
 */
export function useStateHistory<T extends object>(engine: StateMachine<T>) {
	const [historyInfo, setHistoryInfo] = useState<StateHistoryInfo>(() => engine.getHistoryInfo())

	useEffect(() => {
		const updateHistory = () => {
			setHistoryInfo(engine.getHistoryInfo())
		}

		const unsubscribe = engine.subscribe(updateHistory)
		return unsubscribe
	}, [engine])

	const undo = useCallback(() => {
		const success = engine.undo()
		if (success) {
			setHistoryInfo(engine.getHistoryInfo())
		}
		return success
	}, [engine])

	const redo = useCallback(() => {
		const success = engine.redo()
		if (success) {
			setHistoryInfo(engine.getHistoryInfo())
		}
		return success
	}, [engine])

	const clearHistory = useCallback(() => {
		engine.clearHistory()
		setHistoryInfo(engine.getHistoryInfo())
	}, [engine])

	return {
		...historyInfo,
		undo,
		redo,
		clearHistory,
	}
}

/**
 * Hook for managing save/load state and persistence
 */
export function useStatePersist<T extends object>(engine: StateMachine<T>) {
	const [isSaving, setIsSaving] = useState(false)
	const [isLoading, setIsLoading] = useState(false)
	const [lastSaved, setLastSaved] = useState<Date | null>(null)
	const [saveError, setSaveError] = useState<string | null>(null)
	const [loadError, setLoadError] = useState<string | null>(null)

	const hasUnsavedChanges = engine.hasUnsavedChanges()

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

/**
 * Comprehensive hook that combines all StateMachine functionality
 */
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
			memoryUsage: history.memoryUsage,
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

/**
 * Hook for creating optimistic updates with automatic rollback on failure
 * -- Still testing this, I'm not sure if this is a good solution.
 */
export function useOptimisticUpdate<T extends object>(engine: StateMachine<T>) {
	const mutateOptimistic = useCallback(
		async (
			optimisticUpdate: (draft: Draft<T>) => void,
			serverUpdate: () => Promise<void>,
			description?: string
		) => {
			// Apply optimistic update
			engine.mutate(optimisticUpdate, `${description} (optimistic)`)

			try {
				// Attempt server update
				await serverUpdate()
				// If successful, the optimistic update stands
			} catch (error) {
				// If failed, undo the optimistic update
				engine.undo()
				throw error
			}
		},
		[engine]
	)

	return { mutateOptimistic }
}

/**
 * Hook for debounced state updates (useful for search inputs, etc.)
 */
export function useDebouncedStateUpdate<T extends object>(engine: StateMachine<T>, delay = 300) {
	const [debouncedMutate] = useState(() => {
		let timeoutId: ReturnType<typeof setTimeout>

		return (recipe: (draft: Draft<T>) => void, description?: string) => {
			clearTimeout(timeoutId)
			timeoutId = setTimeout(() => {
				engine.mutate(recipe, description)
			}, delay)
		}
	})

	useEffect(() => {
		return () => {
			clearTimeout(debouncedMutate as unknown as ReturnType<typeof setTimeout>)
		}
	}, [debouncedMutate])

	return { debouncedMutate }
}

/**
 * Hook for subscribing to state changes with cleanup on component unmount
 */
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

/**
 * Utility hook for shallow equality comparison
 */
export function useShallowEqual<T>(value: T): T {
	const [state, setState] = useState(value)

	useEffect(() => {
		if (typeof value === 'object' && value !== null) {
			const keys1 = Object.keys(state as Record<string, unknown>)
			const keys2 = Object.keys(value as Record<string, unknown>)

			if (keys1.length !== keys2.length) {
				setState(value)
				return
			}

			for (const key of keys1) {
				if ((state as Record<string, unknown>)[key] !== (value as Record<string, unknown>)[key]) {
					setState(value)
					return
				}
			}
		} else if (state !== value) {
			setState(value)
		}
	}, [value, state])

	return state
}

/**
 * Factory function to create typed hooks for a specific StateMachine
 */
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
	}
}
