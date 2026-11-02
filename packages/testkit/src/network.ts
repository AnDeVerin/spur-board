import net from 'node:net';

type Connect = (this: net.Socket, ...args: unknown[]) => net.Socket;

interface Target {
  host?: string | null;
  path?: string | null;
}

const GUARDED = Symbol.for('spur-board.testkit.network-guard');

export class NetworkBlockedError extends Error {
  readonly code = 'ERR_TEST_NETWORK_BLOCKED';
  override readonly name = 'NetworkBlockedError';

  constructor(host: string) {
    super(
      `Network access to "${host}" is blocked in tests. Start a server on 127.0.0.1 or pass a fake instead.`,
    );
  }
}

export function isLocalHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === '' || h === 'localhost' || h.endsWith('.localhost')) return true;
  if (net.isIPv4(h)) return h.startsWith('127.');
  return h === '::1' || h === '::ffff:127.0.0.1';
}

// Socket#connect is called as connect(options), connect(path), connect(port, host)
// or, from net.connect, with the normalized [options, callback] array.
function targetOf(args: unknown[]): Target {
  const first: unknown = args[0];
  const options: unknown = Array.isArray(first) ? first[0] : first;
  if (typeof options === 'object' && options !== null) return options;
  if (typeof first === 'string' && !/^\d+$/.test(first)) return { path: first };
  return { host: typeof args[1] === 'string' ? args[1] : null };
}

const CHECKED = Symbol('spur-board.testkit.lookup-checked');

// A local name can still resolve to a remote address (custom `lookup`, hosts file).
// Node emits 'lookup' after resolving each address and before connecting, and stops
// when the socket is no longer connecting, so destroying it here blocks the connection.
function checkResolved(socket: net.Socket, host: string): void {
  const marked = socket as net.Socket & { [CHECKED]?: true };
  if (marked[CHECKED]) return;
  marked[CHECKED] = true;
  // A custom lookup's error reaches here unnormalized; Node connects on any falsy one.
  socket.on('lookup', (error: Error | null | undefined, address: string) => {
    if (error == null && !(net.isIP(address) !== 0 && isLocalHost(address))) {
      socket.destroy(new NetworkBlockedError(`${host} (${address})`));
    }
  });
}

/**
 * Blocks every socket connection to a non-localhost host in this process. fetch,
 * http, https, tls, http2 and net all connect through Socket#connect.
 */
export function installNetworkGuard(): void {
  const proto = net.Socket.prototype as unknown as Record<PropertyKey, unknown>;
  const original = proto['connect'] as Connect;
  if (GUARDED in original) return;

  const guarded: Connect = function (this: net.Socket, ...args: unknown[]) {
    const { host, path } = targetOf(args);
    // Node treats `path: ''` and `path: null` (http, tls) as TCP; only a nonempty path is IPC.
    if (typeof path === 'string' && path !== '') return original.apply(this, args);
    const name = host ?? '';
    if (!isLocalHost(name)) {
      const error = new NetworkBlockedError(name);
      process.nextTick(() => this.destroy(error));
      return this;
    }
    if (net.isIP(name.replace(/^\[|\]$/g, '')) === 0) checkResolved(this, name);
    return original.apply(this, args);
  };
  Object.defineProperty(guarded, GUARDED, { value: true });
  proto['connect'] = guarded;
}
