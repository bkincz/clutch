/*
 *   IMPORTS
 ***************************************************************************************************/
import { MachineError, type Plugin, type PluginContext } from '../core'
import { checkSchema, isStandardSchema, type StandardSchemaV1 } from './standard-schema'

/*
 *   TYPES
 ***************************************************************************************************/
export type StateValidator<T> = (state: T) => boolean | string

export type { StandardSchemaV1 }

const VALIDATE_SOURCE = 'validate'

/*
 *   PLUGIN
 ***************************************************************************************************/
export function validate<T extends object>(
	validator: StateValidator<T> | StandardSchemaV1<T>
): Plugin<T> {
	const check = toValidator(validator)

	let ctx: PluginContext<T> | null = null

	return {
		name: VALIDATE_SOURCE,

		onInit(context) {
			ctx = context
		},

		onBeforeCommit(payload) {
			const result = check(payload.state)
			if (typeof result === 'string') {
				throw new MachineError(result || 'State validation failed', 'VALIDATION_ERROR')
			}
			if (!result) {
				throw new MachineError('State validation failed', 'VALIDATION_ERROR')
			}
		},

		onExternalState(state, meta) {
			const result = check(state)
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

/*
 *   HELPERS
 ***************************************************************************************************/
/** Normalizes a Standard Schema into the predicate the plugin already speaks. */
function toValidator<T extends object>(
	validator: StateValidator<T> | StandardSchemaV1<T>
): StateValidator<T> {
	if (isStandardSchema<T>(validator)) {
		return state => checkSchema(validator, state)
	}
	if (typeof validator === 'function') {
		return validator
	}
	throw new MachineError('Validator must be a function or a Standard Schema', 'VALIDATION_ERROR')
}
