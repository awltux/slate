/** Time is a port so tests never sleep and documents never depend on the wall clock being real. */
export interface Clock {
  /** ISO-8601 UTC timestamp with milliseconds. */
  now(): string;
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
};

export function fixedClock(iso: string): Clock {
  return { now: () => iso };
}
