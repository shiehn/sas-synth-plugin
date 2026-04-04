import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['index.ts'],
  format: ['cjs'],
  dts: false,
  sourcemap: false,
  clean: true,
  external: ['react', 'react-dom', '@signalsandsorcery/plugin-sdk'],
  jsx: 'automatic',
});
