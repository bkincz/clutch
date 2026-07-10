/*
 *   IMPORTS
 ***************************************************************************************************/
import { MachineError } from '../core'

/*
 *   TYPES
 ***************************************************************************************************/
/**
 * The subset of the Standard Schema v1 spec clutch needs. Any compliant
 * validator (zod, valibot, arktype, ...) satisfies it structurally, so plugins
 * take a schema without depending on a specific library.
 */
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

/*
 *   HELPERS
 ***************************************************************************************************/
export function isStandardSchema<T>(value: unknown): value is StandardSchemaV1<T> {
	return (
		typeof value === 'object' &&
		value !== null &&
		'~standard' in value &&
		typeof (value as StandardSchemaV1<T>)['~standard']?.validate === 'function'
	)
}

export function checkSchema<T>(schema: StandardSchemaV1<T>, value: unknown): true | string {
	const result = schema['~standard'].validate(value)
	if (result instanceof Promise) {
		throw new MachineError(
			'Async schema validation is not supported; state updates are synchronous',
			'VALIDATION_ERROR'
		)
	}
	if (result.issues) {
		return result.issues.map(issue => issue.message).join('; ') || 'Schema validation failed'
	}
	return true
}
