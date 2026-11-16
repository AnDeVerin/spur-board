import { z } from 'zod';

export type StreamState = 'live' | 'reconnecting' | 'offline';
export interface RefreshScope {
  projects: string[];
  tasks: string[];
}
const helloSchema = z.object({ head: z.number().int().nonnegative(), instance: z.string().min(1) });
const scopeSchema = z.object({
  projects: z.array(z.string()).optional(),
  tasks: z.array(z.string()).optional(),
});
interface StreamOptions {
  fetch?: typeof fetch;
  state: (value: StreamState) => void;
  refresh: (scope: RefreshScope | null) => void;
}
/** Fetch keeps reconnect policy and cancellation under this client's ownership. */
export function connectStream(options: StreamOptions) {
  const fetcher = options.fetch ?? fetch;
  let stopped = false;
  const isStopped = () => stopped;
  let connection: AbortController | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let lastId = '';
  let hello: z.output<typeof helloSchema> | undefined;
  const projects = new Set<string>();
  const tasks = new Set<string>();
  const clearScopes = () => {
    clearTimeout(debounce);
    debounce = undefined;
    projects.clear();
    tasks.clear();
  };
  const fullRefresh = () => {
    clearScopes();
    options.refresh(null);
  };
  const message = (event: string, data: string) => {
    if (stopped) return;
    if (event === 'reset') {
      fullRefresh();
      return;
    }
    if (event === 'status') {
      options.refresh(null);
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(data) as unknown;
    } catch {
      return;
    }
    if (event === 'hello') {
      const parsed = helloSchema.safeParse(payload);
      if (!parsed.success) return;
      if (!hello || hello.head !== parsed.data.head || hello.instance !== parsed.data.instance)
        fullRefresh();
      hello = parsed.data;
      failures = 0;
      options.state('live');
    } else if (event === 'invalidate') {
      const parsed = scopeSchema.safeParse(payload);
      if (!parsed.success) return;
      for (const project of parsed.data.projects ?? []) projects.add(project);
      for (const task of parsed.data.tasks ?? []) tasks.add(task);
      debounce ??= setTimeout(() => {
        debounce = undefined;
        if (stopped) return;
        const scope = { projects: [...projects], tasks: [...tasks] };
        projects.clear();
        tasks.clear();
        options.refresh(scope);
      }, 400);
    }
  };
  const run = async () => {
    if (stopped) return;
    const controller = new AbortController();
    connection = controller;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetcher('/v1/events', {
        credentials: 'same-origin',
        signal: controller.signal,
        headers: { accept: 'text/event-stream', ...(lastId ? { 'Last-Event-ID': lastId } : {}) },
      });
      if (!response.ok || !response.body) throw new Error('Stream unavailable');
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let event = 'message';
      let data: string[] = [];
      const line = (value: string) => {
        if (value === '') {
          if (data.length > 0) message(event, data.join('\n'));
          event = 'message';
          data = [];
          return;
        }
        if (value.startsWith(':')) return;
        const colon = value.indexOf(':');
        const field = colon < 0 ? value : value.slice(0, colon);
        const content = colon < 0 ? '' : value.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = content;
        if (field === 'data') data.push(content);
        if (field === 'id' && !content.includes('\0')) lastId = content;
      };
      while (!isStopped()) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        // Leave a trailing CR until the next chunk, so a split CRLF stays one newline.
        let match: RegExpExecArray | null;
        while ((match = /\r\n|\n|\r(?!$)/.exec(buffer))) {
          line(buffer.slice(0, match.index));
          buffer = buffer.slice(match.index + match[0].length);
        }
      }
    } catch {
      // Network failure and EOF use the same owned retry path.
    } finally {
      await reader?.cancel().catch(() => undefined);
      if (!isStopped()) {
        failures += 1;
        options.state(failures >= 5 ? 'offline' : 'reconnecting');
        const delay = Math.min(500 * 2 ** Math.min(failures - 1, 6), 30_000);
        retry = setTimeout(() => {
          retry = undefined;
          void run();
        }, delay);
      }
    }
  };
  options.state('reconnecting');
  void run();
  return {
    /** Reconnect now while a backoff is pending; otherwise a connection is open or starting. */
    retry() {
      if (stopped || retry === undefined) return;
      clearTimeout(retry);
      retry = undefined;
      void run();
    },
    stop() {
      stopped = true;
      connection?.abort();
      clearTimeout(retry);
      clearScopes();
    },
  };
}
