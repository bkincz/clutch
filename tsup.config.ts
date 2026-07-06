import { defineConfig } from 'tsup'

export default defineConfig({
	entry: {
		index: 'src/index.ts',
		react: 'src/react.ts',
		'sync-ws': 'src/transports/websocket.ts',
	},
	format: ['cjs', 'esm'],
	dts: true,
	splitting: false,
	sourcemap: true,
	clean: true,
	minify: 'terser',
	treeshake: 'recommended',
	external: ['react', 'immer'],
	outDir: 'dist',
	target: 'es2020',
	esbuildOptions(options) {
		// Keep console.error/warn: core's emitError falls back to console.error
		// when no onError plugin is installed, so dropping it would swallow
		// unhandled plugin errors in production builds
		options.drop = ['debugger']
		options.legalComments = 'none'
		options.mangleProps = /^_/
	},
	terserOptions: {
		compress: {
			drop_debugger: true,
			pure_funcs: ['console.log', 'console.info', 'console.debug'],
			passes: 2,
		},
		mangle: {
			properties: {
				regex: /^_/,
			},
		},
	},
})
