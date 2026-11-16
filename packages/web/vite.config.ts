import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const manifest = JSON.parse(
  readFileSync(new URL('../cli/package.json', import.meta.url), 'utf8'),
) as { version: string };
export default defineConfig({
  define: { __BOARD_VERSION__: JSON.stringify(manifest.version) },
  build: {
    sourcemap: false,
    assetsInlineLimit: 0,
    rolldownOptions: {
      plugins: [
        {
          name: 'browser-boundary',
          generateBundle() {
            const modules = [...this.getModuleIds()];
            if (modules.some((id) => /packages\/(?:core|daemon)\/|ops\/catalog\.ts/.test(id))) {
              throw new Error('Server or operation catalog module reached the browser bundle.');
            }
            this.info(
              `Browser boundary verified: ${String(modules.length)} modules, no catalog/core/daemon.`,
            );
          },
        },
      ],
    },
  },
});
