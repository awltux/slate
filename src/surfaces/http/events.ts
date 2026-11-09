export interface ServerEvent {
  type: "version" | "job" | "log";
  data: unknown;
}

type Listener = (event: ServerEvent) => void;

/** In-process fan-out for SSE. Events are notifications, not state: a client that misses one refetches on reconnect. */
export class EventHub {
  readonly #listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  publish(event: ServerEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A broken connection must not break other subscribers.
      }
    }
  }

  get size(): number {
    return this.#listeners.size;
  }
}
