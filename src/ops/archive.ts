import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { SlateError } from "../domain/result.js";
import { readDestination, setDestination } from "../kernel/desktop/destinations.js";
import { defaultExportFolder } from "../kernel/desktop/pick-folder.js";
import {
  EXPORT_VERSION,
  compressProject,
  extractProject,
  installProject,
} from "../kernel/workspace/archive.js";
import { readProductionDocument } from "../kernel/workspace/production-doc.js";
import { readProjectDocument } from "../kernel/workspace/project-doc.js";
import { readProjects, registerProject, slugify } from "../kernel/workspace/projects.js";
import { takeChoice } from "./dialog.js";
import { defineOp } from "./registry.js";

/** Export/import is a host-level capability: it moves a whole folder, so it is the owner's to run. */

function archiveMissing(): SlateError {
  return new SlateError(
    "capability_missing",
    "7-Zip is needed to archive a project and was not found; install it or set SLATE_7Z_PATH",
  );
}

/**
 * Export writes the project folder to one archive, with a manifest that says what film is inside. The archive is the
 * backup: it can be handed to another machine, opened in 7-Zip, or imported back onto this host.
 */
export const projectExport = defineOp({
  name: "project.export",
  ownerOnly: true,
  policy: "read",
  summary: "Write the project to a 7z archive with a manifest describing it.",
  input: z
    .object({
      /** Folder to write into. Absolute, or relative to the Slate home. Defaults to <home>/exports. */
      destination: z.string().min(1).optional(),
      /** A folder chosen with dialog.pick-folder: an id, so no host path crosses the API. */
      destinationId: z.string().min(1).optional(),
    })
    .strict(),
  output: z
    .object({
      projectId: z.string(),
      archiveName: z.string(),
      bytes: z.number().int().nonnegative(),
      sha256: z.string(),
      revision: z.number().int(),
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
    .strict(),
  run: async (input, context) => {
    const sevenzip = await context.tool("7z");
    if (!sevenzip.binary) throw archiveMissing();

    const project = await readProjectDocument(context.root);
    const production = await readProductionDocument(context.root);
    const counts = {
      scenes: Object.keys(production?.scenes ?? {}).length,
      shots: Object.keys(production?.shots ?? {}).length,
      entities: Object.keys(production?.entities ?? {}).length,
      takes: Object.keys(production?.takes ?? {}).length,
      assets: Object.keys(production?.assets ?? {}).length,
      cutItems: production?.cut.items.length ?? 0,
    };

    // A chosen folder arrives as a token, is consumed here, and never appears in the result: the path stays on the host.
    let chosenPath: string | undefined;
    if (input.destinationId) {
      const chosen = await takeChoice(context.home, input.destinationId, context.clock.now());
      chosenPath = chosen.path;
    }
    if (input.destination && chosenPath) {
      throw new SlateError("invalid_input", "give either a destination or a chosen folder, not both");
    }

    // The order is: a folder given for this call, the project's remembered folder, then the convention every project
    // shares - the OS downloads folder under a Slate tree named after the film.
    const remembered = await readDestination(context.home, project.id);
    const fallback = defaultExportFolder({ projectName: project.name });
    const destination = chosenPath
      ? chosenPath
      : input.destination
        ? isAbsolute(input.destination)
          ? input.destination
          : resolve(context.home, input.destination)
        : (remembered?.path ?? fallback.path);
    await mkdir(destination, { recursive: true });

    const archiveName = `${slugify(project.name)}-${project.id.slice(4, 12)}-r${project.revision}.7z`;
    const archive = join(destination, archiveName);

    const written = await compressProject({
      binary: sevenzip.binary,
      root: context.root,
      archive,
      run: context.run,
      manifest: {
        format: "slate.export",
        version: EXPORT_VERSION,
        exportedAt: context.clock.now(),
        exportedBy: context.actor,
        project: {
          id: project.id,
          name: project.name,
          revision: project.revision,
          settings: project.settings,
          budget: project.budget,
          bindingSetId: project.aiBindingSetId,
        },
        counts,
      },
    });

    return {
      data: {
        projectId: project.id,
        archiveName,
        bytes: written.bytes,
        sha256: written.sha256,
        revision: project.revision,
        counts,
      },
      version: project.revision,
      next: ["project.import"],
    };
  },
});

/**
 * Import puts an archive back on this host. It verifies before it installs - one root, no links, a manifest and a
 * project document that agree - and it refuses to overwrite a project that is already here: restoring a backup over a
 * film that has moved on would destroy the newer work, and that is not a decision an import may take by itself.
 */
export const projectImport = defineOp({
  name: "project.import",
  ownerOnly: true,
  // A host with no projects must still be able to restore one: importing needs no project to be open.
  hostLevel: true,
  policy: "write",
  summary: "Restore a project from a 7z archive written by project.export.",
  input: z
    .object({
      /** The archive to import: absolute, or relative to the Slate home. */
      archive: z.string().min(1),
    })
    .strict(),
  output: z
    .object({
      projectId: z.string(),
      name: z.string(),
      revision: z.number().int(),
      files: z.number().int(),
      exportedAt: z.string(),
    })
    .strict(),
  touched: () => ["project"],
  run: async (input, context) => {
    const sevenzip = await context.tool("7z");
    if (!sevenzip.binary) throw archiveMissing();

    const archive = isAbsolute(input.archive) ? input.archive : resolve(context.home, input.archive);
    const exists = await stat(archive).catch(() => null);
    if (!exists?.isFile()) {
      throw new SlateError("not_found", `no archive named ${basename(archive)} to import`);
    }

    const work = await mkdtemp(join(tmpdir(), "slate-import-"));
    try {
      const extracted = await extractProject({
        binary: sevenzip.binary,
        archive,
        dest: work,
        run: context.run,
      });

      const projects = await readProjects(context.home);
      const clash = projects.find((entry) => entry.id === extracted.document.id);
      if (clash) {
        throw new SlateError(
          "conflict",
          `${clash.name} is already on this host, so it cannot be imported over itself`,
          { detail: { projectId: clash.id } },
        );
      }

      const target = join(
        context.home,
        "projects",
        `${slugify(extracted.document.name)}-${extracted.document.id.slice(4, 12)}`,
      );
      if (await stat(target).catch(() => null)) {
        throw new SlateError("conflict", "a folder for this project is already on this host", {
          detail: { projectId: extracted.document.id },
        });
      }

      await installProject({ from: extracted.root, to: target });
      // The document is the truth: read the name and revision from what was installed, not from the manifest alone.
      const installed = JSON.parse(await readFile(join(target, "project.json"), "utf8")) as {
        id: string;
        name: string;
        revision: number;
      };
      await registerProject(context.home, {
        id: installed.id,
        name: installed.name,
        path: target,
        createdAt: extracted.manifest.exportedAt,
      });

      return {
        data: {
          projectId: installed.id,
          name: installed.name,
          revision: installed.revision,
          files: extracted.files,
          exportedAt: extracted.manifest.exportedAt,
        },
        version: installed.revision,
        next: ["session.brief"],
      };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
});

/**
 * Where this project's archives go, as a person should see it: a label like "Downloads/slate/exports/the-last-light",
 * never an absolute path. `chosen` says whether someone overrode the convention.
 */
export const projectExportFolder = defineOp({
  name: "project.export-folder",
  policy: "read",
  summary: "The folder this project's archives are written to, as a label rather than a host path.",
  input: z.object({}).strict(),
  output: z
    .object({
      label: z.string(),
      /** True when nothing was chosen and the downloads convention applies. */
      isDefault: z.boolean(),
    })
    .strict(),
  run: async (_input, context) => {
    const project = await readProjectDocument(context.root);
    const remembered = await readDestination(context.home, project.id);
    if (remembered) {
      return { data: { label: remembered.label, isDefault: false }, version: project.revision };
    }
    const fallback = defaultExportFolder({ projectName: project.name });
    return { data: { label: fallback.label, isDefault: true }, version: project.revision };
  },
});

/**
 * Point this project's exports somewhere else, or back at the default. The folder is a host path, so it arrives as a
 * token from the folder dialog and is stored on the host - a result still carries only the label.
 */
export const projectSetExportFolder = defineOp({
  name: "project.set-export-folder",
  policy: "write",
  summary: "Choose, or reset, the folder this project's archives are written to.",
  input: z
    .object({
      /** A folder chosen with dialog.pick-folder, or null to go back to the downloads default. */
      destinationId: z.string().nullable(),
    })
    .strict(),
  output: z.object({ label: z.string(), isDefault: z.boolean() }).strict(),
  // Nothing in the project document changes: this is host state about where files land.
  touched: () => [],
  run: async (input, context) => {
    const project = await readProjectDocument(context.root);
    if (input.destinationId === null) {
      await setDestination(context.home, project.id, null);
      const fallback = defaultExportFolder({ projectName: project.name });
      return {
        data: { label: fallback.label, isDefault: true },
        version: project.revision,
        next: ["project.export"],
      };
    }

    const chosen = await takeChoice(context.home, input.destinationId, context.clock.now());
    await setDestination(context.home, project.id, {
      path: chosen.path,
      label: chosen.label,
      chosenAt: context.clock.now(),
    });
    return {
      data: { label: chosen.label, isDefault: false },
      version: project.revision,
      next: ["project.export"],
    };
  },
});
