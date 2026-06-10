/*
 *   SYNC TRANSPORT INTERFACE
 ***************************************************************************************************/

export type TransportStatus = 'connecting' | 'connected' | 'disconnected'

// Members must NOT be `_`-prefixed. The build mangles /^_/ properties per
// bundle, and transports cross bundle boundaries (sync-ws into core).
export interface SyncTransport {
	send(message: unknown): void
	onMessage(handler: (message: unknown) => void): void
	// 'connected' triggers a full resync in StateSyncManager
	onStatusChange?(handler: (status: TransportStatus) => void): void
	// If absent, the transport is live on construction
	start?(): void
	destroy(): void
}
