/*
 *   CORE EXPORTS
 ***************************************************************************************************/
export {
	StateMachine,
	createStateMachine,
	StateMachineError,
	StateValidationError,
	StatePersistenceError,
} from './machine'

export { DevToolsConnector } from './devtools'
export { StateSyncManager } from './sync'
export { StateRegistry } from './store'
export { BroadcastChannelTransport } from './transports/broadcast-channel'

// React hooks live in '@bkincz/clutch/react'. The main entry must stay React-free.

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
export type { SyncTransport, TransportStatus } from './transports/types'
export type { BroadcastChannelTransportConfig } from './transports/broadcast-channel'
export type {
	RegistryConfig,
	MachineStates,
	MachineRegistry,
	CombinedState,
	RegistryListener,
	MachineListener,
} from './store'

export type { Draft } from 'immer'
