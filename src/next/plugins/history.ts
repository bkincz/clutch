/*
 *   IMPORTS
 ***************************************************************************************************/
import type { Patch } from 'immer'
import {
	MachineError,
	type Plugin,
	type PluginContext,
	type ExternalStateMeta,
} from '../core'

/*
 *   TYPES
 ***************************************************************************************************/
export interface HistorySnapshot {
	patches: Patch[]
	inversePatches: Patch[]
	timestamp: number
	description?: string
}

export interface HistoryInfo {
	canUndo: boolean
	canRedo: boolean
	historyLength: number
	currentIndex: number
	lastAction: string | null
}

export interface HistoryApi {
	undo(): boolean
	redo(): boolean
	canUndo(): boolean
	canRedo(): boolean
	getHistoryInfo(): HistoryInfo
	clearHistory(): void
}

export interface HistoryConfig {
	maxSize?: number
}

const HISTORY_SOURCE = 'history'
const DEFAULT_MAX_SIZE = 50

/*
 *   PLUGIN
 ***************************************************************************************************/
export function history<T extends object>(config: HistoryConfig = {}): Plugin<T, HistoryApi> {
	const maxSize = config.maxSize ?? DEFAULT_MAX_SIZE

	if (maxSize <= 0) {
		throw new MachineError('History maxSize must be positive', 'VALIDATION_ERROR')
	}

	let ctx: PluginContext<T> | null = null
	let snapshots: HistorySnapshot[] = []
	let index = -1
	let infoCache: HistoryInfo | null = null

	const reset = (): void => {
		snapshots = []
		index = -1
		infoCache = null
	}

	const canUndo = (): boolean => index >= 0
	const canRedo = (): boolean => index < snapshots.length - 1

	const undo = (): boolean => {
		if (!ctx || !canUndo()) {
			return false
		}

		const snapshot = snapshots[index]
		if (!snapshot) {
			return false
		}

		try {
			const meta: Omit<ExternalStateMeta, 'patches'> = { source: HISTORY_SOURCE }
			if (snapshot.description) {
				meta.description = snapshot.description
			}
			ctx.applyPatches(snapshot.inversePatches, meta)
			index--
			infoCache = null
			return true
		} catch (error) {
			ctx.emitError(error instanceof Error ? error : new Error(String(error)), 'undo')
			return false
		}
	}

	const redo = (): boolean => {
		if (!ctx || !canRedo()) {
			return false
		}

		const snapshot = snapshots[index + 1]
		if (!snapshot) {
			return false
		}

		try {
			const meta: Omit<ExternalStateMeta, 'patches'> = { source: HISTORY_SOURCE }
			if (snapshot.description) {
				meta.description = snapshot.description
			}
			ctx.applyPatches(snapshot.patches, meta)
			index++
			infoCache = null
			return true
		} catch (error) {
			ctx.emitError(error instanceof Error ? error : new Error(String(error)), 'redo')
			return false
		}
	}

	const getHistoryInfo = (): HistoryInfo => {
		// Keep referentially stable between history changes, since
		// useSyncExternalStore compares snapshots with Object.is
		if (!infoCache) {
			infoCache = {
				canUndo: canUndo(),
				canRedo: canRedo(),
				historyLength: snapshots.length,
				currentIndex: index,
				lastAction: snapshots[index]?.description ?? null,
			}
		}
		return infoCache
	}

	return {
		name: HISTORY_SOURCE,

		onInit(context) {
			ctx = context
			return {
				undo,
				redo,
				canUndo,
				canRedo,
				getHistoryInfo,
				clearHistory: reset,
			}
		},

		onCommit(payload) {
			if (index < snapshots.length - 1) {
				snapshots = snapshots.slice(0, index + 1)
			}

			const snapshot: HistorySnapshot = {
				patches: payload.patches,
				inversePatches: payload.inversePatches,
				timestamp: payload.timestamp,
			}

			if (payload.description) {
				snapshot.description = payload.description
			}

			snapshots.push(snapshot)
			index++

			if (snapshots.length > maxSize) {
				snapshots.shift()
				index--
			}

			infoCache = null
		},

		onExternalState(_state, meta) {
			// A full-state replacement (time travel, hydration) makes our patches
			// stale, so drop them. Patch-level updates like sync keep history usable.
			if (!meta.patches) {
				reset()
			}
		},

		onDestroy() {
			reset()
			ctx = null
		},
	}
}
