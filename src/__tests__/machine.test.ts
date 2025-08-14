/*
 *   IMPORTS
 ***************************************************************************************************/
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StateMachine, StateMachineError, StateValidationError } from '../machine'

/*
 *   TYPES
 ***************************************************************************************************/
interface TestState {
	count: number
	todos: { id: string; text: string; completed: boolean }[]
	user: { name: string } | null
}

/*
 *   TEST CLASS
 ***************************************************************************************************/
class TestStateMachine extends StateMachine<TestState> {
	constructor(
		config: Partial<{
			initialState: TestState
			enableLogging?: boolean
			persistenceKey?: string
			validateState?: (state: TestState) => boolean
		}> = {}
	) {
		super({
			initialState: config.initialState !== undefined ? config.initialState : {
				count: 0,
				todos: [],
				user: null,
			},
			enableLogging: config.enableLogging || false,
			persistenceKey: config.persistenceKey,
			validateState: config.validateState,
		})
	}

	protected async saveToServer(): Promise<void> {
		// No-op for tests
	}

	protected async loadFromServer(): Promise<TestState | null> {
		return null
	}
}

/*
 *   TESTS
 ***************************************************************************************************/
describe('StateMachine', () => {
	let stateMachine: TestStateMachine

	beforeEach(() => {
		vi.clearAllMocks()
		stateMachine = new TestStateMachine()
	})

	describe('initialization', () => {
		it('should initialize with provided state', () => {
			const initialState = { count: 5, todos: [], user: { name: 'John' } }
			const machine = new TestStateMachine({ initialState })

			expect(machine.getState()).toEqual(initialState)
		})

		it('should throw error for invalid initial state', () => {
			expect(() => new TestStateMachine({ initialState: null as any })).toThrow(
				StateValidationError
			)
		})
	})

	describe('state management', () => {
		it('should update state immutably', () => {
			const originalState = stateMachine.getState()

			stateMachine.mutate(draft => {
				draft.count = 10
			})

			const newState = stateMachine.getState()
			expect(newState.count).toBe(10)
			expect(originalState.count).toBe(0)
			expect(originalState).not.toBe(newState)
		})

		it('should handle nested object mutations', () => {
			stateMachine.mutate(draft => {
				draft.user = { name: 'Alice' }
			})

			stateMachine.mutate(draft => {
				if (draft.user) {
					draft.user.name = 'Bob'
				}
			})

			expect(stateMachine.getState().user?.name).toBe('Bob')
		})

		it('should handle array mutations', () => {
			const newTodo = { id: '1', text: 'Test todo', completed: false }

			stateMachine.mutate(draft => {
				draft.todos.push(newTodo)
			})

			expect(stateMachine.getState().todos).toHaveLength(1)
			expect(stateMachine.getState().todos[0]).toEqual(newTodo)
		})
	})

	describe('subscriptions', () => {
		it('should notify subscribers on state change', async () => {
			const listener = vi.fn()
			const unsubscribe = stateMachine.subscribe(listener)

			expect(listener).toHaveBeenCalledWith(stateMachine.getState())

			stateMachine.mutate(draft => {
				draft.count = 5
			})

			// Wait for debounced notification
			await new Promise(resolve => setTimeout(resolve, 20))

			expect(listener).toHaveBeenCalledTimes(2)
			expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ count: 5 }))

			unsubscribe()
			stateMachine.mutate(draft => {
				draft.count = 10
			})

			expect(listener).toHaveBeenCalledTimes(2)
		})

		it('should handle subscriber errors gracefully', () => {
			const errorListener = vi.fn().mockImplementation(() => {
				throw new Error('Listener error')
			})
			const normalListener = vi.fn()

			stateMachine.subscribe(errorListener)
			stateMachine.subscribe(normalListener)

			stateMachine.mutate(draft => {
				draft.count = 1
			})

			expect(normalListener).toHaveBeenCalled()
		})
	})

	describe('undo/redo functionality', () => {
		it('should support undo operation', () => {
			const initialState = stateMachine.getState()

			stateMachine.mutate(draft => {
				draft.count = 5
			})

			const success = stateMachine.undo()

			expect(success).toBe(true)
			expect(stateMachine.getState()).toEqual(initialState)
		})

		it('should support redo operation', () => {
			stateMachine.mutate(draft => {
				draft.count = 5
			})

			const stateAfterMutation = stateMachine.getState()
			stateMachine.undo()

			const success = stateMachine.redo()

			expect(success).toBe(true)
			expect(stateMachine.getState()).toEqual(stateAfterMutation)
		})

		it('should return false when undo is not possible', () => {
			const success = stateMachine.undo()
			expect(success).toBe(false)
		})

		it('should return false when redo is not possible', () => {
			const success = stateMachine.redo()
			expect(success).toBe(false)
		})

		it('should provide correct history info', () => {
			const info = stateMachine.getHistoryInfo()
			expect(info.canUndo).toBe(false)
			expect(info.canRedo).toBe(false)
			expect(info.historyLength).toBe(0)

			stateMachine.mutate(draft => {
				draft.count = 1
			}, 'Increment count')

			const infoAfter = stateMachine.getHistoryInfo()
			expect(infoAfter.canUndo).toBe(true)
			expect(infoAfter.canRedo).toBe(false)
			expect(infoAfter.historyLength).toBe(1)
			expect(infoAfter.lastAction).toBe('Increment count')
		})
	})

	describe('batch operations', () => {
		it('should execute multiple mutations as one history entry', () => {
			stateMachine.batch(
				[
					draft => {
						draft.count = 5
					},
					draft => {
						draft.todos.push({ id: '1', text: 'Test', completed: false })
					},
					draft => {
						draft.user = { name: 'Alice' }
					},
				],
				'Batch operation'
			)

			const state = stateMachine.getState()
			expect(state.count).toBe(5)
			expect(state.todos).toHaveLength(1)
			expect(state.user?.name).toBe('Alice')

			const historyInfo = stateMachine.getHistoryInfo()
			expect(historyInfo.historyLength).toBe(1)

			const success = stateMachine.undo()
			expect(success).toBe(true)

			const undoneState = stateMachine.getState()
			expect(undoneState.count).toBe(0)
			expect(undoneState.todos).toHaveLength(0)
			expect(undoneState.user).toBeNull()
		})

		it('should handle empty batch gracefully', () => {
			const listener = vi.fn()
			stateMachine.subscribe(listener)

			const initialCallCount = listener.mock.calls.length
			stateMachine.batch([])

			expect(listener).toHaveBeenCalledTimes(initialCallCount)
		})
	})

	describe('history management', () => {
		it('should clear history', () => {
			stateMachine.mutate(draft => {
				draft.count = 1
			})
			stateMachine.mutate(draft => {
				draft.count = 2
			})

			expect(stateMachine.getHistoryInfo().historyLength).toBe(2)

			stateMachine.clearHistory()

			const info = stateMachine.getHistoryInfo()
			expect(info.historyLength).toBe(0)
			expect(info.canUndo).toBe(false)
			expect(info.canRedo).toBe(false)
		})

		it('should limit history size', () => {
			const machine = new TestStateMachine({
				initialState: { count: 0, todos: [], user: null },
			})

			for (let i = 0; i < 60; i++) {
				machine.mutate(draft => {
					draft.count = i
				})
			}

			const info = machine.getHistoryInfo()
			expect(info.historyLength).toBeLessThanOrEqual(50)
		})
	})

	describe('error handling', () => {
		it('should throw error for invalid recipe', () => {
			expect(() => {
				stateMachine.mutate('not a function' as any)
			}).toThrow(StateValidationError)
		})

		it('should throw error for invalid listener', () => {
			expect(() => {
				stateMachine.subscribe('not a function' as any)
			}).toThrow(StateValidationError)
		})

		it('should prevent operations on destroyed machine', () => {
			stateMachine.destroy()

			expect(() => stateMachine.getState()).toThrow(StateMachineError)
			expect(() =>
				stateMachine.mutate(draft => {
					draft.count = 1
				})
			).toThrow(StateMachineError)
		})
	})

	describe('persistence', () => {
		it('should handle unsaved changes flag', () => {
			expect(stateMachine.hasUnsavedChanges()).toBe(false)

			stateMachine.mutate(draft => {
				draft.count = 1
			})

			expect(stateMachine.hasUnsavedChanges()).toBe(true)
		})

		it('should handle force save', async () => {
			stateMachine.mutate(draft => {
				draft.count = 1
			})

			expect(stateMachine.hasUnsavedChanges()).toBe(true)

			await stateMachine.forceSave()

			expect(stateMachine.hasUnsavedChanges()).toBe(false)
		})
	})

	describe('validation', () => {
		it('should use custom validation function', () => {
			const validateState = vi.fn().mockReturnValue(true)

			const machine = new TestStateMachine({
				initialState: { count: 0, todos: [], user: null },
				validateState,
			})

			machine.mutate(draft => {
				draft.count = 5
			})

			expect(validateState).toHaveBeenCalled()
		})

		it('should throw error on validation failure', () => {
			class ValidatingTestMachine extends TestStateMachine {
				constructor() {
					super({
						initialState: { count: 0, todos: [], user: null },
					})
				}

				protected validateState(state: TestState): void {
					if (state.count < 0) {
						throw new StateValidationError('Count cannot be negative')
					}
				}
			}

			const machine = new ValidatingTestMachine()

			expect(() => {
				machine.mutate(draft => {
					draft.count = -1
				})
			}).toThrow(StateValidationError)
		})
	})
})
