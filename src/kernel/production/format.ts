/**
 * The frame geometry of a project, derived from its settings rather than chosen per call. A film has one shape: the cut,
 * the generated stills and the delivered master all have to agree, so the size is computed here once.
 */

export interface FrameSettings {
  aspectRatio: string;
  /** The short edge, in pixels: what "1080p" means whether the frame is landscape or portrait. */
  resolutionPixels: number;
}

export interface FrameSize {
  width: number;
  height: number;
}

/** "16:9" → 16 / 9. A ratio that cannot be read is a bug in the document, not something to guess at. */
export function aspectValue(aspectRatio: string): number {
  const [rawWidth, rawHeight] = aspectRatio.split(":");
  const width = Number(rawWidth);
  const height = Number(rawHeight);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`unreadable aspect ratio: ${aspectRatio}`);
  }
  return width / height;
}

/** Even numbers only: an odd dimension breaks the 4:2:0 chroma the encoder uses. */
function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/**
 * The pixel size for a film's shape: 16:9 at 1080 is 1920x1080, and 9:16 at 1080 is 1080x1920. The short edge is what
 * the setting names, so the same number means the same quality in either orientation.
 */
export function frameSize(settings: FrameSettings): FrameSize {
  const ratio = aspectValue(settings.aspectRatio);
  const short = settings.resolutionPixels;
  return ratio >= 1
    ? { width: even(short * ratio), height: even(short) }
    : { width: even(short), height: even(short / ratio) };
}
