import { z } from "zod";
import { newId } from "../domain/ids.js";
import { SlateError } from "../domain/result.js";
import { NoteAnchorSchema } from "../kernel/production/review.js";
import { commitDocuments } from "../kernel/workspace/commit.js";
import { loadDocuments } from "./documents.js";
import { defineOp } from "./registry.js";

const LinkViewSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    createdBy: z.string(),
    createdAt: z.string(),
    expiresAt: z.string(),
    revoked: z.boolean(),
    expired: z.boolean(),
  })
  .strict();

/**
 * A review link is how someone outside this host watches the film. It is signed, expiring and revocable, and it grants
 * exactly two things: reading the cut and leaving notes. It cannot approve spend and it cannot change the plan.
 */
export const reviewLink = defineOp({
  name: "review.link",
  policy: "write",
  summary: "Create a signed, expiring link that lets a reviewer watch the cut and leave notes.",
  input: z
    .object({
      label: z.string().default(""),
      expiresInHours: z
        .number()
        .int()
        .min(1)
        .max(24 * 30)
        .default(168),
    })
    .strict(),
  output: z.object({ id: z.string(), expiresAt: z.string(), label: z.string() }).strict(),
  touched: () => ["reviewLinks"],
  run: async (input, context) => {
    await loadDocuments(context);
    const id = newId("rvl");
    const now = context.clock.now();
    const expiresAt = new Date(new Date(now).getTime() + input.expiresInHours * 3_600_000).toISOString();

    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: `review: create link "${input.label || id}"`,
      touched: [`reviewLink:${id}`],
      clock: context.clock,
      mutate: ({ production }) => {
        production.reviewLinks[id] = {
          id,
          label: input.label,
          createdBy: context.actor,
          createdAt: now,
          expiresAt,
          revoked: false,
        };
      },
    });

    return {
      data: { id, expiresAt, label: input.label },
      version: result.project.revision,
      commit: result.commit.id,
      next: ["review.links", "note.list"],
    };
  },
});

export const reviewLinks = defineOp({
  name: "review.links",
  policy: "read",
  summary: "Review links with their expiry and revocation state.",
  input: z.object({}).strict(),
  output: z.object({ links: z.array(LinkViewSchema) }).strict(),
  run: async (_input, context) => {
    const { project, production } = await loadDocuments(context);
    const now = Date.now();
    return {
      data: {
        links: Object.values(production.reviewLinks)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map((link) => ({
            id: link.id,
            label: link.label,
            createdBy: link.createdBy,
            createdAt: link.createdAt,
            expiresAt: link.expiresAt,
            revoked: link.revoked,
            expired: new Date(link.expiresAt).getTime() <= now,
          })),
      },
      version: project.revision,
      next: ["review.revoke"],
    };
  },
});

export const reviewRevoke = defineOp({
  name: "review.revoke",
  policy: "destructive",
  summary: "Revoke a review link so it stops working immediately.",
  input: z.object({ linkId: z.string() }).strict(),
  output: z.object({ linkId: z.string(), revoked: z.literal(true) }).strict(),
  touched: (input) => [`reviewLink:${input.linkId}`],
  run: async (input, context) => {
    const { production } = await loadDocuments(context);
    if (!production.reviewLinks[input.linkId]) throw new SlateError("not_found", `no link ${input.linkId}`);

    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: `review: revoke link ${input.linkId}`,
      touched: [`reviewLink:${input.linkId}`],
      clock: context.clock,
      mutate: ({ production: target }) => {
        const link = target.reviewLinks[input.linkId];
        if (link) link.revoked = true;
      },
    });

    return {
      data: { linkId: input.linkId, revoked: true as const },
      version: result.project.revision,
      commit: result.commit.id,
      next: ["review.links"],
    };
  },
});

export const noteAdd = defineOp({
  name: "note.add",
  policy: "write",
  summary: "Leave a note on a shot, a scene, or the cut.",
  input: z
    .object({
      anchor: NoteAnchorSchema,
      body: z.string().trim().min(1),
      author: z.string().optional(),
      external: z.boolean().default(false),
    })
    .strict(),
  output: z.object({ noteId: z.string(), createdAt: z.string() }).strict(),
  touched: () => ["notes"],
  run: async (input, context) => {
    const { production: before } = await loadDocuments(context);
    if (input.anchor.kind === "shot" && !before.shots[input.anchor.id]) {
      throw new SlateError("not_found", `no shot ${input.anchor.id}`);
    }
    if (input.anchor.kind === "scene" && !before.scenes[input.anchor.id]) {
      throw new SlateError("not_found", `no scene ${input.anchor.id}`);
    }

    const noteId = newId("nte");
    const createdAt = context.clock.now();
    const result = await commitDocuments({
      root: context.root,
      actor: input.external ? (input.author ?? "reviewer") : context.actor,
      intent: `note on ${input.anchor.kind} ${input.anchor.id}`,
      touched: [`note:${noteId}`],
      clock: context.clock,
      mutate: ({ production }) => {
        production.notes[noteId] = {
          id: noteId,
          anchor: input.anchor,
          body: input.body,
          author: input.author ?? context.actor,
          external: input.external,
          createdAt,
          resolvedAt: null,
        };
      },
    });

    return {
      data: { noteId, createdAt },
      version: result.project.revision,
      commit: result.commit.id,
      next: ["note.list"],
    };
  },
});

export const noteList = defineOp({
  name: "note.list",
  policy: "read",
  summary: "Notes, filtered by anchor or resolution.",
  input: z
    .object({
      anchorKind: NoteAnchorSchema.shape.kind.optional(),
      id: z.string().optional(),
      includeResolved: z.boolean().default(true),
    })
    .strict(),
  output: z
    .object({
      notes: z.array(
        z
          .object({
            id: z.string(),
            anchorKind: z.string(),
            anchorId: z.string(),
            body: z.string(),
            author: z.string(),
            external: z.boolean(),
            createdAt: z.string(),
            resolvedAt: z.string().nullable(),
          })
          .strict(),
      ),
    })
    .strict(),
  run: async (input, context) => {
    const { project, production } = await loadDocuments(context);
    return {
      data: {
        notes: Object.values(production.notes)
          .filter((note) => (input.anchorKind ? note.anchor.kind === input.anchorKind : true))
          .filter((note) => (input.id ? note.anchor.id === input.id : true))
          .filter((note) => (input.includeResolved ? true : note.resolvedAt === null))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map((note) => ({
            id: note.id,
            anchorKind: note.anchor.kind,
            anchorId: note.anchor.id,
            body: note.body,
            author: note.author,
            external: note.external,
            createdAt: note.createdAt,
            resolvedAt: note.resolvedAt,
          })),
      },
      version: project.revision,
      next: ["note.resolve"],
    };
  },
});

export const noteResolve = defineOp({
  name: "note.resolve",
  policy: "write",
  summary: "Mark a note as handled.",
  input: z.object({ noteId: z.string() }).strict(),
  output: z.object({ noteId: z.string(), resolvedAt: z.string() }).strict(),
  touched: (input) => [`note:${input.noteId}`],
  run: async (input, context) => {
    const { production } = await loadDocuments(context);
    if (!production.notes[input.noteId]) throw new SlateError("not_found", `no note ${input.noteId}`);

    const resolvedAt = context.clock.now();
    const result = await commitDocuments({
      root: context.root,
      actor: context.actor,
      intent: `note: resolve ${input.noteId}`,
      touched: [`note:${input.noteId}`],
      clock: context.clock,
      mutate: ({ production: target }) => {
        const note = target.notes[input.noteId];
        if (note) note.resolvedAt = resolvedAt;
      },
    });

    return {
      data: { noteId: input.noteId, resolvedAt },
      version: result.project.revision,
      commit: result.commit.id,
      next: ["note.list"],
    };
  },
});
