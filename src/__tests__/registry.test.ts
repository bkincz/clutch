/*
 *   IMPORTS
 ***************************************************************************************************/
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StateMachine, StateMachineError } from '../machine'
import { StateRegistry } from '../store'

// Helper to wait for debounced notifications (16ms debounce + buffer)
const waitForNotification = () => new Promise(resolve => setTimeout(resolve, 25))

/*
 *   TYPES
 ***************************************************************************************************/
type UserState = {
	name: string
	email: string
}

type TodosState = {
	items: { id: string; text: string; completed: boolean }[]
}

type SettingsState = {
	theme: 'light' | 'dark'
	notifications: boolean
}

type AppMachines = {
	user: UserState
	todos: TodosState
	settings: SettingsState
}

/*
 *   TEST CLASSES
 ***************************************************************************************************/
class UserMachine extends StateMachine<UserState> {
	constructor(initialState?: UserState) {
		super({
			initialState: initialState ?? { name: '', email: '' },
		})
	}
}

class TodosMachine extends StateMachine<TodosState> {
	constructor(initialState?: TodosState) {
		super({
			initialState: initialState ?? { items: [] },
		})
	}
}

class SettingsMachine extends StateMachine<SettingsState> {
	constructor(initialState?: SettingsState) {
		super({
			initialState: initialState ?? { theme: 'light', notifications: true },
		})
	}
}

/*
 *   TESTS
 ***************************************************************************************************/
describe('StateRegistry', () => {
	let store: StateRegistry<AppMachines>
	let userMachine: UserMachine
	let todosMachine: TodosMachine
	let settingsMachine: SettingsMachine

	beforeEach(() => {
		vi.clearAllMocks()
		store = new StateRegistry<AppMachines>()
		userMachine = new UserMachine({ name: 'John', email: 'john@example.com' })
		todosMachine = new TodosMachine({ items: [{ id: '1', text: 'Test', completed: false }] })
		settingsMachine = new SettingsMachine({ theme: 'dark', notifications: false })
	})

	describe('registration', () => {
		it('should register machines', () => {
			store.register('user', userMachine)
			store.register('todos', todosMachine)

			expect(store.has('user')).toBe(true)
			expect(store.has('todos')).toBe(true)
			expect(store.has('settings')).toBe(false)
		})

		it('should throw when registering duplicate machine name', () => {
			store.register('user', userMachine)

			expect(() => store.register('user', new UserMachine())).toThrow(StateMachineError)
		})

		it('should unregister machines', () => {
			store.register('user', userMachine)
			expect(store.has('user')).toBe(true)

			store.unregister('user')
			expect(store.has('user')).toBe(false)
		})

		it('should handle unregistering non-existent machine gracefully', () => {
			expect(() => store.unregister('user')).not.toThrow()
		})

		it('should get machine by name', () => {
			store.register('user', userMachine)

			const machine = store.getMachine('user')
			expect(machine).toBe(userMachine)
		})

		it('should return undefined for non-existent machine', () => {
			const machine = store.getMachine('user')
			expect(machine).toBeUndefined()
		})

		it('should get all machine names', () => {
			store.register('user', userMachine)
			store.register('todos', todosMachine)

			const names = store.getMachineNames()
			expect(names).toContain('user')
			expect(names).toContain('todos')
			expect(names).toHaveLength(2)
		})
	})

	describe('state access', () => {
		it('should get combined state from all machines', () => {
			store.register('user', userMachine)
			store.register('todos', todosMachine)
			store.register('settings', settingsMachine)

			const state = store.getState()

			expect(state.user).toEqual({ name: 'John', email: 'john@example.com' })
			expect(state.todos).toEqual({ items: [{ id: '1', text: 'Test', completed: false }] })
			expect(state.settings).toEqual({ theme: 'dark', notifications: false })
		})

		it('should get state from specific machine', () => {
			store.register('user', userMachine)

			const userState = store.getMachineState('user')
			expect(userState).toEqual({ name: 'John', email: 'john@example.com' })
		})

		it('should return undefined for non-existent machine state', () => {
			const state = store.getMachineState('user')
			expect(state).toBeUndefined()
		})
	})

	describe('subscriptions', () => {
		it('should subscribe to combined state changes', async () => {
			store.register('user', userMachine)
			const listener = vi.fn()

			store.subscribe(listener)

			// Should NOT be called immediately (no initial call for performance)
			expect(listener).toHaveBeenCalledTimes(0)

			userMachine.mutate(draft => {
				draft.name = 'Jane'
			})

			await waitForNotification()

			expect(listener).toHaveBeenCalledTimes(1)
			expect(listener).toHaveBeenLastCalledWith({
				user: { name: 'Jane', email: 'john@example.com' },
			})
		})

		it('should unsubscribe from combined state changes', async () => {
			store.register('user', userMachine)
			const listener = vi.fn()

			const unsubscribe = store.subscribe(listener)
			expect(listener).toHaveBeenCalledTimes(0)

			userMachine.mutate(draft => {
				draft.name = 'Jane'
			})

			await waitForNotification()
			expect(listener).toHaveBeenCalledTimes(1)

			unsubscribe()

			userMachine.mutate(draft => {
				draft.name = 'Bob'
			})

			await waitForNotification()

			expect(listener).toHaveBeenCalledTimes(1)
		})

		it('should subscribe to specific machine state changes', async () => {
			store.register('user', userMachine)
			store.register('todos', todosMachine)
			const listener = vi.fn()

			store.subscribeToMachine('user', listener)

			expect(listener).toHaveBeenCalledTimes(1)

			userMachine.mutate(draft => {
				draft.name = 'Jane'
			})

			await waitForNotification()

			expect(listener).toHaveBeenCalledTimes(2)

			todosMachine.mutate(draft => {
				draft.items.push({ id: '2', text: 'New', completed: false })
			})

			await waitForNotification()

			expect(listener).toHaveBeenCalledTimes(2)
		})

		it('should throw when subscribing to non-existent machine', () => {
			expect(() => store.subscribeToMachine('user', vi.fn())).toThrow(StateMachineError)
		})

		it('should throw when listener is not a function', () => {
			expect(() => store.subscribe('not a function' as any)).toThrow(StateMachineError)
		})
	})

	describe('coordinated operations', () => {
		beforeEach(() => {
			store.register('user', userMachine)
			store.register('todos', todosMachine)
			store.register('settings', settingsMachine)
		})

		it('should reset all machines', () => {
			userMachine.mutate(draft => {
				draft.name = 'Changed'
			})
			todosMachine.mutate(draft => {
				draft.items = []
			})
			settingsMachine.mutate(draft => {
				draft.theme = 'light'
			})

			store.resetAll()
			const state = store.getState()
			expect(state.user).toEqual({ name: 'John', email: 'john@example.com' })
			expect(state.todos).toEqual({ items: [{ id: '1', text: 'Test', completed: false }] })
			expect(state.settings).toEqual({ theme: 'dark', notifications: false })
		})

		it('should force save all machines', async () => {
			userMachine.mutate(draft => {
				draft.name = 'Changed'
			})

			await expect(store.forceSaveAll()).resolves.not.toThrow()
		})

		it('should check if any machine has unsaved changes', () => {
			expect(store.hasUnsavedChanges()).toBe(false)

			userMachine.mutate(draft => {
				draft.name = 'Changed'
			})

			expect(store.hasUnsavedChanges()).toBe(true)
		})

		it('should clear history on all machines', () => {
			// Create history
			userMachine.mutate(draft => {
				draft.name = 'Change 1'
			})
			userMachine.mutate(draft => {
				draft.name = 'Change 2'
			})
			todosMachine.mutate(draft => {
				draft.items.push({ id: '2', text: 'New', completed: false })
			})

			expect(userMachine.canUndo()).toBe(true)
			expect(todosMachine.canUndo()).toBe(true)

			store.clearAllHistory()

			expect(userMachine.canUndo()).toBe(false)
			expect(todosMachine.canUndo()).toBe(false)
		})

		it('should destroy all machines and store', () => {
			const listener = vi.fn()
			store.subscribe(listener)

			store.destroyAll()

			expect(() => store.getState()).toThrow(StateMachineError)
			expect(() => userMachine.getState()).toThrow(StateMachineError)
			expect(() => todosMachine.getState()).toThrow(StateMachineError)
		})
	})

	describe('destroyed store', () => {
		it('should throw on operations after destroy', () => {
			store.destroyAll()

			expect(() => store.getState()).toThrow(StateMachineError)
			expect(() => store.register('user', new UserMachine())).toThrow(StateMachineError)
			expect(() => store.subscribe(vi.fn())).toThrow(StateMachineError)
			expect(() => store.resetAll()).toThrow(StateMachineError)
		})

		it('should handle multiple destroy calls gracefully', () => {
			store.destroyAll()
			expect(() => store.destroyAll()).not.toThrow()
		})
	})
})

describe('StateMachine.reset()', () => {
	it('should reset state to initial state', () => {
		const initialState = { name: 'John', email: 'john@example.com' }
		const machine = new UserMachine(initialState)

		machine.mutate(draft => {
			draft.name = 'Jane'
			draft.email = 'jane@example.com'
		})

		expect(machine.getState()).toEqual({ name: 'Jane', email: 'jane@example.com' })

		machine.reset()

		expect(machine.getState()).toEqual(initialState)
	})

	it('should clear history on reset', () => {
		const machine = new UserMachine()

		machine.mutate(draft => {
			draft.name = 'Change 1'
		})
		machine.mutate(draft => {
			draft.name = 'Change 2'
		})

		expect(machine.canUndo()).toBe(true)

		machine.reset()

		expect(machine.canUndo()).toBe(false)
	})

	it('should notify listeners on reset', async () => {
		const machine = new UserMachine({ name: 'John', email: 'john@example.com' })
		const listener = vi.fn()

		machine.subscribe(listener)
		expect(listener).toHaveBeenCalledTimes(1)

		machine.mutate(draft => {
			draft.name = 'Jane'
		})

		await waitForNotification()

		expect(listener).toHaveBeenCalledTimes(2)

		machine.reset()

		await waitForNotification()

		expect(listener).toHaveBeenCalledTimes(3)
		expect(listener).toHaveBeenLastCalledWith({ name: 'John', email: 'john@example.com' })
	})

	it('should return initial state via getInitialState()', () => {
		const initialState = { name: 'John', email: 'john@example.com' }
		const machine = new UserMachine(initialState)

		machine.mutate(draft => {
			draft.name = 'Changed'
		})

		expect(machine.getInitialState()).toEqual(initialState)
		expect(machine.getState()).not.toEqual(initialState)
	})

	it('should throw when reset called on destroyed machine', () => {
		const machine = new UserMachine()
		machine.destroy()

		expect(() => machine.reset()).toThrow(StateMachineError)
	})
})
