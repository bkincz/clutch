/*
 *   IMPORTS
 ***************************************************************************************************/
import { DevToolsConnector, type DevToolsConfig } from '../../devtools'
import type { Plugin } from '../core'

/*
 *   TYPES
 ***************************************************************************************************/
export type DevtoolsConfig = DevToolsConfig

const DEVTOOLS_SOURCE = 'devtools'
const DEFAULT_NAME = 'Machine'

/*
 *   PLUGIN
 ***************************************************************************************************/
export function devtools<T extends object>(config: DevtoolsConfig = {}): Plugin<T> {
	let connector: DevToolsConnector<T> | null = null

	return {
		name: DEVTOOLS_SOURCE,

		onInit(ctx) {
			connector = new DevToolsConnector<T>(config.name ?? DEFAULT_NAME, config, state =>
				ctx.replaceState(state, {
					source: DEVTOOLS_SOURCE,
					description: 'DevTools time-travel',
				})
			)

			connector.init(ctx.getState())
		},

		onCommit(payload) {
			connector?.send(
				payload.description ?? payload.operation,
				payload.state,
				payload.patches
			)
		},

		// Undo/redo, hydration and sync all land here. The core skips our own
		// source, so time travel never echoes back to the extension.
		onExternalState(state, meta) {
			connector?.send(meta.description ?? `external:${meta.source}`, state, meta.patches)
		},

		onDestroy() {
			connector?.disconnect()
			connector = null
		},
	}
}
