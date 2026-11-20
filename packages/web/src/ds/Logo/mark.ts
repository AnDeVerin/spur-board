/**
 * Geometry of the Spur mark, shared by `Logo.tsx` and the Vite icon plugin
 * (`packages/web/build/app-icons.ts`), which draws the favicon and app icons from it. No imports,
 * so Node can load it while the Vite config loads. Stroke width is the `--stroke-icon` token.
 */
export const MARK_VIEWBOX = 16;
export const MARK_FRAME = { x: 1.5, y: 1.5, width: 13, height: 13 } as const;
export const MARK_PATH = 'M8 4.2v7.6M4.7 6.1l6.6 3.8M11.3 6.1L4.7 9.9';
export const MARK_LINECAP = 'square';
