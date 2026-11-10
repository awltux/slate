import { describe, expect, it } from "vitest";
import { applyMention, findMention, matchMentions } from "../../web/src/pages/mention.js";

const resources = [{ name: "The keeper" }, { name: "Lantern room" }, { name: "Salt marsh" }];

describe("mentions in a prompt", () => {
  it("opens on @ and follows the caret", () => {
    const text = "a wide shot of @kee";
    const mention = findMention(text, text.length);
    expect(mention).toEqual({ start: text.indexOf("@"), query: "kee" });
  });

  it("opens on a bare @ too", () => {
    expect(findMention("look @", 6)).toEqual({ start: 5, query: "" });
    expect(findMention("@", 1)).toEqual({ start: 0, query: "" });
  });

  it("does not open in the middle of a word or an address", () => {
    // An email is not a mention: the @ follows a character, not a space.
    expect(findMention("mail me at keeper@example.com", 29)).toBeNull();
    expect(findMention("halfway", 7)).toBeNull();
  });

  it("filters by what has been typed, case-insensitively", () => {
    expect(matchMentions(resources, "lan").map((item) => item.name)).toEqual(["Lantern room"]);
    expect(matchMentions(resources, "SALT").map((item) => item.name)).toEqual(["Salt marsh"]);
    // An empty query offers everything, which is what the popup is for.
    expect(matchMentions(resources, "")).toHaveLength(3);
  });

  it("replaces the token with the name and leaves the rest of the sentence", () => {
    const text = "a wide shot of @lan with amber light";
    const caret = text.indexOf("@lan") + 4;
    const mention = findMention(text, caret);
    if (!mention) throw new Error("expected a mention");

    const next = applyMention(text, caret, mention, "Lantern room");
    expect(next.text).toBe("a wide shot of Lantern room with amber light");
    // The caret sits after the inserted name, ready for the next word (the existing space stays ahead of it).
    expect(next.text.slice(0, next.caret)).toBe("a wide shot of Lantern room");
    expect(next.text[next.caret]).toBe(" ");
  });

  it("keeps text typed after the caret", () => {
    const text = "@kee is here";
    const caret = 4;
    const mention = findMention(text, caret);
    if (!mention) throw new Error("expected a mention");
    const next = applyMention(text, caret, mention, "The keeper");
    expect(next.text).toBe("The keeper is here");
  });
});
