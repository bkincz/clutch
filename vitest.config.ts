module.exports = {
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
				'**/*.config.*',
				'**/*.test.*',
				'**/setup.ts',
			],
		},
		include: ['src/**/*.{test,spec}.{ts,tsx}'],
	},
	define: {
		global: 'globalThis',
	},
}
