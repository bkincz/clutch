import { vi } from 'vitest'

/*
 *   POLYFILLS
 ***************************************************************************************************/
// Add crypto.getRandomValues polyfill for Node.js
if (!globalThis.crypto) {
	try {
		// Try modern Node.js crypto
		const { webcrypto } = require('node:crypto')
		globalThis.crypto = webcrypto
	} catch {
		// Fallback for older Node.js versions or different environments
		const crypto = require('crypto')
		globalThis.crypto = {
			getRandomValues: (arr: any) => {
				const bytes = crypto.randomBytes(arr.length)
				arr.set(bytes)
				return arr
			},
		} as Crypto
	}
}

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
