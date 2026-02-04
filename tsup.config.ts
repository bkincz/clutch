import { defineConfig } from 'tsup'

export default defineConfig({
	entry: {
		index: 'src/index.ts',
		react: 'src/integrations/react/index.ts',
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
		options.drop = ['console', 'debugger']
		options.legalComments = 'none'
		options.mangleProps = /^_/
	},
	terserOptions: {
		compress: {
			drop_console: true,
			drop_debugger: true,
			pure_funcs: ['console.log', 'console.warn', 'console.info'],
			passes: 2,
		},
		mangle: {
			properties: {
				regex: /^_/,
			},
		},
	},
})
