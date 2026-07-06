import type { SyncTransport, TransportStatus } from './types'

/*
 *   TYPES
 ***************************************************************************************************/
export interface WebSocketTransportConfig {
	url: string
	protocols?: string | string[]
	webSocketCtor?: WebSocketCtor
	reconnect?: false | { maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number }
	heartbeatIntervalMs?: number
	heartbeatTimeoutMs?: number
	maxQueueSize?: number
	getAuthToken?: () => string | Promise<string>
	authMode?: 'query' | 'message'
	onError?: (error: unknown) => void
}

interface WebSocketLike {
	readyState: number
	send(data: string): void
	close(): void
	addEventListener(type: string, listener: (event: { data?: unknown }) => void): void
}

type WebSocketCtor = new (url: string, protocols?: string | string[]) => WebSocketLike

const WS_OPEN = 1

/*
 *   WEBSOCKET TRANSPORT
 ***************************************************************************************************/
// The server must implement the stamping-relay protocol in docs/sync-protocol.md
export class WebSocketTransport implements SyncTransport {
	private socket: WebSocketLike | null = null
	private messageHandler: ((message: unknown) => void) | null = null
	private statusHandler: ((status: TransportStatus) => void) | null = null
	private queue: string[] = []
	private destroyed = false
	private started = false
	private reconnectAttempt = 0
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null
	private heartbeatDeadline: ReturnType<typeof setTimeout> | null = null

	constructor(private config: WebSocketTransportConfig) {}

	public send(message: unknown): void {
		let data: string
		try {
			data = JSON.stringify(message)
		} catch (error) {
			this.reportError(error)
			return
		}

		if (this.socket && this.socket.readyState === WS_OPEN) {
			this.socket.send(data)
		} else {
			this.enqueue(data)
		}
	}

	public onMessage(handler: (message: unknown) => void): void {
		this.messageHandler = handler
	}

	public onStatusChange(handler: (status: TransportStatus) => void): void {
		this.statusHandler = handler
	}

	public start(): void {
		if (this.started || this.destroyed) {
			return
		}
		this.started = true
		void this.connect()
	}

	public destroy(): void {
		this.destroyed = true

		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer)
			this.reconnectTimer = null
		}
		this.stopHeartbeat()

		if (this.socket) {
			try {
				this.socket.close()
			} catch (error) {
				// Ignore close errors
			}
			this.socket = null
		}

		this.queue = []
		this.messageHandler = null
		this.statusHandler = null
	}

	/*
	 * CONNECTION LIFECYCLE
	 */
	private async connect(): Promise<void> {
		if (this.destroyed) {
			return
		}

		this.statusHandler?.('connecting')

		let url = this.config.url
		let authMessage: string | null = null

		try {
			if (this.config.getAuthToken) {
				const token = await this.config.getAuthToken()
				if (this.destroyed) {
					return
				}

				if ((this.config.authMode ?? 'query') === 'query') {
					const separator = url.includes('?') ? '&' : '?'
					url = `${url}${separator}token=${encodeURIComponent(token)}`
				} else {
					authMessage = JSON.stringify({ type: 'auth', token })
				}
			}

			const Ctor =
				this.config.webSocketCtor ??
				(typeof WebSocket !== 'undefined'
					? (WebSocket as unknown as WebSocketCtor)
					: undefined)
			if (!Ctor) {
				this.reportError(new Error('WebSocket is not available in this environment'))
				return
			}

			const socket = this.config.protocols
				? new Ctor(url, this.config.protocols)
				: new Ctor(url)
			this.socket = socket

			socket.addEventListener('open', () => this.handleOpen(authMessage))
			socket.addEventListener('message', event => this.handleInbound(event.data))
			socket.addEventListener('close', () => this.handleClose())
			socket.addEventListener('error', event => this.reportError(event))
		} catch (error) {
			this.reportError(error)
			this.scheduleReconnect()
		}
	}

	private handleOpen(authMessage: string | null): void {
		if (this.destroyed || !this.socket) {
			return
		}

		this.reconnectAttempt = 0

		if (authMessage) {
			this.socket.send(authMessage)
		}

		// Flush before emitting 'connected' so the manager's resync request
		// lands after (and supersedes) any stale queued updates
		const pending = this.queue
		this.queue = []
		for (const data of pending) {
			this.socket.send(data)
		}

		this.startHeartbeat()
		this.statusHandler?.('connected')
	}

	private handleInbound(data: unknown): void {
		this.clearHeartbeatDeadline()

		let message: unknown
		try {
			message = JSON.parse(String(data))
		} catch (error) {
			return
		}

		// Pongs are transport-level and never reach the manager
		if (
			message &&
			typeof message === 'object' &&
			(message as { type?: unknown }).type === 'pong'
		) {
			return
		}

		this.messageHandler?.(message)
	}

	private handleClose(): void {
		this.stopHeartbeat()
		this.socket = null

		if (this.destroyed) {
			return
		}

		this.statusHandler?.('disconnected')
		this.scheduleReconnect()
	}

	private scheduleReconnect(): void {
		if (this.destroyed || this.config.reconnect === false || this.reconnectTimer) {
			return
		}

		const reconnect = this.config.reconnect ?? {}
		const maxRetries = reconnect.maxRetries ?? Infinity
		const baseDelayMs = reconnect.baseDelayMs ?? 500
		const maxDelayMs = reconnect.maxDelayMs ?? 30000

		if (this.reconnectAttempt >= maxRetries) {
			this.reportError(new Error('WebSocket reconnect gave up after max retries'))
			return
		}

		// Full jitter: random delay within an exponentially growing window
		const delay = Math.random() * Math.min(maxDelayMs, baseDelayMs * 2 ** this.reconnectAttempt)
		this.reconnectAttempt++

		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null
			void this.connect()
		}, delay)
	}

	/*
	 * QUEUE + HEARTBEAT
	 */
	private enqueue(data: string): void {
		const maxQueueSize = this.config.maxQueueSize ?? 100
		if (this.queue.length >= maxQueueSize) {
			this.queue.shift()
			this.reportError(new Error('WebSocket offline queue overflow, dropped oldest message'))
		}
		this.queue.push(data)
	}

	private startHeartbeat(): void {
		const interval = this.config.heartbeatIntervalMs ?? 30000
		if (interval <= 0) {
			return
		}
		const timeout = this.config.heartbeatTimeoutMs ?? 10000

		this.heartbeatTimer = setInterval(() => {
			if (!this.socket || this.socket.readyState !== WS_OPEN) {
				return
			}

			this.socket.send(JSON.stringify({ type: 'ping' }))

			if (!this.heartbeatDeadline) {
				this.heartbeatDeadline = setTimeout(() => {
					this.heartbeatDeadline = null
					this.reportError(new Error('WebSocket heartbeat timed out'))
					try {
						this.socket?.close()
					} catch (error) {
						// Ignore close errors, handleClose drives reconnection anyway
					}
				}, timeout)
			}
		}, interval)
	}

	private clearHeartbeatDeadline(): void {
		if (this.heartbeatDeadline) {
			clearTimeout(this.heartbeatDeadline)
			this.heartbeatDeadline = null
		}
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer)
			this.heartbeatTimer = null
		}
		this.clearHeartbeatDeadline()
	}

	private reportError(error: unknown): void {
		this.config.onError?.(error)
		console.error('[Clutch Sync] WebSocket transport error:', error)
	}
}
