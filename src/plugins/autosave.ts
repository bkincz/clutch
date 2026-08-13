/*
 *   IMPORTS
 ***************************************************************************************************/
import { MachineError, type Plugin, type PluginContext } from '../core'

/*
 *   TYPES
 ***************************************************************************************************/
export interface AutosaveConfig<T> {
	save: (state: T) => void | Promise<void>
	load?: () => T | null | Promise<T | null>
	intervalMs?: number
	auto?: boolean
}

export interface AutosaveApi {
	forceSave(): Promise<void>
	hasUnsavedChanges(): boolean
	setAutoSaveInterval(ms: number): void
	loadFromServer(): Promise<boolean>
}

const AUTOSAVE_SOURCE = 'autosave'
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000

const toError = (value: unknown): Error =>
	value instanceof Error ? value : new Error(String(value))

/*
 *   PLUGIN
 ***************************************************************************************************/
export function autosave<T extends object>(config: AutosaveConfig<T>): Plugin<T, AutosaveApi> {
	if (typeof config.save !== 'function') {
		throw new MachineError('Autosave requires a save function', 'VALIDATION_ERROR')
	}

	let intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS
	if (intervalMs <= 0) {
		throw new MachineError('Auto-save interval must be a positive number', 'VALIDATION_ERROR')
	}

	let ctx: PluginContext<T> | null = null
	let dirty = false
	let timer: ReturnType<typeof setInterval> | null = null
	let destroyed = false

	const forceSave = async (): Promise<void> => {
		if (!ctx || !dirty) {
			return
		}

		try {
			await config.save(ctx.getState())
			dirty = false
			ctx.notify()
		} catch (error) {
			const saveError = new MachineError(
				`Force save failed: ${toError(error).message}`,
				'PERSISTENCE_ERROR'
			)
			ctx.emitError(saveError, 'persist')
			throw saveError
		}
	}

	const stopTimer = (): void => {
		if (timer) {
			clearInterval(timer)
			timer = null
		}
	}

	const startTimer = (): void => {
		if (typeof window === 'undefined' || destroyed || !(config.auto ?? true)) {
			return
		}

		timer = setInterval(() => {
			if (dirty) {
				// Failures are already reported through emitError inside forceSave
				forceSave().catch(() => {})
			}
		}, intervalMs)
	}

	const setAutoSaveInterval = (ms: number): void => {
		if (typeof ms !== 'number' || ms <= 0) {
			throw new MachineError(
				'Auto-save interval must be a positive number',
				'VALIDATION_ERROR'
			)
		}

		intervalMs = ms
		stopTimer()
		startTimer()
	}

	const loadFromServer = async (): Promise<boolean> => {
		if (!ctx || !config.load) {
			return false
		}

		try {
			const serverState = await config.load()
			if (!serverState) {
				return false
			}

			dirty = false
			ctx.replaceState(serverState, { source: AUTOSAVE_SOURCE, description: 'Server load' })
			return true
		} catch (error) {
			ctx.emitError(toError(error), 'persist')
			return false
		}
	}

	return {
		name: AUTOSAVE_SOURCE,

		onInit(context) {
			ctx = context
			startTimer()

			return {
				forceSave,
				hasUnsavedChanges: () => dirty,
				setAutoSaveInterval,
				loadFromServer,
			}
		},

		onCommit() {
			dirty = true
		},

		onDestroy() {
			destroyed = true
			stopTimer()
			ctx = null
		},
	}
}
