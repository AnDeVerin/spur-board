import {
  browserOperations,
  successEnvelopeSchema,
  problemSchema,
} from '@spur-board/contracts/browser';
import type { z } from 'zod';

type OperationId = keyof typeof browserOperations;
type Input<K extends OperationId> = z.input<(typeof browserOperations)[K]['input']>;
export type Output<K extends OperationId> = z.output<(typeof browserOperations)[K]['output']>;
/** Schema validation belongs on both sides of the transport boundary. */
export function createApi(fetcher: typeof fetch = fetch) {
  return async <K extends OperationId>(
    id: K,
    input: Input<K>,
    options: { signal?: AbortSignal; key?: string } = {},
  ): Promise<Output<K>> => {
    const operation = browserOperations[id];
    const parsed = operation.input.parse(input);
    const key = operation.kind === 'mutation' ? (options.key ?? crypto.randomUUID()) : undefined;
    const response = await fetcher(`/v1/ops/${id}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        input: parsed,
        ...(key === undefined ? {} : { key }),
      }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const value: unknown = await response.json();
    if (!response.ok) {
      const problem = problemSchema.parse(value);
      throw new Error(problem.message);
    }
    return operation.output.parse(successEnvelopeSchema.parse(value).value) as Output<K>;
  };
}
/** Own one instance per user intent. Retry uncertain outcomes on this same instance. */
export function createMutationIntent<K extends 'comment.add' | 'block.answer'>(
  api: ReturnType<typeof createApi>,
  id: K,
  input: Input<K>,
  uuid: () => string = () => crypto.randomUUID(),
) {
  const key = uuid();
  let pending: Promise<Output<K>> | undefined;
  return {
    run(signal?: AbortSignal): Promise<Output<K>> {
      pending ??= api(id, input, { key, ...(signal === undefined ? {} : { signal }) }).finally(
        () => {
          pending = undefined;
        },
      );
      return pending;
    },
  };
}
/** Serialize one read, retaining exactly one trailing refresh while a read is pending. */
export function coordinateRead<T>(
  read: (signal: AbortSignal) => Promise<T>,
  publish: (value: T | undefined, error: boolean) => void,
) {
  let stopped = false;
  let active: AbortController | undefined;
  let trailing = false;
  const refresh = () => {
    if (stopped) return;
    if (active) {
      trailing = true;
      return;
    }
    const controller = new AbortController();
    active = controller;
    void read(controller.signal)
      .then(
        (value) => {
          if (!stopped) publish(value, false);
        },
        () => {
          if (!stopped) publish(undefined, true);
        },
      )
      .finally(() => {
        active = undefined;
        if (trailing && !stopped) {
          trailing = false;
          refresh();
        }
      });
  };
  return {
    refresh,
    dispose() {
      stopped = true;
      trailing = false;
      active?.abort();
    },
  };
}
