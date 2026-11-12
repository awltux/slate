/**
 * The instructions a text model is given when it turns a director's sentence into a generation prompt. They are per
 * library type, because a character and a location are not written about the same way, and they live in three layers:
 * a project may override one, the host's global library may set one, and a built-in default backs both.
 */

export const LIBRARY_KINDS = ["character", "location", "prop", "style", "costume", "body"] as const;

export type LibraryKind = (typeof LIBRARY_KINDS)[number];

/** What each type is asked for, in the words that suit that type. These are the defaults; both layers can override. */
export const DEFAULT_SYSTEM_PROMPTS: Record<LibraryKind, string> = {
  character:
    "You write image-generation prompts for a film production system. The prompt will create a single-image character headshot reference sheet with four head-and-shoulders views arranged in a clean 2×2 grid: front-right three-quarter view (angled toward the viewer’s right), front-left three-quarter view (angled toward the viewer’s left), behind-left rear three-quarter view, and behind-right rear three-quarter view. Show the same character in every panel with identical head shape, facial features, hairstyle, hair color, skin tone, accessories, and expression; keep the expression consistent in all face-visible views, and preserve the same head/hairstyle in rear views. Maintain the same scale, framing, and even spacing across all four panels. Studio lighting with soft, even illumination, seamless white background, and subtle contact shadows. Clean professional reference-sheet layout, sharp focus, high resolution. No text, labels, props, extra characters, or stylistic variation between panels.",
  location:
    "You write image-generation prompts for a film production system. The subject is a location: a place, not a building listing. Given the description and an optional style sheet, reply with one prompt of at most 60 words: time of day, weather, materials, depth, light sources, and what to avoid. No people unless the description asks. No preamble, no quotes.",
  prop: "You write image-generation prompts for a film production system. The subject is a prop: a single object, shown on its own. Given the description and an optional style sheet, reply with one prompt of at most 60 words: material, wear, scale clues, background, lighting, and what to avoid. No hands unless the description asks. No preamble, no quotes.",
  style:
    "You write style sheets for a film production system. The subject is a look, not a thing. Given the description, reply with one description of at most 60 words covering palette, contrast, texture, grain, lens and light, to be applied to other prompts. No preamble, no quotes.",
  costume:
    "You write image-generation prompts for a film production system. The subject is a costume: a garment worn on a headless mannequin with the build of one character. Reply with one prompt of at most 60 words: fabric, cut, wear, colour, how it hangs, and what to avoid. Full body, garment only, no head, no face. No preamble, no quotes.",
  body: "You write image-generation prompts for a film production system. The subject is a body: a headless mannequin of one character, made so a costume can be fitted to it. Reply with one prompt of at most 60 words: build, height, posture, proportions, and what to avoid. Full body, no head, no face, neutral pose. No preamble, no quotes.",
};

export type PromptSource = "project" | "global" | "default";

/**
 * Which instructions apply. The layers are tried in the order a person would expect: what this film says, then what this
 * host says, then the built-in. The source is returned so a screen can say which one is in force instead of leaving it to
 * be guessed.
 */
export function resolveTypePrompt(input: {
  kind: LibraryKind;
  project?: Record<string, string> | null;
  global?: Record<string, string> | null;
}): { prompt: string; source: PromptSource } {
  const fromProject = input.project?.[input.kind]?.trim();
  if (fromProject) return { prompt: fromProject, source: "project" };
  const fromGlobal = input.global?.[input.kind]?.trim();
  if (fromGlobal) return { prompt: fromGlobal, source: "global" };
  return { prompt: DEFAULT_SYSTEM_PROMPTS[input.kind], source: "default" };
}

/** Only the types Slate knows: a typo in a stored map must not become a silent extra type. */
export function isLibraryKind(value: string): value is LibraryKind {
  return (LIBRARY_KINDS as readonly string[]).includes(value);
}
