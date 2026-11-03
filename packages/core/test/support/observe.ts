// Wraps #45's fake gateway (and stands in for Spur) to add what the fake lacks: a request log,
// a probe that `deliver`/`send` run outside any store transaction, a rejection and a crash. It
// never makes up a `DeliveryResult`: `deliver` returns the fake's own result or rejects.
import type { DeliverRequest, DeliveryResult, Gateway } from '@spur-board/contracts';
import type { FakeGateway } from '@spur-board/gateway-testkit';
import Database from 'better-sqlite3';
import type { Store } from '../../src/index.ts';
import type { SpurPort } from '../../src/index.ts';

/** Records a violation when another connection holds the write lock on `file`. */
function probe(file: string, violations: string[], what: string): void {
  const db = new Database(file, { timeout: 0 });
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec('ROLLBACK');
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'SQLITE_BUSY') throw error;
    violations.push(`${what} called inside a store transaction`);
  } finally {
    db.close();
  }
}

type Crash = { store: Store; when: 'before' | 'after' };

export interface ObservedGateway {
  gateway: Gateway;
  requests: DeliverRequest[];
  violations: string[];
  /** The next `deliver` rejects without reaching the fake, as a crashed adapter call would. */
  throwNext(message?: string): void;
  /** The next `deliver` closes `store` and rejects, before or after the fake posts. */
  crashNext(crash: Crash): void;
}

export function observeGateway(inner: FakeGateway, file: string): ObservedGateway {
  const requests: DeliverRequest[] = [];
  const violations: string[] = [];
  let throwing: string | undefined;
  let crash: Crash | undefined;
  const gateway: Gateway = {
    kind: inner.kind,
    capabilities: inner.capabilities,
    start: (sink) => inner.start(sink),
    stop: () => inner.stop(),
    recover: (request) => inner.recover(request),
    respond: (interaction, text, options) => inner.respond(interaction, text, options),
    async deliver(request): Promise<DeliveryResult> {
      probe(file, violations, 'deliver');
      requests.push(request);
      if (throwing !== undefined) {
        const message = throwing;
        throwing = undefined;
        throw new Error(message);
      }
      const armed = crash;
      crash = undefined;
      if (armed === undefined) return inner.deliver(request);
      if (armed.when === 'after') await inner.deliver(request);
      await armed.store.close();
      throw new Error(`crash ${armed.when} deliver`);
    },
  };
  return {
    gateway,
    requests,
    violations,
    throwNext(message = 'deliver threw') {
      throwing = message;
    },
    crashNext(next) {
      crash = next;
    },
  };
}

export interface ObservedSpur {
  spur: SpurPort;
  sends: [session: string, text: string][];
  violations: string[];
  throwNext(message?: string): void;
  /** The next `send` is recorded as sent, then closes `store` and rejects. */
  crashNext(store: Store): void;
}

export function observeSpur(file: string): ObservedSpur {
  const sends: [string, string][] = [];
  const violations: string[] = [];
  let throwing: string | undefined;
  let crash: Store | undefined;
  return {
    spur: {
      async send(session, text) {
        probe(file, violations, 'send');
        if (throwing !== undefined) {
          const message = throwing;
          throwing = undefined;
          throw new Error(message);
        }
        sends.push([session, text]);
        const armed = crash;
        crash = undefined;
        if (armed !== undefined) {
          await armed.close();
          throw new Error('crash after send');
        }
      },
    },
    sends,
    violations,
    throwNext(message = 'send threw') {
      throwing = message;
    },
    crashNext(store) {
      crash = store;
    },
  };
}
