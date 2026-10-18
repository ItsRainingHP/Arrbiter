import { lstat, readdir, realpath, unlink, rmdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CleanupTarget } from "./types.ts";

export const cleanupRoot = resolve(process.env.ARRBITER_CLEANUP_ROOT || "/cleanup");

async function rejectNestedMounts(root: string): Promise<void> {
  if (process.platform !== "linux") return;
  const mounts = await readFile("/proc/self/mountinfo", "utf8");
  for (const line of mounts.split("\n")) {
    const encoded = line.split(" ")[4];
    if (!encoded) continue;
    const point = encoded.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
    if (point.startsWith(root + sep)) throw new Error(`Nested mount found: ${point}`);
  }
}

export interface ManifestEntry {
  path: string;
  kind: "file" | "directory" | "symlink";
  size: number;
  mtimeMs: number;
  ino: number;
  dev: number;
}

export async function validateTargetPath(path: string, others: string[] = []): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Cleanup path must be absolute inside the container");
  const root = await realpath(cleanupRoot);
  const actual = await realpath(path);
  const rel = relative(root, actual);
  if (!rel || rel.startsWith(".." + sep) || rel === ".." || isAbsolute(rel)) throw new Error("Cleanup path must be a subfolder of /cleanup");
  if (resolve(path) !== actual) throw new Error("Cleanup path cannot contain symlinks");
  const stat = await lstat(actual);
  if (!stat.isDirectory()) throw new Error("Cleanup target must be a directory");
  for (const other of others) {
    const normalized = resolve(other);
    if (normalized === actual || normalized.startsWith(actual + sep) || actual.startsWith(normalized + sep)) throw new Error("Cleanup paths cannot overlap");
  }
  return actual;
}

export async function snapshotFolder(target: CleanupTarget): Promise<ManifestEntry[]> {
  const root = await validateTargetPath(target.path);
  await rejectNestedMounts(root);
  const rootStat = await lstat(root);
  const manifest: ManifestEntry[] = [{ path: "", kind: "directory", size: rootStat.size, mtimeMs: rootStat.mtimeMs, ino: rootStat.ino, dev: rootStat.dev }];
  async function walk(parent: string) {
    for (const name of await readdir(parent)) {
      const path = join(parent, name);
      const stat = await lstat(path);
      if (stat.dev !== rootStat.dev) throw new Error(`Nested mount found: ${path}`);
      if (!stat.isSymbolicLink() && !stat.isDirectory() && !stat.isFile()) throw new Error(`Special file cannot be cleaned: ${path}`);
      const kind = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file";
      manifest.push({ path: relative(root, path), kind, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, dev: stat.dev });
      if (manifest.length > 100_000) throw new Error("Cleanup preview exceeds 100,000 entries");
      if (kind === "directory") await walk(path);
    }
  }
  await walk(root);
  return manifest;
}

function sameEntry(entry: ManifestEntry, stat: Awaited<ReturnType<typeof lstat>>): boolean {
  const kind = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file";
  return kind === entry.kind && stat.dev === entry.dev && stat.ino === entry.ino && (kind === "directory" || (stat.size === entry.size && stat.mtimeMs === entry.mtimeMs));
}

export async function applyCleanup(target: CleanupTarget, manifest: ManifestEntry[], checkIdle: () => Promise<boolean>): Promise<{ deleted: number; skipped: number }> {
  const root = await validateTargetPath(target.path);
  await rejectNestedMounts(root);
  const byPath = new Map(manifest.map((entry) => [entry.path, entry]));
  if (!byPath.has("")) throw new Error("Cleanup snapshot lacks folder identity");
  async function parentsUnchanged(relativePath: string): Promise<boolean> {
    const parts = relativePath.split(sep);
    for (let count = 0; count < parts.length; count++) {
      const parent = parts.slice(0, count).join(sep);
      const entry = byPath.get(parent);
      if (!entry || entry.kind !== "directory") return false;
      try {
        if (!sameEntry(entry, await lstat(resolve(root, parent)))) return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    }
    return true;
  }
  let deleted = 0;
  let skipped = 0;
  const files = manifest.filter((entry) => entry.kind !== "directory");
  const directories = manifest.filter((entry) => entry.kind === "directory" && entry.path).sort((a, b) => b.path.split(sep).length - a.path.split(sep).length);
  for (const entry of files) {
    if (!await checkIdle()) throw new Error("Activity changed during cleanup; stopped");
    await rejectNestedMounts(root);
    const path = resolve(root, entry.path);
    if (!path.startsWith(root + sep)) { skipped++; continue; }
    if (!await parentsUnchanged(entry.path)) { skipped++; continue; }
    try {
      const stat = await lstat(path);
      if (!sameEntry(entry, stat)) { skipped++; continue; }
      await unlink(path);
      deleted++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { skipped++; continue; }
      throw error;
    }
  }
  for (const entry of directories) {
    if (!await checkIdle()) throw new Error("Activity changed during cleanup; stopped");
    await rejectNestedMounts(root);
    const path = resolve(root, entry.path);
    if (!path.startsWith(root + sep)) { skipped++; continue; }
    if (!await parentsUnchanged(entry.path)) { skipped++; continue; }
    try {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.dev !== entry.dev || stat.ino !== entry.ino) { skipped++; continue; }
      await rmdir(path);
      deleted++;
    } catch (error) {
      if (["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code || "")) { skipped++; continue; }
      throw error;
    }
  }
  return { deleted, skipped };
}
