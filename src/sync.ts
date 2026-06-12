import { applyPatches, enablePatches, type Patch } from 'immer'
import { BroadcastChannelTransport } from './transports/broadcast-channel'
import type { SyncTransport, TransportStatus } from './transports/types'

// Idempotent, and we can't rely on machine.ts having run it
enablePatches()

/*
 *   TYPES
 ***************************************************************************************************/
export interface SyncConfig {
	channel?: string
	syncDebounce?: number
	ignoreLocalChanges?: boolean
	mergeStrategy?: 'latest' | 'patches'
	transport?: SyncTransport
}

type NormalizedSyncConfig = Required<Omit<SyncConfig, 'transport'>> & {
	transport: SyncTransport | undefined
}

type SyncMessage<T> = {
	type: 'state_update' | 'full_sync' | 'patches'
	instanceId: string
	timestamp: number
	state: T | undefined
	patches: Patch[] | undefined
	inversePatches: Patch[] | undefined
	description: string | undefined
	// Server-assigned monotonic version. When present, ordering is version-based
	// and timestamp checks are skipped.
	version?: number
}

/*
 *   STATE SYNC MANAGER
 ***************************************************************************************************/
export class StateSyncManager<T extends object> {
	private transport: SyncTransport
	private instanceId: string
	private config: NormalizedSyncConfig
	private lastSyncTimestamp = 0
	private lastVersion: number | null = null
	private resyncPending = false
	private syncTimer: ReturnType<typeof setTimeout> | null = null
	private pendingState: T | null = null
	private pendingPatches: Patch[] = []
	private pendingInversePatches: Patch[] = []
	private pendingDescription: string | undefined

	constructor(
		config: SyncConfig,
		private getCurrentState: () => T,
		private applyRemoteState: (state: T, patches?: Patch[]) => void
	) {
		this.instanceId = `instance_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
		this.config = this.normalizeConfig(config)
		this.transport =
			this.config.transport ?? new BroadcastChannelTransport({ channel: this.config.channel })
		this.initialize()
	}

	private normalizeConfig(config: SyncConfig): NormalizedSyncConfig {
		return {
			channel: config.channel || 'clutch-state-sync',
			syncDebounce: config.syncDebounce ?? 50,
			ignoreLocalChanges: config.ignoreLocalChanges ?? false,
			mergeStrategy: config.mergeStrategy || 'latest',
			transport: config.transport,
		}
	}

	private initialize(): void {
		this.transport.onMessage(message => {
			this.handleMessage(message as SyncMessage<T>)
		})

		this.transport.onStatusChange?.(status => {
			this.handleStatusChange(status)
		})

		this.transport.start?.()

		this.requestFullSync()
	}

	private handleStatusChange(status: TransportStatus): void {
		if (status === 'connected') {
			// A reconnect invalidates the version cursor, so always resync from scratch
			this.lastVersion = null
			this.resyncPending = false
			this.requestFullSync()
		}
	}

	public broadcastChange(
		state: T,
		patches: Patch[],
		inversePatches: Patch[],
		description?: string
	): void {
		if (this.config.ignoreLocalChanges) {
			return
		}

		if (this.config.mergeStrategy === 'patches') {
			this.pendingPatches.push(...patches)
			this.pendingInversePatches.unshift(...inversePatches)
		} else {
			this.pendingState = state
		}
		this.pendingDescription = description ?? this.pendingDescription

		this.scheduleFlush()
	}

	private scheduleFlush(): void {
		if (this.syncTimer) {
			clearTimeout(this.syncTimer)
		}

		this.syncTimer = setTimeout(() => {
			this.syncTimer = null
			this.flushPending()
		}, this.config.syncDebounce)
	}

	private flushPending(): void {
		const isPatches = this.config.mergeStrategy === 'patches'

		if (isPatches ? this.pendingPatches.length === 0 : this.pendingState === null) {
			return
		}

		const message: SyncMessage<T> = {
			type: isPatches ? 'patches' : 'state_update',
			instanceId: this.instanceId,
			timestamp: Date.now(),
			state: isPatches ? undefined : (this.pendingState as T),
			patches: isPatches ? this.pendingPatches : undefined,
			inversePatches: isPatches ? this.pendingInversePatches : undefined,
			description: this.pendingDescription,
		}

		this.pendingState = null
		this.pendingPatches = []
		this.pendingInversePatches = []
		this.pendingDescription = undefined

		this.send(message)
	}

	private handleMessage(message: SyncMessage<T>): void {
		if (!message || typeof message !== 'object') {
			console.error('[Clutch Sync] Invalid message structure')
			return
		}

		// Resync requests carry no state and skip clock checks, because a
		// clock-skewed client still needs to be able to ask for a resync
		if (message.type === 'full_sync') {
			if (message.instanceId !== this.instanceId) {
				this.broadcastFullState()
			}
			return
		}

		if (typeof message.version === 'number') {
			this.handleVersionedMessage(message, message.version)
			return
		}

		if (message.instanceId === this.instanceId) {
			return
		}

		const now = Date.now()
		if (message.timestamp > now + 5000 || message.timestamp < now - 60000) {
			console.error('[Clutch Sync] Invalid timestamp, possible attack')
			return
		}

		if (message.timestamp <= this.lastSyncTimestamp) {
			return
		}

		if (this.applyMessage(message)) {
			this.lastSyncTimestamp = message.timestamp
		}
	}

	private handleVersionedMessage(message: SyncMessage<T>, version: number): void {
		if (this.lastVersion !== null && version <= this.lastVersion) {
			return
		}

		// The server echoes our own messages back. Advance the cursor without
		// applying, otherwise every mutation we make would look like a version gap.
		if (message.instanceId === this.instanceId) {
			this.lastVersion = version
			return
		}

		// Gapped patches build on state we never received. A full state_update
		// is self-contained, so gaps only matter for patches.
		const hasGap = this.lastVersion !== null && version > this.lastVersion + 1
		if (hasGap && message.type === 'patches') {
			if (!this.resyncPending) {
				this.resyncPending = true
				this.requestFullSync()
			}
			return
		}

		if (this.applyMessage(message)) {
			this.lastVersion = version
			if (message.type === 'state_update') {
				this.resyncPending = false
			}
		}
	}

	private applyMessage(message: SyncMessage<T>): boolean {
		try {
			switch (message.type) {
				case 'state_update':
					if (message.state) {
						if (typeof message.state !== 'object' || message.state === null) {
							console.error('[Clutch Sync] Invalid state type')
							return false
						}

						const stateStr = JSON.stringify(message.state)
						if (stateStr.includes('__proto__') || stateStr.includes('"constructor"')) {
							console.error(
								'[Clutch Sync] Potential prototype pollution detected in state'
							)
							return false
						}

						if (
							Object.prototype.hasOwnProperty.call(message.state, '__proto__') ||
							Object.prototype.hasOwnProperty.call(message.state, 'constructor')
						) {
							console.error('[Clutch Sync] Detected dangerous properties in state')
							return false
						}

						this.applyRemoteState(message.state)
						return true
					}
					return false

				case 'patches':
					if (message.patches) {
						if (!Array.isArray(message.patches)) {
							console.error('[Clutch Sync] Invalid patches format')
							return false
						}

						for (const patch of message.patches) {
							if (
								!patch ||
								typeof patch !== 'object' ||
								!patch.op ||
								!Array.isArray(patch.path)
							) {
								console.error('[Clutch Sync] Invalid patch structure')
								return false
							}

							for (const pathSegment of patch.path) {
								if (
									pathSegment === '__proto__' ||
									pathSegment === 'constructor' ||
									pathSegment === 'prototype'
								) {
									console.error('[Clutch Sync] Dangerous property in patch path')
									return false
								}
							}
						}

						const currentState = this.getCurrentState()
						const patchedState = applyPatches(currentState, message.patches) as T

						if (typeof patchedState !== 'object' || patchedState === null) {
							console.error('[Clutch Sync] Invalid patched state')
							return false
						}

						this.applyRemoteState(patchedState, message.patches)
						return true
					}
					return false

				default:
					console.error('[Clutch Sync] Unknown message type:', message.type)
					return false
			}
		} catch (error) {
			console.error('[Clutch Sync] Failed to handle message:', error)
			return false
		}
	}

	private requestFullSync(): void {
		const message: SyncMessage<T> = {
			type: 'full_sync',
			instanceId: this.instanceId,
			timestamp: Date.now(),
			state: undefined,
			patches: undefined,
			inversePatches: undefined,
			description: undefined,
		}

		this.send(message)
	}

	private broadcastFullState(): void {
		const message: SyncMessage<T> = {
			type: 'state_update',
			instanceId: this.instanceId,
			timestamp: Date.now(),
			state: this.getCurrentState(),
			patches: undefined,
			inversePatches: undefined,
			description: undefined,
		}

		this.send(message)
	}

	private send(message: SyncMessage<T>): void {
		try {
			this.transport.send(message)
		} catch (error) {
			console.error('[Clutch Sync] Failed to broadcast message:', error)
		}
	}

	public destroy(): void {
		if (this.syncTimer) {
			clearTimeout(this.syncTimer)
			this.syncTimer = null
		}

		// Send what's still buffered so peers don't lose the final change
		this.flushPending()

		this.transport.destroy()
	}
}
