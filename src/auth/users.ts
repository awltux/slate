import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Clock } from "../domain/clock.js";
import { newId } from "../domain/ids.js";
import { SlateError } from "../domain/result.js";
import { writeFileAtomic } from "../kernel/workspace/atomic.js";
import { hashPassword, verifyPassword } from "./passwords.js";

export const RoleSchema = z.enum(["owner", "editor", "reviewer", "viewer"]);
export type Role = z.infer<typeof RoleSchema>;

export const UserSchema = z
  .object({
    id: z.string().startsWith("usr_"),
    username: z.string().min(1),
    displayName: z.string().min(1),
    role: RoleSchema,
    passwordHash: z.string(),
    createdAt: z.string(),
  })
  .strict();

export type User = z.infer<typeof UserSchema>;

const UsersFileSchema = z
  .object({
    format: z.literal("slate.users"),
    version: z.literal(1),
    users: z.array(UserSchema),
  })
  .strict();

export function usersFile(home: string): string {
  return join(home, "users.json");
}

export async function readUsers(home: string): Promise<User[]> {
  let raw: string;
  try {
    raw = await readFile(usersFile(home), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const parsed = UsersFileSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new SlateError("invalid_document", "users.json is malformed", { detail: { file: "users.json" } });
  }
  return parsed.data.users;
}

export async function writeUsers(home: string, users: User[]): Promise<void> {
  const file = { format: "slate.users" as const, version: 1 as const, users };
  await writeFileAtomic(usersFile(home), `${JSON.stringify(file, null, 2)}\n`);
}

export interface NewUser {
  username: string;
  password: string;
  role: Role;
  displayName?: string;
}

/** Usernames are case-insensitive; the stored form is the lower-cased one so lookups are exact. */
export function normaliseUsername(username: string): string {
  return username.trim().toLowerCase();
}

export async function addUser(home: string, input: NewUser, clock: Clock): Promise<User> {
  const users = await readUsers(home);
  const username = normaliseUsername(input.username);
  if (users.some((user) => user.username === username)) {
    throw new SlateError("conflict", `user already exists: ${username}`);
  }
  const user: User = {
    id: newId("usr"),
    username,
    displayName: input.displayName ?? input.username,
    role: input.role,
    passwordHash: hashPassword(input.password),
    createdAt: clock.now(),
  };
  await writeUsers(home, [...users, user]);
  return user;
}

/** Returns the user on success and null otherwise: a wrong username and a wrong password are indistinguishable. */
export async function authenticate(home: string, username: string, password: string): Promise<User | null> {
  const users = await readUsers(home);
  const user = users.find((candidate) => candidate.username === normaliseUsername(username));
  if (!user) return null;
  return verifyPassword(password, user.passwordHash) ? user : null;
}

export interface EnsureOwnerResult {
  user: User;
  generatedPassword?: string;
}

/**
 * A fresh host needs exactly one way in. The owner is created once, with a generated password printed by the daemon
 * (or supplied by SLATE_OWNER_PASSWORD), and never recreated silently.
 */
export async function ensureOwner(home: string, clock: Clock, password?: string): Promise<EnsureOwnerResult> {
  const users = await readUsers(home);
  const owner = users.find((user) => user.role === "owner");
  if (owner) return { user: owner };

  const generated = password ?? randomBytes(12).toString("base64url");
  const user = await addUser(
    home,
    { username: "owner", password: generated, role: "owner", displayName: "Owner" },
    clock,
  );
  return password ? { user } : { user, generatedPassword: generated };
}
