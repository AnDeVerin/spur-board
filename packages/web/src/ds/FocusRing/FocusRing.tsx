import styles from './FocusRing.module.css';

/**
 * Class for a focusable screen element the design system has no component for, such as a card
 * link: it shows the one ds focus ring on `:focus-visible`. A screen never defines its own ring.
 * A local class, not a global one: Vite treats CSS Modules as side-effect free, so its rule ships
 * only with a bundle that reads `focusRing`.
 */
export const focusRing: string = styles.focusRing ?? '';
