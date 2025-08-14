/// <reference types="vitest" />
import { defineConfig } from 'vite'

export default defineConfig({
	test: {
		globals: true,
		environment: 'jsdom',
		setupFiles: ['./src/__tests__/setup.ts'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'html'],
			exclude: [
				'node_modules/',
				'dist/',
				'**/*.d.ts',
				'**/*.config.ts',
				'**/*.test.ts',
				'**/*.test.tsx',
				'**/setup.ts',
			],
		},
		include: ['src/**/*.{test,spec}.{ts,tsx}'],
	},
	resolve: {
		alias: {
			'@': '/src',
		},
	},
})
