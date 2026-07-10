/*
 *   IMPORTS
 ***************************************************************************************************/
import { version as CLUTCH_VERSION } from '../package.json'

/*
 *   TYPES
 ***************************************************************************************************/
export interface SharedMachineOptions {
	contract?: number | string
	version?: number
	migrate?: (previousState: unknown, fromVersion: number) => unknown
}

interface SharedEntry {
	machine: unknown
	clutchVersion: string
	contract: number | string | undefined
	version: number | undefined
}

/** A machine whose state can be read and replaced from outside; enough to migrate it. */
interface StatefulMachine {
	getState(): unknown
	replaceState(state: unknown, meta: { source: string; description?: string }): void
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
		reconcile(key, existing, options)
		return existing.machine as M
	}

	const machine = factory()
	entries[key] = {
		machine,
		clutchVersion: CLUTCH_VERSION,
		contract: options.contract,
		version: options.version,
	}
	return machine
}

/*
 *   RECONCILE
 ***************************************************************************************************/
function reconcile(key: string, existing: SharedEntry, options: SharedMachineOptions): void {
	// Version wins when both sides declare one; it can migrate, contract cannot.
	if (options.version !== undefined && existing.version !== undefined) {
		if (options.version > existing.version) {
			migrateUp(key, existing, options)
		} else if (options.version < existing.version) {
			console.warn(
				`[Clutch] Shared machine "${key}": this app expects version ${options.version}, but the shared state is already at version ${existing.version}. It cannot migrate down and may misread the newer shape.`
			)
		}
		return
	}

	if (options.contract !== undefined && existing.contract !== options.contract) {
		console.warn(
			`[Clutch] Shared machine "${key}" contract mismatch: it was created with contract ${String(existing.contract)}, but this app was built against contract ${String(options.contract)}. One of your apps is deployed against a different state shape.`
		)
	}
}

function migrateUp(key: string, existing: SharedEntry, options: SharedMachineOptions): void {
	const from = existing.version ?? 0

	if (!options.migrate) {
		console.warn(
			`[Clutch] Shared machine "${key}": a version ${options.version} app joined, but the shared state is version ${from} and no migrate() was provided. It stays on the old shape.`
		)
		return
	}

	if (!isStatefulMachine(existing.machine)) {
		return
	}

	try {
		const migrated = options.migrate(existing.machine.getState(), from)
		existing.machine.replaceState(migrated, {
			source: 'migrate',
			description: `Migrated shared state ${from} -> ${options.version}`,
		})
		existing.version = options.version
		existing.contract = options.contract ?? existing.contract
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		console.warn(
			`[Clutch] Shared machine "${key}": migrate() from version ${from} to ${options.version} failed; the shared state is unchanged. ${reason}`
		)
	}
}

function isStatefulMachine(value: unknown): value is StatefulMachine {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as StatefulMachine).getState === 'function' &&
		typeof (value as StatefulMachine).replaceState === 'function'
	)
}
