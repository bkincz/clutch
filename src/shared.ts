/*
 *   IMPORTS
 ***************************************************************************************************/
import { version as CLUTCH_VERSION } from '../package.json'

/*
 *   TYPES
 ***************************************************************************************************/
export interface SharedMachineOptions {
	contract?: number | string
}

interface SharedEntry {
	machine: unknown
	clutchVersion: string
	contract: number | string | undefined
}

/*
 *   SHARED MACHINE
 ***************************************************************************************************/
const REGISTRY_KEY = '__clutchSharedMachines'

type SharedScope = typeof globalThis & {
	[REGISTRY_KEY]?: Record<string, SharedEntry>
}

function registry(): Record<string, SharedEntry> {
	const scope = globalThis as SharedScope
	return (scope[REGISTRY_KEY] ??= {})
}

export function sharedMachine<M>(
	key: string,
	factory: () => M,
	options: SharedMachineOptions = {}
): M {
	const entries = registry()
	const existing = entries[key]

	if (existing) {
		if (existing.clutchVersion !== CLUTCH_VERSION) {
			console.warn(
				`[Clutch] Shared machine "${key}" was created by clutch ${existing.clutchVersion}, but this bundle ships clutch ${CLUTCH_VERSION}. Align clutch versions across your apps, or share clutch as a singleton in your module federation config.`
			)
		}
		if (options.contract !== undefined && existing.contract !== options.contract) {
			console.warn(
				`[Clutch] Shared machine "${key}" contract mismatch: it was created with contract ${String(existing.contract)}, but this app was built against contract ${String(options.contract)}. One of your apps is deployed against a different state shape.`
			)
		}
		return existing.machine as M
	}

	const machine = factory()
	entries[key] = { machine, clutchVersion: CLUTCH_VERSION, contract: options.contract }
	return machine
}
