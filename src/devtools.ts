import type { Patch } from 'immer'

/*
 *   TYPES
 ***************************************************************************************************/
export interface DevToolsConfig {
	name?: string
	maxAge?: number
	latency?: number
	features?: {
		jump?: boolean
		skip?: boolean
		import?: boolean
		export?: boolean
	}
}

interface DevToolsExtension {
	connect: (config: any) => DevToolsConnection
}

interface DevToolsConnection {
	init: (state: any) => void
	send: (action: any, state: any, options: any, instanceId: string) => void
	subscribe: (listener: (message: any) => void) => () => void
	unsubscribe: () => void
}

/*
 *   DEVTOOLS CONNECTOR
 ***************************************************************************************************/
export class DevToolsConnector<T extends object> {
	private extension: DevToolsConnection | null = null
	private instanceId: string
	private config: Required<DevToolsConfig>
	private unsubscribe: (() => void) | null = null

	constructor(
		name: string,
		config: DevToolsConfig,
		private onTimeTravel: (state: T) => void
	) {
		this.instanceId = `${name}_${Date.now()}`
		this.config = this.normalizeConfig(name, config)
		this.connect()
	}

	private normalizeConfig(name: string, config: DevToolsConfig): Required<DevToolsConfig> {
		return {
			name: config.name || name,
			maxAge: config.maxAge ?? 50,
			latency: config.latency ?? 500,
			features: {
				jump: config.features?.jump ?? true,
				skip: config.features?.skip ?? true,
				import: config.features?.import ?? true,
				export: config.features?.export ?? true,
			},
		}
	}

	private connect(): void {
		// Check if we're in a browser environment
		if (typeof window === 'undefined') {
			return
		}

		// Check if Redux DevTools Extension exists
		const ext = (window as any).__REDUX_DEVTOOLS_EXTENSION__ as DevToolsExtension | undefined
		if (!ext) {
			console.warn(
				'[Clutch DevTools] Redux DevTools Extension not found. Install it from: https://github.com/reduxjs/redux-devtools'
			)
			return
		}

		try {
			this.extension = ext.connect({
				name: this.config.name,
				maxAge: this.config.maxAge,
				latency: this.config.latency,
				features: this.config.features,
			})

			// Listen for time-travel actions
			this.unsubscribe = this.extension.subscribe((message: any) => {
				if (message.type === 'DISPATCH') {
					this.handleDispatch(message)
				}
			})
		} catch (error) {
			console.error('[Clutch DevTools] Failed to connect to Redux DevTools:', error)
		}
	}

	public send(action: string, state: T, patches?: Patch[]): void {
		if (!this.extension) {
			return
		}

		try {
			this.extension.send(
				{
					type: action,
					patches: patches?.length || 0,
				},
				state,
				{},
				this.instanceId
			)
		} catch (error) {
			console.error('[Clutch DevTools] Failed to send action:', error)
		}
	}

	public init(state: T): void {
		if (!this.extension) {
			return
		}

		try {
			this.extension.init(state)
		} catch (error) {
			console.error('[Clutch DevTools] Failed to initialize:', error)
		}
	}

	private handleDispatch(message: any): void {
		try {
			switch (message.payload?.type) {
				case 'JUMP_TO_STATE':
				case 'JUMP_TO_ACTION':
					if (message.state) {
						this.onTimeTravel(JSON.parse(message.state))
					}
					break

				case 'IMPORT_STATE': {
					const { nextLiftedState } = message.payload
					if (nextLiftedState?.computedStates) {
						const computedStates = nextLiftedState.computedStates
						const lastState = computedStates[computedStates.length - 1]
						if (lastState?.state) {
							this.onTimeTravel(lastState.state)
						}
					}
					break
				}
			}
		} catch (error) {
			console.error('[Clutch DevTools] Failed to handle dispatch:', error)
		}
	}

	public disconnect(): void {
		if (this.unsubscribe) {
			this.unsubscribe()
			this.unsubscribe = null
		}

		if (this.extension) {
			try {
				this.extension.unsubscribe()
			} catch (error) {
				// Ignore unsubscribe errors
			}
			this.extension = null
		}
	}
}
