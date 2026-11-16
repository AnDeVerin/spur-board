import styles from './Quiet.module.css';

/**
 * Class for a quiet container: its tertiary text reads secondary while the container is hovered
 * or holds focus, and always on devices without hover. A local class, not a global one: Vite
 * treats CSS Modules as side-effect free, so its rules ship only with a bundle that reads `quiet`.
 */
export const quiet: string = styles.quiet ?? '';
