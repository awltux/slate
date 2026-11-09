export interface PresenceEntry {
  userId: string;
  displayName: string;
  page: string;
  objectId: string | null;
  lastSeen: number;
}

/**
 * Who is looking at this project right now. Ephemeral by design: it lives in the daemon's memory, never in a document,
 * and expires on its own. Presence warns; it never blocks — the conflict check is `expectedRevision`, not a lock.
 */
export class PresenceRegistry {
  readonly #entries = new Map<string, PresenceEntry>();

  touch(projectId: string, entry: Omit<PresenceEntry, "lastSeen">, now: number): void {
    this.#entries.set(`${projectId}:${entry.userId}`, { ...entry, lastSeen: now });
  }

  list(projectId: string, now: number, ttlMs = 45_000): PresenceEntry[] {
    const prefix = `${projectId}:`;
    for (const [key, entry] of this.#entries) {
      if (now - entry.lastSeen > ttlMs) this.#entries.delete(key);
    }
    return [...this.#entries.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, entry]) => entry)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }
}
