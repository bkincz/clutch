import { vi } from 'vitest'

/*
 *   MOCKS
 ***************************************************************************************************/
const localStorageMock = {
	getItem: vi.fn(),
	setItem: vi.fn(),
	removeItem: vi.fn(),
	clear: vi.fn(),
	length: 0,
	key: vi.fn(),
}

Object.defineProperty(window, 'localStorage', {
	value: localStorageMock,
})

global.console = {
	...console,
	log: vi.fn(),
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
}
