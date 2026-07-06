/*
 *   IMPORTS
 ***************************************************************************************************/
import { MachineError, type Plugin, type PluginContext } from '../core'

/*
 *   TYPES
 ***************************************************************************************************/
/** Return true to accept, false to reject, or a string to reject with that message. */
export type StateValidator<T> = (state: T) => boolean | string

const VALIDATE_SOURCE = 'validate'

/*
 *   PLUGIN
 ***************************************************************************************************/
export function validate<T extends object>(validator: StateValidator<T>): Plugin<T> {
	if (typeof validator !== 'function') {
		throw new MachineError('Validator must be a function', 'VALIDATION_ERROR')
	}

	let ctx: PluginContext<T> | null = null

	return {
		name: VALIDATE_SOURCE,

		onInit(context) {
			ctx = context
		},

		onBeforeCommit(payload) {
			const result = validator(payload.state)
			if (typeof result === 'string') {
				throw new MachineError(result || 'State validation failed', 'VALIDATION_ERROR')
			}
			if (!result) {
				throw new MachineError('State validation failed', 'VALIDATION_ERROR')
			}
		},

		onExternalState(state, meta) {
			const result = validator(state)
			if (typeof result !== 'string' && result) {
				return
			}
			const detail = typeof result === 'string' && result ? `: ${result}` : ''
			ctx?.emitError(
				new MachineError(
					`State validation failed for external update from "${meta.source}"${detail}`,
					'VALIDATION_ERROR'
				),
				'validate'
			)
		},

		onDestroy() {
			ctx = null
		},
	}
}
