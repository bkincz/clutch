/**
 * React integration for Clutch state management
 *
 * This module provides React hooks for using Clutch state machines in React applications.
 * Import from this module when using Clutch with React.
 *
 * @example
 * ```typescript
 * import { useStateMachine, useStateSlice } from '@bkincz/clutch/react'
 *
 * function Counter() {
 *   const { state, mutate } = useStateMachine(counterMachine)
 *   return <button onClick={() => mutate(draft => { draft.count++ })}>
 *     Count: {state.count}
 *   </button>
 * }
 * ```
 *
 * @module @bkincz/clutch/react
 */

/*
 *   REACT HOOK EXPORTS
 ***************************************************************************************************/
export {
	useStateMachine,
	useStateSlice,
	useStateActions,
	useStateHistory,
	useStatePersist,
	useStateMachineFull,
	useOptimisticUpdate,
	useDebouncedStateUpdate,
	useStateSubscription,
	useShallowEqual,
	createStateMachineHooks,
	useLifecycleEvent,
	useRegistry,
	useRegistrySlice,
	useRegistryMachine,
	useRegistryActions,
	createRegistryHooks,
} from './hooks'
