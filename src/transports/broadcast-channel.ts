import type { SyncTransport } from './types'

/*
 *   BROADCAST CHANNEL TRANSPORT
 ***************************************************************************************************/
export interface BroadcastChannelTransportConfig {
	channel?: string
}

const DEFAULT_CHANNEL = 'clutch-state-sync'

export class BroadcastChannelTransport implements SyncTransport {
	private channel: BroadcastChannel | null = null
	private handler: ((message: unknown) => void) | null = null

	constructor(config?: BroadcastChannelTransportConfig) {
		if (typeof BroadcastChannel === 'undefined') {
			console.warn(
				'[Clutch Sync] BroadcastChannel not supported in this environment. Multi-instance sync disabled.'
			)
			return
		}

		try {
			this.channel = new BroadcastChannel(config?.channel || DEFAULT_CHANNEL)

			this.channel.addEventListener('message', event => {
				this.handler?.(event.data)
			})
		} catch (error) {
			console.error('[Clutch Sync] Failed to initialize BroadcastChannel:', error)
			this.channel = null
		}
	}

	public send(message: unknown): void {
		if (!this.channel) {
			return
		}

		try {
			this.channel.postMessage(message)
		} catch (error) {
			console.error('[Clutch Sync] Failed to broadcast message:', error)
		}
	}

	public onMessage(handler: (message: unknown) => void): void {
		this.handler = handler
	}

	public destroy(): void {
		if (this.channel) {
			try {
				this.channel.close()
			} catch {
				// Ignore close errors
			}
			this.channel = null
		}
		this.handler = null
	}
}
