import { describe, it, expect } from 'vitest'
import { createMachine, validate, type MachineConfig, type StandardSchemaV1 } from '../index'

describe('Package Exports', () => {
	describe('Main entry', () => {
		it('exports the machine core', async () => {
			const main = await import('../index')

			expect(main.Machine).toBeDefined()
			expect(main.createMachine).toBeDefined()
			expect(main.MachineError).toBeDefined()
		})

		it('exports the registry', async () => {
			const main = await import('../index')

			expect(main.Registry).toBeDefined()
			expect(main.createRegistry).toBeDefined()
		})

		it('exports all plugins', async () => {
			const main = await import('../index')

			expect(main.history).toBeDefined()
			expect(main.persist).toBeDefined()
			expect(main.devtools).toBeDefined()
			expect(main.sync).toBeDefined()
			expect(main.validate).toBeDefined()
			expect(main.autosave).toBeDefined()
		})

		it('does NOT export the removed v2 compat bridge', async () => {
			const main = await import('../index')

			expect((main as Record<string, unknown>).createV2Machine).toBeUndefined()
		})

		it('exports the BroadcastChannelTransport', async () => {
			const main = await import('../index')

			expect(main.BroadcastChannelTransport).toBeDefined()
		})

		it('exports core types', async () => {
			const _typeTest: MachineConfig<{ count: number }> = {
				initialState: { count: 0 },
			}

			expect(_typeTest).toBeDefined()
		})

		it('exports the schema type plugins accept', () => {
			const schema: StandardSchemaV1<{ count: number }> = {
				'~standard': {
					version: 1,
					vendor: 'test',
					validate: value => ({ value: value as { count: number } }),
				},
			}

			const machine = createMachine({ initialState: { count: 0 } }).with(validate(schema))

			expect(machine.getState().count).toBe(0)
		})

		it('does NOT export React hooks from the main entry', async () => {
			const main = await import('../index')

			expect((main as Record<string, unknown>).useMachine).toBeUndefined()
			expect((main as Record<string, unknown>).useSlice).toBeUndefined()
		})
	})

	describe('React entry', () => {
		it('exports all hooks', async () => {
			const react = await import('../react')

			expect(react.useMachine).toBeDefined()
			expect(react.useSlice).toBeDefined()
			expect(react.useSubscription).toBeDefined()
			expect(react.useRegistry).toBeDefined()
			expect(react.useRegistrySlice).toBeDefined()
			expect(react.useMachineHistory).toBeDefined()
			expect(react.useHydration).toBeDefined()
			expect(react.useAutosave).toBeDefined()
		})

		it('exports the scope factory', async () => {
			const react = await import('../react')

			expect(react.createMachineScope).toBeDefined()
		})

		it('does NOT export core classes from the React entry', async () => {
			const react = await import('../react')

			expect((react as Record<string, unknown>).Machine).toBeUndefined()
			expect((react as Record<string, unknown>).Registry).toBeUndefined()
		})

		it('has exactly 9 exports', async () => {
			const react = await import('../react')

			expect(Object.keys(react).length).toBe(9)
		})
	})

	describe('Sync WS entry', () => {
		it('exports WebSocketTransport', async () => {
			const syncWs = await import('../transports/websocket')

			expect(syncWs.WebSocketTransport).toBeDefined()
		})

		it('does NOT export core classes from the sync-ws entry', async () => {
			const syncWs = await import('../transports/websocket')

			expect((syncWs as Record<string, unknown>).Machine).toBeUndefined()
			expect((syncWs as Record<string, unknown>).StateSyncManager).toBeUndefined()
		})
	})
})
