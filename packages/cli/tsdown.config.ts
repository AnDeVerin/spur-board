import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { bin: './src/bin.mjs', client: './src/client.ts' },
  format: 'esm',
  dts: false,
  deps: { alwaysBundle: ['@spur-board/contracts'] },
  outDir: './dist',
});
