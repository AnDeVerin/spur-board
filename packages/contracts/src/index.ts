/** Exhaustiveness check: call it in the `default` branch of a switch over a union. */
export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
}
export * from './enums.ts';
export * from './config.ts';
