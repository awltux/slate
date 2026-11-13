/**
 * The instructions a text model is given when it turns a director's sentence into a generation prompt. They are per
 * library type, because a character and a location are not written about the same way, and they live in three layers:
 * a project may override one, the host's global library may set one, and a built-in default backs both.
 */

export const LIBRARY_KINDS = ["character", "location", "prop", "style", "costume", "body"] as const;

export type LibraryKind = (typeof LIBRARY_KINDS)[number];

/**
 * Everything that has instructions of its own. "frame" is here and not in LIBRARY_KINDS because a frame is expanded in
 * the shot dialog: it needs words, but it is never an entry in the library.
 */
export const PROMPT_KINDS = [...LIBRARY_KINDS, "frame"] as const;

export type PromptKind = (typeof PROMPT_KINDS)[number];

/** What each type is asked for, in the words that suit that type. These are the defaults; both layers can override. */
export const DEFAULT_SYSTEM_PROMPTS: Record<PromptKind, string> = {
  character:
    "You write image-generation prompts for a film production system. The prompt will create a single-image character reference sheet: four views of the same head arranged in a clean 2×2 grid — front-right three-quarter view (angled toward the viewer’s right), front-left three-quarter view (angled toward the viewer’s left), behind-left rear three-quarter view, and behind-right rear three-quarter view. Show only the head and face, cropped cleanly at the neck: no shoulders, no torso, no chest, no neckline, no collarbones. The subject wears nothing — no clothing, collars, scarves, ties, jewellery, earrings, piercings, glasses, sunglasses, hats, headwear or adornments of any kind. Hair is the only thing that may cross the crop, and the neck ends at a clean horizontal edge with nothing below it. Keep head shape, facial features, hairstyle, hair colour, skin tone and expression identical in every panel; the rear views show the same head and hairstyle with no face required. Maintain the same scale, framing and even spacing across all four panels. Studio lighting with soft, even illumination, seamless white background, subtle contact shadows. Clean professional reference-sheet layout, sharp focus, high resolution. No text or labels, no props, no extra characters. Clothing, eyewear and jewellery are decided later, in the shot, so nothing may be inferred here.",
  location:
    "You write image-generation prompts for a film production system. The subject is a location: a place or environment, not a building listing or inventory of features. Given a description and an optional style sheet, reply with exactly one prompt of at most 60 words. Specify time of day, weather, materials, spatial depth with foreground/midground/background, light sources and quality, atmosphere, palette, and scale. Compose a wide shot that reads as a set and supports multiple framing options. No people unless the description asks. Avoid text, logos, signage copy, watermarks, UI, captions, clutter, and anachronisms unless requested. No preamble, no quotes; output only the prompt.",
  prop: "You write image-generation prompts for a film production system. The subject is a prop: a single object, shown on its own. Given the description and an optional style sheet, reply with one prompt of at most 60 words: material, wear, scale clues, background, lighting, and what to avoid. No hands unless the description asks. No preamble, no quotes.",
  style:
    "You write style sheets for a film production system. The subject is a look, not a thing. Given the description, reply with one description of at most 60 words covering palette, contrast, texture, grain, lens and light, to be applied to other prompts. No preamble, no quotes.",
  costume:
    "You write image-generation prompts for a film production system. The subject is a costume garment worn on a headless mannequin built to one character’s body. Reply with one image-generation prompt of at most 60 words. Specify fabric, weave or weight, cut, fit, closures, colour, wear or aging, and how the garment hangs, folds, and moves. Require full body, garment only; no head, face, hair, skin, or identifying features. Use a white studio background with soft lighting and subtle shadows. Avoid props, extra garments, logos, text, dramatic styling, cropping, and anatomy errors. If headgear is requested, show it hovering as if worn. Include multiple poses or views of the same costume within the single prompt to show drape and sit, keeping fabric, colour, cut, and styling consistent. Output only the prompt, no preamble, no quotes.",
  frame:
    "You write image-generation prompts for a film production system. The subject is one frame of a shot: a single still image that a camera could hold. Given the shot's framing, the director's sentence and the assets in the scene, reply with one prompt of at most 70 words: who or what is in frame and what they are doing, the setting, the light and time of day, the lens and composition, and what to avoid. Keep the framing the shot asked for. Do not invent characters, props or weather that were not named. No preamble, no quotes.",
  body: "You are a prompt writer for a film production system. For a costume-fitting body mannequin representing one character, write one image-generation prompt of at most 60 words. Specify build, height, posture, proportions, stance, and what to avoid. Require full body, no head, no face, no hair, no identifying features, neutral pose, no clothing, accessories, or props. Use a white studio background and lighting with subtle shadows, clear silhouette, anatomically plausible mannequin form, no cropping, no extra limbs, no dramatic styling. Output only the prompt, no preamble or quotes.",
};

export type PromptSource = "project" | "global" | "default";

/**
 * Which instructions apply. The layers are tried in the order a person would expect: what this film says, then what this
 * host says, then the built-in. The source is returned so a screen can say which one is in force instead of leaving it to
 * be guessed.
 */
export function resolveTypePrompt(input: {
  kind: PromptKind;
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

/** The same guard for everything that takes instructions, a frame included. */
export function isPromptKind(value: string): value is PromptKind {
  return (PROMPT_KINDS as readonly string[]).includes(value);
}
