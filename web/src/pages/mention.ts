/**
 * @-mentions in a prompt. The token is found by looking back from the caret, so a mention can be typed anywhere in the
 * text and edited like any other word; inserting a name replaces the token rather than appending to it.
 *
 * Pure on purpose: the interesting part is which characters count, and that is cheaper to test than to click.
 */

export interface Mention {
  /** Where the `@` sits, so the token can be replaced in one slice. */
  start: number;
  /** What has been typed after the `@`, which filters the list. */
  query: string;
}

/**
 * The mention being typed at the caret, or null. A mention starts at the `@` only when it begins the text or follows
 * whitespace, so an email address in a prompt is not a mention.
 */
export function findMention(text: string, caret: number): Mention | null {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([\w'’-]*)$/u.exec(before);
  if (!match) return null;
  const query = match[2] ?? "";
  return { start: caret - query.length - 1, query };
}

/** The options a query matches, case-insensitively, in the order they were given. */
export function matchMentions<T extends { name: string }>(options: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return options;
  return options.filter((option) => option.name.toLowerCase().includes(needle));
}

/**
 * Put a name where the mention was. The `@` and the typed query are replaced, and a trailing space is added so the next
 * word does not run into the name and start a new mention.
 */
export function applyMention(
  text: string,
  caret: number,
  mention: Mention,
  name: string,
): { text: string; caret: number } {
  const before = text.slice(0, mention.start);
  const after = text.slice(caret);
  // A space only when the next character is not already one: typing '@lan with' must not become 'Lantern room  with'.
  const separator = /^\s/u.test(after) ? "" : " ";
  const inserted = `${name}${separator}`;
  return { text: before + inserted + after, caret: before.length + inserted.length };
}
