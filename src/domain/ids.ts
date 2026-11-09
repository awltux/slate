import { randomUUID } from "node:crypto";

/** Every entity id is `<prefix>_<uuid>`; the prefix makes an id self-describing in logs and documents. */
export type IdPrefix =
  | "prj"
  | "scn"
  | "sht"
  | "shtv"
  | "frm"
  | "tke"
  | "cut"
  | "ast"
  | "job"
  | "est"
  | "set"
  | "blk"
  | "ent"
  | "usr"
  | "cmt"
  | "ses"
  | "op";

export type Id<P extends IdPrefix = IdPrefix> = `${P}_${string}`;

export type ProjectId = Id<"prj">;
export type SceneId = Id<"scn">;
export type ShotId = Id<"sht">;
export type ShotVersionId = Id<"shtv">;
export type FrameId = Id<"frm">;
export type TakeId = Id<"tke">;
export type CutId = Id<"cut">;
export type AssetId = Id<"ast">;
export type JobId = Id<"job">;
export type EstimateId = Id<"est">;
export type SetId = Id<"set">;
export type BlockoutId = Id<"blk">;
export type EntityId = Id<"ent">;
export type UserId = Id<"usr">;
export type CommitId = Id<"cmt">;
export type SessionId = Id<"ses">;

export function newId<P extends IdPrefix>(prefix: P): Id<P> {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function isId<P extends IdPrefix>(prefix: P, value: unknown): value is Id<P> {
  return typeof value === "string" && value.startsWith(`${prefix}_`) && value.length > prefix.length + 1;
}
