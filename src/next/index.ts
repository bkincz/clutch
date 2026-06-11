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

export type {
	HistoryApi,
	HistoryConfig,
	HistoryInfo,
	HistorySnapshot,
} from './plugins/history'

export type {
	PersistApi,
	PersistConfig,
	PersistFilter,
	PersistStorage,
	PersistedEnvelope,
} from './plugins/persist'

export type { Draft, Patch } from 'immer'
