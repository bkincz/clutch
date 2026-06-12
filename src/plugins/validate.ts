/*
 *   IMPORTS
 ***************************************************************************************************/
import { MachineError, type Plugin, type PluginContext } from '../core'

/*
 *   TYPES
 ***************************************************************************************************/
export type StateValidator<T> = (state: T) => boolean

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
			if (!validator(payload.state)) {
				throw new MachineError('State validation failed', 'VALIDATION_ERROR')
			}
		},

		onExternalState(state, meta) {
			if (!validator(state)) {
				ctx?.emitError(
					new MachineError(
						`State validation failed for external update from "${meta.source}"`,
						'VALIDATION_ERROR'
					),
					'validate'
				)
			}
		},

		onDestroy() {
			ctx = null
		},
	}
}
