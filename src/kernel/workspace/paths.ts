import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** The on-disk layout of one project. Relative to `root`; nothing outside `root` is ever addressed by a document. */
export interface ProjectPaths {
  root: string;
  projectFile: string;
  productionFile: string;
  storyDir: string;
  fiveLinesFile: string;
  screenplayFile: string;
  revisionsDir: string;
  cutDir: string;
  mediaDir: string;
  mediaSourceDir: string;
  mediaBoardsDir: string;
  mediaGeneratedDir: string;
  mediaBlockoutsDir: string;
  mediaAudioDir: string;
  mediaLibraryDir: string;
  workDir: string;
  exportsDir: string;
  slateDir: string;
  commitsFile: string;
  historyDir: string;
  jobsDir: string;
  ledgerFile: string;
  capabilitiesFile: string;
  lockDir: string;
  cacheDir: string;
}

export function projectPaths(root: string): ProjectPaths {
  const absolute = resolve(root);
  const slateDir = join(absolute, ".slate");
  const mediaDir = join(absolute, "media");
  const storyDir = join(absolute, "story");
  return {
    root: absolute,
    projectFile: join(absolute, "project.json"),
    productionFile: join(absolute, "production.json"),
    storyDir,
    fiveLinesFile: join(storyDir, "five-lines.md"),
    screenplayFile: join(storyDir, "screenplay.fountain"),
    revisionsDir: join(storyDir, "revisions"),
    cutDir: join(absolute, "cut"),
    mediaDir,
    mediaSourceDir: join(mediaDir, "source"),
    mediaBoardsDir: join(mediaDir, "boards"),
    mediaGeneratedDir: join(mediaDir, "generated"),
    mediaBlockoutsDir: join(mediaDir, "blockouts"),
    mediaAudioDir: join(mediaDir, "audio"),
    mediaLibraryDir: join(mediaDir, "library"),
    workDir: join(absolute, "work"),
    exportsDir: join(absolute, "exports"),
    slateDir,
    commitsFile: join(slateDir, "commits.jsonl"),
    historyDir: join(slateDir, "history"),
    jobsDir: join(slateDir, "jobs"),
    ledgerFile: join(slateDir, "ledger.jsonl"),
    capabilitiesFile: join(slateDir, "capabilities.json"),
    lockDir: join(slateDir, "lock"),
    cacheDir: join(slateDir, "cache"),
  };
}

/**
 * Resolve a document-supplied relative path inside the project. Absolute paths and `..` escapes are rejected: a
 * project that can address the rest of the disk is neither portable nor safe to open.
 */
export function resolveInside(root: string, relativePath: string): string {
  if (isAbsolute(relativePath)) {
    throw new Error(`absolute path is not allowed in a project: ${relativePath}`);
  }
  const base = resolve(root);
  const target = resolve(base, relativePath);
  const rel = relative(base, target);
  if (rel === "") return target;
  if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) {
    throw new Error(`path escapes the project: ${relativePath}`);
  }
  return target;
}
