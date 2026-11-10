import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { z } from "zod";
import { hashBytes } from "../../domain/canonical.js";
import { SlateError } from "../../domain/result.js";
import type { RunProbe } from "../catalog/probe.js";
import { type ProjectDocument, ProjectSettingsSchema } from "./project-doc.js";

/**
 * A project archive is the folder as it stands, plus a manifest that says what it is. The archive is self-describing:
 * importing it needs nothing but the file, and a person opening it in 7-Zip can read what film it is.
 *
 * 7-Zip stores the path it is given, so the archive holds exactly one top-level directory - the project folder. That
 * single root is what makes extraction verifiable: one directory in, everything else inside it.
 */

export const EXPORT_FORMAT = "slate.export";
export const EXPORT_VERSION = 1;
/** Where the manifest lives inside the archive, relative to the project root. */
export const EXPORT_MANIFEST = join(".slate", "export-manifest.json");

/** Everything an archive must carry to be importable, and everything a person needs to identify it. */
export const ExportManifestSchema = z
  .object({
    format: z.literal(EXPORT_FORMAT),
    version: z.literal(EXPORT_VERSION),
    exportedAt: z.string(),
    exportedBy: z.string(),
    project: z
      .object({
        id: z.string().startsWith("prj_"),
        name: z.string().min(1),
        revision: z.number().int().nonnegative(),
        settings: ProjectSettingsSchema,
        budget: z.object({ currency: z.literal("USD"), ceilingUsd: z.number() }).strict(),
        bindingSetId: z.string().nullable(),
      })
      .strict(),
    counts: z
      .object({
        scenes: z.number().int(),
        shots: z.number().int(),
        entities: z.number().int(),
        takes: z.number().int(),
        assets: z.number().int(),
        cutItems: z.number().int(),
      })
      .strict(),
  })
  .strict();

export type ExportManifest = z.infer<typeof ExportManifestSchema>;

/** The directories and files a project is made of. Anything else in an archive is not copied into a host. */
const PROJECT_ENTRIES = [
  "project.json",
  "production.json",
  "story",
  "media",
  "cut",
  "exports",
  ".slate",
] as const;

/** 7-Zip's directory listing is noisy; only its exit code matters. */
function failed(result: { code: number | null; stderr: string }, what: string): SlateError {
  return new SlateError("service_unavailable", `7-Zip ${what} failed`, {
    retryable: true,
    detail: { stderr: result.stderr.slice(-800) },
  });
}

export interface ArchiveResult {
  bytes: number;
  sha256: string;
}

/**
 * Compress the project folder as it stands, cache excluded - it is derived and can be rebuilt. The manifest is written
 * into the project for the duration of the compression and removed afterwards, even on failure.
 */
export async function compressProject(input: {
  binary: string;
  root: string;
  archive: string;
  manifest: ExportManifest;
  run: RunProbe;
}): Promise<ArchiveResult> {
  const manifestFile = join(input.root, EXPORT_MANIFEST);
  await mkdir(join(input.root, ".slate"), { recursive: true });
  await writeFile(manifestFile, `${JSON.stringify(input.manifest, null, 2)}\n`, "utf8");
  try {
    const result = await input.run([
      input.binary,
      "a",
      "-t7z",
      // Media is already compressed (PNG, MP4); the archive trades ratio for speed, which is the right way round
      // for a backup you take often.
      "-mx=1",
      "-bd",
      "-y",
      input.archive,
      input.root,
      // `cache` by name, so the same argument works on every platform: a path separator would not.
      "-xr!cache",
    ]);
    if (result.code !== 0) throw failed(result, "could not create the archive");
  } finally {
    await rm(manifestFile, { force: true });
  }

  const { size } = await stat(input.archive);
  const hash = hashBytes(await readFile(input.archive));
  return { bytes: size, sha256: hash };
}

async function isDirectory(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  return info?.isDirectory() ?? false;
}

/** Every entry under a tree, relative to it, refusing links: an archive may not point outside where it is unpacked. */
async function walk(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const path = prefix === "" ? entry.name : join(prefix, entry.name);
    if (entry.isSymbolicLink()) {
      throw new SlateError("invalid_input", "the archive contains a link, which a project never does", {
        detail: { entry: path },
      });
    }
    found.push(path);
    if (entry.isDirectory()) found.push(...(await walk(root, path)));
  }
  return found;
}

export interface ExtractedProject {
  /** The single top-level directory the archive unpacked to. */
  root: string;
  manifest: ExportManifest;
  document: ProjectDocument;
  files: number;
}

/**
 * Unpack an archive into a temporary directory and prove it is a project before anything is copied into a host: one
 * top-level directory, no links, a manifest that parses, and a project document that parses.
 */
export async function extractProject(input: {
  binary: string;
  archive: string;
  dest: string;
  run: RunProbe;
}): Promise<ExtractedProject> {
  const exists = await stat(input.archive).catch(() => null);
  if (!exists?.isFile()) throw new SlateError("not_found", "no archive at the path you gave");

  await mkdir(input.dest, { recursive: true });
  const result = await input.run([input.binary, "x", input.archive, `-o${input.dest}`, "-bd", "-y"]);
  if (result.code !== 0) throw failed(result, "could not open the archive");

  const top = (await readdir(input.dest)).filter((entry) => !entry.startsWith("."));
  if (top.length !== 1) {
    throw new SlateError("invalid_input", "the archive is not a project: it has no single root folder", {
      detail: { entries: top.slice(0, 20) },
    });
  }
  const root = join(input.dest, top[0] as string);
  if (!(await isDirectory(root))) {
    throw new SlateError("invalid_input", "the archive's root is not a folder");
  }

  // Reject links and anything that would resolve outside the unpacked folder before reading a single document.
  const entries = await walk(root);
  for (const entry of entries) {
    const resolved = relative(input.dest, join(root, entry));
    if (resolved.startsWith("..") || resolved.startsWith(sep)) {
      throw new SlateError("invalid_input", "the archive contains a path outside its own folder", {
        detail: { entry },
      });
    }
  }

  const manifestRaw = await readFile(join(root, EXPORT_MANIFEST), "utf8").catch(() => null);
  if (manifestRaw === null) {
    throw new SlateError("invalid_input", "the archive has no export manifest, so it is not a Slate export");
  }
  const manifest = ExportManifestSchema.safeParse(JSON.parse(manifestRaw));
  if (!manifest.success) {
    throw new SlateError("invalid_input", "the archive's export manifest does not parse", {
      detail: { issues: manifest.error.issues.map((issue) => issue.path.join(".")) },
    });
  }

  const documentRaw = await readFile(join(root, "project.json"), "utf8").catch(() => null);
  if (documentRaw === null) {
    throw new SlateError("invalid_input", "the archive has no project.json");
  }
  const document = JSON.parse(documentRaw) as ProjectDocument;
  if (document.id !== manifest.data.project.id) {
    throw new SlateError(
      "invalid_input",
      "the manifest and the project document disagree about which film this is",
    );
  }

  return {
    root,
    manifest: manifest.data,
    document,
    files: entries.filter((entry) => !entry.endsWith(sep)).length,
  };
}

/**
 * Copy the unpacked project into its home, taking only the entries a project is made of and leaving the export manifest
 * behind: the imported film is a film, not an import record.
 */
export async function installProject(input: { from: string; to: string }): Promise<void> {
  await mkdir(input.to, { recursive: true });
  for (const entry of PROJECT_ENTRIES) {
    const source = join(input.from, entry);
    if (await stat(source).catch(() => null)) {
      await cp(source, join(input.to, entry), { recursive: true, force: true });
    }
  }
  await rm(join(input.to, EXPORT_MANIFEST), { force: true });
  const name = await readFile(join(input.to, "project.json"), "utf8").catch(() => null);
  if (name === null) {
    throw new SlateError("internal", `the project was not installed into ${basename(input.to)}`);
  }
}
