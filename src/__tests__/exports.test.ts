import { describe, it, expect } from 'vitest'

describe('Package Exports', () => {
	describe('Core exports from main entry', () => {
		it('should export core StateMachine classes', async () => {
			const coreExports = await import('../index')

			expect(coreExports.StateMachine).toBeDefined()
			expect(coreExports.StateMachineError).toBeDefined()
			expect(coreExports.StateValidationError).toBeDefined()
			expect(coreExports.StatePersistenceError).toBeDefined()
		})

		it('should export StateRegistry', async () => {
			const coreExports = await import('../index')

			expect(coreExports.StateRegistry).toBeDefined()
		})

		it('should export DevTools and Sync managers', async () => {
			const coreExports = await import('../index')

			expect(coreExports.DevToolsConnector).toBeDefined()
			expect(coreExports.StateSyncManager).toBeDefined()
		})

		it('should export core types', async () => {
			const _typeTest: import('../index').StateConfig<{ count: number }> = {
				initialState: { count: 0 },
			}

			expect(_typeTest).toBeDefined()
		})
	})

	describe('React hooks from main entry (deprecated)', () => {
		it('should still export React hooks for backward compatibility', async () => {
			const coreExports = await import('../index')

			expect(coreExports.useStateMachine).toBeDefined()
			expect(coreExports.useStateSlice).toBeDefined()
			expect(coreExports.useStateActions).toBeDefined()
			expect(coreExports.useStateHistory).toBeDefined()
			expect(coreExports.useStatePersist).toBeDefined()
			expect(coreExports.useLifecycleEvent).toBeDefined()
			expect(coreExports.useOptimisticUpdate).toBeDefined()
			expect(coreExports.useDebouncedStateUpdate).toBeDefined()
			expect(coreExports.useStateSubscription).toBeDefined()
			expect(coreExports.useShallowEqual).toBeDefined()
			expect(coreExports.useRegistry).toBeDefined()
			expect(coreExports.useRegistrySlice).toBeDefined()
			expect(coreExports.useRegistryMachine).toBeDefined()
			expect(coreExports.useRegistryActions).toBeDefined()
			expect(coreExports.createStateMachineHooks).toBeDefined()
			expect(coreExports.createRegistryHooks).toBeDefined()
		})
	})

	describe('React hooks from /react entry', () => {
		it('should export all React hooks', async () => {
			const reactExports = await import('../integrations/react')

			expect(reactExports.useStateMachine).toBeDefined()
			expect(reactExports.useStateSlice).toBeDefined()
			expect(reactExports.useStateActions).toBeDefined()
			expect(reactExports.useStateHistory).toBeDefined()
			expect(reactExports.useStatePersist).toBeDefined()
			expect(reactExports.useLifecycleEvent).toBeDefined()
			expect(reactExports.useOptimisticUpdate).toBeDefined()
			expect(reactExports.useDebouncedStateUpdate).toBeDefined()
			expect(reactExports.useStateSubscription).toBeDefined()
			expect(reactExports.useShallowEqual).toBeDefined()
			expect(reactExports.useRegistry).toBeDefined()
			expect(reactExports.useRegistrySlice).toBeDefined()
			expect(reactExports.useRegistryMachine).toBeDefined()
			expect(reactExports.useRegistryActions).toBeDefined()
			expect(reactExports.createStateMachineHooks).toBeDefined()
			expect(reactExports.createRegistryHooks).toBeDefined()
		})

		it('should export the same hooks as main entry', async () => {
			const coreExports = await import('../index')
			const reactExports = await import('../integrations/react')

			expect(reactExports.useStateMachine).toBe(coreExports.useStateMachine)
			expect(reactExports.useStateSlice).toBe(coreExports.useStateSlice)
			expect(reactExports.useRegistry).toBe(coreExports.useRegistry)
			expect(reactExports.createStateMachineHooks).toBe(coreExports.createStateMachineHooks)
		})

		it('should NOT export core classes from /react entry', async () => {
			const reactExports = await import('../integrations/react')

			expect((reactExports as any).StateMachine).toBeUndefined()
			expect((reactExports as any).StateRegistry).toBeUndefined()
			expect((reactExports as any).DevToolsConnector).toBeUndefined()
		})
	})

	describe('Export consistency', () => {
		it('should have 17 hook exports from /react entry', async () => {
			const reactExports = await import('../integrations/react')
			const exportKeys = Object.keys(reactExports)

			expect(exportKeys.length).toBe(17)
		})
	})
})
