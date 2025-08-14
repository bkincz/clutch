/*
 *   CORE EXPORTS
 ***************************************************************************************************/
export {
	StateMachine,
	StateMachineError,
	StateValidationError,
	StatePersistenceError,
} from './machine'

/*
 *   REACT HOOK EXPORTS
 ***************************************************************************************************/
export {
	useStateMachine,
	useStateSlice,
	useStateActions,
	useStateHistory,
	useStatePersist,
	useStateMachineFull,
	useOptimisticUpdate,
	useDebouncedStateUpdate,
	useStateSubscription,
	useShallowEqual,
	createStateMachineHooks,
} from './hooks'

/*
 *   TYPE EXPORTS
 ***************************************************************************************************/
export type { StateConfig, StateSnapshot, PersistedState, StateHistoryInfo } from './machine'

export type { Draft } from 'immer'
