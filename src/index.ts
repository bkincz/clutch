/*
 *   CORE EXPORTS
 ***************************************************************************************************/
export {
	StateMachine,
	StateMachineError,
	StateValidationError,
	StatePersistenceError,
} from './machine'

export { DevToolsConnector } from './devtools'
export { StateSyncManager } from './sync'

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
	useLifecycleEvent,
} from './hooks'

/*
 *   TYPE EXPORTS
 ***************************************************************************************************/
export type {
	StateConfig,
	StateSnapshot,
	PersistedState,
	StateHistoryInfo,
	LifecycleEvent,
	MutationOperation,
	AfterMutatePayload,
	ErrorPayload,
	DestroyPayload,
	LifecyclePayloadMap,
	LifecycleListener,
	Middleware,
	MiddlewareContext,
	MiddlewareNext,
	PersistenceFilter,
} from './machine'

export type { DevToolsConfig } from './devtools'
export type { SyncConfig } from './sync'

export type { Draft } from 'immer'
