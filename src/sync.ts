import { applyPatches, type Patch } from 'immer'

/*
 *   TYPES
 ***************************************************************************************************/
export interface SyncConfig {
	channel?: string
	syncDebounce?: number
	ignoreLocalChanges?: boolean
	mergeStrategy?: 'latest' | 'patches'
}

type SyncMessage<T> = {
	type: 'state_update' | 'full_sync' | 'patches'
	instanceId: string
	timestamp: number
	state: T | undefined
	patches: Patch[] | undefined
	inversePatches: Patch[] | undefined
	description: string | undefined
}

/*
 *   UTILITY FUNCTION
 ***************************************************************************************************/
function debounce<T extends (...args: any[]) => void>(func: T, wait: number): T {
	let timeout: ReturnType<typeof setTimeout>
	return ((...args: Parameters<T>) => {
		clearTimeout(timeout)
		timeout = setTimeout(() => func(...args), wait)
	}) as T
}

/*
 *   STATE SYNC MANAGER
 ***************************************************************************************************/
export class StateSyncManager<T extends object> {
	private channel: BroadcastChannel | null = null
	private instanceId: string
	private config: Required<SyncConfig>
	private lastSyncTimestamp = 0
	private debouncedSync: (message: SyncMessage<T>) => void

	constructor(
		config: SyncConfig,
		private getCurrentState: () => T,
		private applyRemoteState: (state: T, patches?: Patch[]) => void
	) {
		this.instanceId = `instance_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
		this.config = this.normalizeConfig(config)
		this.debouncedSync = debounce(msg => this.send(msg), this.config.syncDebounce)
		this.initialize()
	}

	private normalizeConfig(config: SyncConfig): Required<SyncConfig> {
		return {
			channel: config.channel || 'clutch-state-sync',
			syncDebounce: config.syncDebounce ?? 50,
			ignoreLocalChanges: config.ignoreLocalChanges ?? false,
			mergeStrategy: config.mergeStrategy || 'latest',
		}
	}

	private initialize(): void {
		// Check if we're in a browser environment
		if (typeof BroadcastChannel === 'undefined') {
			console.warn(
				'[Clutch Sync] BroadcastChannel not supported in this environment. Multi-instance sync disabled.'
			)
			return
		}

		try {
			this.channel = new BroadcastChannel(this.config.channel)

			this.channel.addEventListener('message', event => {
				this.handleMessage(event.data)
			})

			// Request full state from other tabs
			this.requestFullSync()
		} catch (error) {
			console.error('[Clutch Sync] Failed to initialize BroadcastChannel:', error)
		}
	}

	public broadcastChange(
		state: T,
		patches: Patch[],
		inversePatches: Patch[],
		description?: string
	): void {
		if (!this.channel || this.config.ignoreLocalChanges) {
			return
		}

		const message: SyncMessage<T> = {
			type: this.config.mergeStrategy === 'patches' ? 'patches' : 'state_update',
			instanceId: this.instanceId,
			timestamp: Date.now(),
			state: this.config.mergeStrategy === 'latest' ? state : undefined,
			patches: this.config.mergeStrategy === 'patches' ? patches : undefined,
			inversePatches: this.config.mergeStrategy === 'patches' ? inversePatches : undefined,
			description,
		}

		this.debouncedSync(message)
	}

	private handleMessage(message: SyncMessage<T>): void {
		// Validate message structure
		if (!message || typeof message !== 'object') {
			console.error('[Clutch Sync] Invalid message structure')
			return
		}

		// Ignore messages from self
		if (message.instanceId === this.instanceId) {
			return
		}

		// Validate timestamp is reasonable (not too far in future/past)
		const now = Date.now()
		if (message.timestamp > now + 5000 || message.timestamp < now - 60000) {
			console.error('[Clutch Sync] Invalid timestamp, possible attack')
			return
		}

		// Ignore stale messages
		if (message.timestamp <= this.lastSyncTimestamp) {
			return
		}

		try {
			switch (message.type) {
				case 'state_update':
					if (message.state) {
						if (typeof message.state !== 'object' || message.state === null) {
							console.error('[Clutch Sync] Invalid state type')
							return
						}

						const stateStr = JSON.stringify(message.state)
						if (stateStr.includes('__proto__') || stateStr.includes('"constructor"')) {
							console.error(
								'[Clutch Sync] Potential prototype pollution detected in state'
							)
							return
						}

						if (
							Object.prototype.hasOwnProperty.call(message.state, '__proto__') ||
							Object.prototype.hasOwnProperty.call(message.state, 'constructor')
						) {
							console.error('[Clutch Sync] Detected dangerous properties in state')
							return
						}

						this.applyRemoteState(message.state)
						this.lastSyncTimestamp = message.timestamp
					}
					break

				case 'patches':
					if (message.patches) {
						if (!Array.isArray(message.patches)) {
							console.error('[Clutch Sync] Invalid patches format')
							return
						}

						for (const patch of message.patches) {
							if (
								!patch ||
								typeof patch !== 'object' ||
								!patch.op ||
								!Array.isArray(patch.path)
							) {
								console.error('[Clutch Sync] Invalid patch structure')
								return
							}

							for (const pathSegment of patch.path) {
								if (
									pathSegment === '__proto__' ||
									pathSegment === 'constructor' ||
									pathSegment === 'prototype'
								) {
									console.error('[Clutch Sync] Dangerous property in patch path')
									return
								}
							}
						}

						const currentState = this.getCurrentState()
						const patchedState = applyPatches(currentState, message.patches) as T

						if (typeof patchedState !== 'object' || patchedState === null) {
							console.error('[Clutch Sync] Invalid patched state')
							return
						}

						this.applyRemoteState(patchedState, message.patches)
						this.lastSyncTimestamp = message.timestamp
					}
					break

				case 'full_sync':
					// Another tab requesting full state
					this.broadcastFullState()
					break

				default:
					console.error('[Clutch Sync] Unknown message type:', message.type)
			}
		} catch (error) {
			console.error('[Clutch Sync] Failed to handle message:', error)
		}
	}

	private requestFullSync(): void {
		if (!this.channel) {
			return
		}

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
		if (!this.channel) {
			return
		}

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
		if (!this.channel) {
			return
		}

		try {
			this.channel.postMessage(message)
		} catch (error) {
			console.error('[Clutch Sync] Failed to broadcast message:', error)
		}
	}

	public destroy(): void {
		if (this.channel) {
			try {
				this.channel.close()
			} catch (error) {
				// Ignore close errors
			}
			this.channel = null
		}
	}
}
