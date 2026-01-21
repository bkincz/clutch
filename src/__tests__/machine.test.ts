/*
 *   IMPORTS
 ***************************************************************************************************/
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
	StateMachine,
	StateMachineError,
	StateValidationError,
	type AfterMutatePayload,
	type ErrorPayload,
	type DestroyPayload,
} from '../machine'

/*
 *   TYPES
 ***************************************************************************************************/
interface TestState {
	count: number
	todos: { id: string; text: string; completed: boolean }[]
	user: { name: string } | null
}

/*
 *   TEST HELPERS
 ***************************************************************************************************/
function defined<T>(value: T | null | undefined, message?: string): T {
	expect(value, message).toBeDefined()
	expect(value, message).not.toBeNull()
	// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
	return value!
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
			initialState:
				config.initialState !== undefined
					? config.initialState
					: {
							count: 0,
							todos: [],
							user: null,
						},
			enableLogging: config.enableLogging || false,
			persistenceKey: config.persistenceKey,
			validateState: config.validateState,
		})
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

	describe('lifecycle events', () => {
		describe('on() method', () => {
			it('should register and unregister event listeners', () => {
				const listener = vi.fn()
				const unsubscribe = stateMachine.on('afterMutate', listener)

				stateMachine.mutate(draft => {
					draft.count = 1
				})

				expect(listener).toHaveBeenCalledTimes(1)

				unsubscribe()

				stateMachine.mutate(draft => {
					draft.count = 2
				})

				expect(listener).toHaveBeenCalledTimes(1)
			})

			it('should throw error when registering on destroyed machine', () => {
				stateMachine.destroy()

				expect(() => {
					stateMachine.on('afterMutate', vi.fn())
				}).toThrow(StateMachineError)
			})

			it('should support multiple listeners for same event', () => {
				const listener1 = vi.fn()
				const listener2 = vi.fn()

				stateMachine.on('afterMutate', listener1)
				stateMachine.on('afterMutate', listener2)

				stateMachine.mutate(draft => {
					draft.count = 1
				})

				expect(listener1).toHaveBeenCalledTimes(1)
				expect(listener2).toHaveBeenCalledTimes(1)
			})

			it('should handle listener errors gracefully without affecting other listeners', () => {
				const errorListener = vi.fn().mockImplementation(() => {
					throw new Error('Listener error')
				})
				const normalListener = vi.fn()

				stateMachine.on('afterMutate', errorListener)
				stateMachine.on('afterMutate', normalListener)

				stateMachine.mutate(draft => {
					draft.count = 1
				})

				expect(errorListener).toHaveBeenCalled()
				expect(normalListener).toHaveBeenCalled()
			})
		})

		describe('afterMutate event', () => {
			it('should emit afterMutate with correct payload on mutate()', () => {
				let capturedPayload: AfterMutatePayload<TestState> | null = null
				stateMachine.on('afterMutate', payload => {
					capturedPayload = payload
				})

				stateMachine.mutate(draft => {
					draft.count = 5
				}, 'Increment count')

				const payload = defined<AfterMutatePayload<TestState>>(
					capturedPayload,
					'Expected afterMutate to be emitted'
				)
				expect(payload.state.count).toBe(5)
				expect(payload.operation).toBe('mutate')
				expect(payload.description).toBe('Increment count')
				expect(payload.patches.length).toBeGreaterThan(0)
				expect(payload.inversePatches.length).toBeGreaterThan(0)
			})

			it('should emit afterMutate with correct payload on batch()', () => {
				let capturedPayload: AfterMutatePayload<TestState> | null = null
				stateMachine.on('afterMutate', payload => {
					capturedPayload = payload
				})

				stateMachine.batch(
					[
						draft => {
							draft.count = 5
						},
						draft => {
							draft.user = { name: 'Alice' }
						},
					],
					'Batch update'
				)

				const payload = defined<AfterMutatePayload<TestState>>(
					capturedPayload,
					'Expected afterMutate to be emitted'
				)
				expect(payload.state.count).toBe(5)
				expect(payload.state.user?.name).toBe('Alice')
				expect(payload.operation).toBe('batch')
				expect(payload.description).toBe('Batch update')
			})

			it('should emit afterMutate with correct payload on undo()', () => {
				stateMachine.mutate(draft => {
					draft.count = 5
				}, 'Increment')

				let capturedPayload: AfterMutatePayload<TestState> | null = null
				stateMachine.on('afterMutate', payload => {
					capturedPayload = payload
				})

				stateMachine.undo()

				const payload = defined<AfterMutatePayload<TestState>>(
					capturedPayload,
					'Expected afterMutate to be emitted'
				)
				expect(payload.state.count).toBe(0)
				expect(payload.operation).toBe('undo')
				expect(payload.description).toBe('Increment')
			})

			it('should emit afterMutate with correct payload on redo()', () => {
				stateMachine.mutate(draft => {
					draft.count = 5
				}, 'Increment')

				stateMachine.undo()

				let capturedPayload: AfterMutatePayload<TestState> | null = null
				stateMachine.on('afterMutate', payload => {
					capturedPayload = payload
				})

				stateMachine.redo()

				const payload = defined<AfterMutatePayload<TestState>>(
					capturedPayload,
					'Expected afterMutate to be emitted'
				)
				expect(payload.state.count).toBe(5)
				expect(payload.operation).toBe('redo')
				expect(payload.description).toBe('Increment')
			})

			it('should not emit afterMutate when mutation produces no changes', () => {
				let called = false
				stateMachine.on('afterMutate', () => {
					called = true
				})

				stateMachine.mutate(() => {
					// No changes
				})

				expect(called).toBe(false)
			})
		})

		describe('error event', () => {
			it('should emit error event on mutate failure', () => {
				class ValidatingMachine extends TestStateMachine {
					constructor() {
						super({ initialState: { count: 0, todos: [], user: null } })
					}

					protected validateState(state: TestState): void {
						if (state.count < 0) {
							throw new StateValidationError('Count cannot be negative')
						}
					}
				}

				const machine = new ValidatingMachine()
				let capturedPayload: ErrorPayload | null = null
				machine.on('error', payload => {
					capturedPayload = payload
				})

				expect(() => {
					machine.mutate(draft => {
						draft.count = -1
					})
				}).toThrow()

				const payload = defined<ErrorPayload>(
					capturedPayload,
					'Expected error to be emitted'
				)
				expect(payload.operation).toBe('mutate')
				expect(payload.error).toBeInstanceOf(Error)
			})

			it('should emit error event on batch failure', () => {
				let capturedPayload: ErrorPayload | null = null
				stateMachine.on('error', payload => {
					capturedPayload = payload
				})

				expect(() => {
					stateMachine.batch([
						'not a function' as any, // Invalid mutation
					])
				}).toThrow()

				const payload = defined<ErrorPayload>(
					capturedPayload,
					'Expected error to be emitted'
				)
				expect(payload.operation).toBe('batch')
			})
		})

		describe('destroy event', () => {
			it('should emit destroy event with final state before cleanup', () => {
				stateMachine.mutate(draft => {
					draft.count = 42
					draft.user = { name: 'Final User' }
				})

				let capturedPayload: DestroyPayload<TestState> | null = null
				stateMachine.on('destroy', payload => {
					capturedPayload = payload
				})

				stateMachine.destroy()

				const payload = defined<DestroyPayload<TestState>>(
					capturedPayload,
					'Expected destroy to be emitted'
				)
				expect(payload.finalState.count).toBe(42)
				expect(payload.finalState.user?.name).toBe('Final User')
			})

			it('should not emit destroy event on subsequent destroy calls', () => {
				const listener = vi.fn()
				stateMachine.on('destroy', listener)

				stateMachine.destroy()
				stateMachine.destroy()

				expect(listener).toHaveBeenCalledTimes(1)
			})
		})

		describe('zero-cost when unused', () => {
			it('should not create eventListeners map until first listener is added', () => {
				// Perform mutations without any lifecycle listeners
				stateMachine.mutate(draft => {
					draft.count = 1
				})
				stateMachine.mutate(draft => {
					draft.count = 2
				})
				stateMachine.undo()
				stateMachine.redo()

				// Access protected property for testing (this is a white-box test)
				const machine = stateMachine as unknown as {
					eventListeners: Map<string, Set<unknown>> | null
				}
				expect(machine.eventListeners).toBeNull()

				// Now add a listener
				stateMachine.on('afterMutate', vi.fn())

				expect(machine.eventListeners).not.toBeNull()
			})

			it('should clean up eventListeners map when all listeners are removed', () => {
				const machine = stateMachine as unknown as {
					eventListeners: Map<string, Set<unknown>> | null
				}

				// Add listeners
				const unsub1 = stateMachine.on('afterMutate', vi.fn())
				const unsub2 = stateMachine.on('error', vi.fn())

				expect(machine.eventListeners).not.toBeNull()
				expect(machine.eventListeners?.size).toBe(2)

				// Remove one listener type completely
				unsub1()
				expect(machine.eventListeners?.size).toBe(1)

				// Remove the last listener
				unsub2()
				expect(machine.eventListeners).toBeNull()
			})

			it('should handle multiple listeners for the same event during cleanup', () => {
				const machine = stateMachine as unknown as {
					eventListeners: Map<string, Set<unknown>> | null
				}

				const unsub1 = stateMachine.on('afterMutate', vi.fn())
				const unsub2 = stateMachine.on('afterMutate', vi.fn())

				expect(machine.eventListeners?.get('afterMutate')?.size).toBe(2)

				unsub1()
				expect(machine.eventListeners?.get('afterMutate')?.size).toBe(1)
				expect(machine.eventListeners).not.toBeNull()

				unsub2()
				expect(machine.eventListeners).toBeNull()
			})
		})
	})
})
