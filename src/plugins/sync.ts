/*
 *   IMPORTS
 ***************************************************************************************************/
import { StateSyncManager, type SyncConfig } from '../sync'
import { MachineError, type Plugin, type PluginContext, type ExternalStateMeta } from '../core'
import { checkSchema, type StandardSchemaV1 } from './standard-schema'

/*
 *   TYPES
 ***************************************************************************************************/
export interface SyncPluginConfig<T extends object = object> extends SyncConfig {
	autoStart?: boolean
	schema?: StandardSchemaV1<T>
}

export interface SyncApi {
	startSync(): void
}

const SYNC_SOURCE = 'sync'

/*
 *   PLUGIN
 ***************************************************************************************************/
export function sync<T extends object>(config: SyncPluginConfig<T> = {}): Plugin<T, SyncApi> {
	let ctx: PluginContext<T> | null = null
	let manager: StateSyncManager<T> | null = null

	const rejectionOf = (state: T): string | null => {
		if (!config.schema) {
			return null
		}
		try {
			const result = checkSchema(config.schema, state)
			return result === true ? null : result
		} catch (error) {
			return error instanceof Error ? error.message : String(error)
		}
	}

	const startSync = (): void => {
		if (!ctx || manager) {
			return
		}

		manager = new StateSyncManager<T>(
			config,
			() => (ctx as PluginContext<T>).getState(),
			(state, patches) => {
				const rejection = rejectionOf(state)
				if (rejection) {
					ctx?.emitError(
						new MachineError(
							`Sync dropped a remote update that failed the schema: ${rejection}`,
							'VALIDATION_ERROR'
						),
						SYNC_SOURCE
					)
					return
				}
				const meta: ExternalStateMeta = { source: SYNC_SOURCE }
				if (patches) {
					meta.patches = patches
				}
				ctx?.replaceState(state, meta)
			}
		)
	}

	return {
		name: SYNC_SOURCE,

		onInit(context) {
			ctx = context

			if (config.autoStart ?? true) {
				startSync()
			}

			return { startSync }
		},

		onCommit(payload) {
			manager?.broadcastChange(
				payload.state,
				payload.patches,
				payload.inversePatches,
				payload.description
			)
		},

		onExternalState(state, meta) {
			if (meta.patches) {
				manager?.broadcastChange(state, meta.patches, [], meta.description)
			}
		},

		onDestroy() {
			manager?.destroy()
			manager = null
			ctx = null
		},
	}
}
