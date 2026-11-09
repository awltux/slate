import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Write a file so that a reader either sees the previous content or the new content, never a partial write:
 * temp file in the same directory, fsync, then rename over the target.
 */
export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  const directory = dirname(file);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);

  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
