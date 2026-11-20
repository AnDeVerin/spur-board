import {
  browserOperations,
  successEnvelopeSchema,
  problemSchema,
} from '@spur-board/contracts/browser';
import type { z } from 'zod';

type OperationId = keyof typeof browserOperations;
type Operation<K extends OperationId> = (typeof browserOperations)[K];
type Input<K extends OperationId> = z.input<Operation<K>['input']>;
/** What the browser reads: the operation's `read` schema when it has one, else its `output`. */
export type Output<K extends OperationId> = z.output<
  Operation<K> extends { read: z.ZodType } ? Operation<K>['read'] : Operation<K>['output']
>;
type ProblemCode = z.output<typeof problemSchema>['code'];
/** A daemon problem answer: the message as the error's, and its stable code. */
export class ProblemError extends Error {
  readonly code: ProblemCode;
  constructor(message: string, code: ProblemCode) {
    super(message);
    this.name = 'ProblemError';
    this.code = code;
  }
}
/**
 * A 2xx daemon answer that does not match the schema this page expects; the daemon answered, so
 * it is not down. Browser-side only, never on the wire.
 */
export class UnreadableAnswerError extends Error {
  constructor(cause: unknown) {
    super("The board daemon's answer could not be read.", { cause });
    this.name = 'UnreadableAnswerError';
  }
}
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
      throw new ProblemError(problem.message, problem.code);
    }
    const entry: { output: z.ZodType; read?: z.ZodType } = operation;
    try {
      return (entry.read ?? entry.output).parse(
        successEnvelopeSchema.parse(value).value,
      ) as Output<K>;
    } catch (error) {
      throw new UnreadableAnswerError(error);
    }
  };
}
/** Own one instance per user intent. Retry uncertain outcomes on this same instance. */
export function createMutationIntent<
  K extends
    | 'comment.add'
    | 'block.answer'
    | 'block.followup'
    | 'item.close'
    | 'inbox.ack'
    | 'task.submit'
    | 'task.return',
>(
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
/**
 * Serialize one read, retaining exactly one trailing refresh while a read is pending. A failed
 * read publishes its rejection reason as `cause`.
 */
export function coordinateRead<T>(
  read: (signal: AbortSignal) => Promise<T>,
  publish: (value: T | undefined, error: boolean, cause?: unknown) => void,
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
        (reason: unknown) => {
          if (!stopped) publish(undefined, true, reason);
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
