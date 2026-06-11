/*
 *   V3 PLUGIN CORE (PREVIEW)
 ***************************************************************************************************/
export { Machine, createMachine, MachineError } from './core'

export type {
	MachineConfig,
	Plugin,
	PluginContext,
	CommitPayload,
	CommitOperation,
	ExternalStateMeta,
	EmptyExtension,
} from './core'

/*
 *   PLUGINS
 ***************************************************************************************************/
export { history } from './plugins/history'
export { persist } from './plugins/persist'
export { devtools } from './plugins/devtools'
export { sync } from './plugins/sync'
export { validate } from './plugins/validate'
export { autosave } from './plugins/autosave'

export type { HistoryApi, HistoryConfig, HistoryInfo, HistorySnapshot } from './plugins/history'

export type {
	PersistApi,
	PersistConfig,
	PersistFilter,
	PersistStorage,
	PersistedEnvelope,
} from './plugins/persist'

export type { DevtoolsConfig } from './plugins/devtools'
export type { SyncApi, SyncPluginConfig } from './plugins/sync'
export type { StateValidator } from './plugins/validate'
export type { AutosaveApi, AutosaveConfig } from './plugins/autosave'
export type { SyncTransport, TransportStatus } from '../transports/types'

export type { Draft, Patch } from 'immer'
