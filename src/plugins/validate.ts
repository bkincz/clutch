/*
 *   IMPORTS
 ***************************************************************************************************/
import { MachineError, type Plugin, type PluginContext } from '../core'

/*
 *   TYPES
 ***************************************************************************************************/
export type StateValidator<T> = (state: T) => boolean | string

export interface StandardSchemaV1<Output = unknown> {
	readonly '~standard': {
		readonly version: 1
		readonly vendor: string
		readonly validate: (
			value: unknown
		) => StandardResult<Output> | Promise<StandardResult<Output>>
	}
}

type StandardResult<Output> =
	| { readonly value: Output; readonly issues?: undefined }
	| { readonly issues: ReadonlyArray<{ readonly message: string }> }

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
function isStandardSchema<T>(value: unknown): value is StandardSchemaV1<T> {
	return (
		typeof value === 'object' &&
		value !== null &&
		'~standard' in value &&
		typeof (value as StandardSchemaV1<T>)['~standard']?.validate === 'function'
	)
}

function toValidator<T extends object>(
	validator: StateValidator<T> | StandardSchemaV1<T>
): StateValidator<T> {
	if (isStandardSchema<T>(validator)) {
		return state => {
			const result = validator['~standard'].validate(state)
			if (result instanceof Promise) {
				throw new MachineError(
					'Async schema validation is not supported; state commits are synchronous',
					'VALIDATION_ERROR'
				)
			}
			if (result.issues) {
				return (
					result.issues.map(issue => issue.message).join('; ') ||
					'State validation failed'
				)
			}
			return true
		}
	}
	if (typeof validator === 'function') {
		return validator
	}
	throw new MachineError('Validator must be a function or a Standard Schema', 'VALIDATION_ERROR')
}
