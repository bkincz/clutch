/*
 *   IMPORTS
 ***************************************************************************************************/
import { StateSyncManager, type SyncConfig } from '../sync'
import type { Plugin, PluginContext, ExternalStateMeta } from '../core'

/*
 *   TYPES
 ***************************************************************************************************/
export interface SyncPluginConfig extends SyncConfig {
	autoStart?: boolean
}

export interface SyncApi {
	startSync(): void
}

const SYNC_SOURCE = 'sync'

/*
 *   PLUGIN
 ***************************************************************************************************/
export function sync<T extends object>(config: SyncPluginConfig = {}): Plugin<T, SyncApi> {
	let ctx: PluginContext<T> | null = null
	let manager: StateSyncManager<T> | null = null

	const startSync = (): void => {
		if (!ctx || manager) {
			return
		}

		manager = new StateSyncManager<T>(
			config,
			() => (ctx as PluginContext<T>).getState(),
			(state, patches) => {
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
