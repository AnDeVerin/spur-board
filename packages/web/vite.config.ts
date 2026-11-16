import { defineConfig } from 'vite';

export default defineConfig({
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
