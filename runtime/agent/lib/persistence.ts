import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export function getDataDirectory(): string {
  const configured = process.env.JARVIS_DATA_DIR;
  if (!configured) {
    if (process.platform === "darwin") return path.join(homedir(), "Library", "Application Support", "JarvisRoy");
    // Elsewhere (Linux development, the cloud host) follow the XDG data convention instead of inventing a macOS path.
    const xdg = process.env.XDG_DATA_HOME;
    return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(homedir(), ".local", "share"), "jarvis-roy");
  }
  if (configured === "~") return homedir();
  if (configured.startsWith("~/")) return path.resolve(homedir(), configured.slice(2));
  return path.resolve(configured);
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  const absolute = path.resolve(directory);
  if (absolute === path.parse(absolute).root) {
    throw new Error("Jarvis data directory cannot be a filesystem root.");
  }
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
    }
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("Jarvis data directories must be real directories.");
    }
  }
  await chmod(absolute, 0o700);
}

export async function readPrivateJson<T>(filePath: string): Promise<T | undefined> {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error("Jarvis data files must be regular files.");
    }
    await chmod(filePath, 0o600);
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

export async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await ensurePrivateDirectory(directory);
  const temporaryPath = path.join(directory, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function listRegularFiles(directory: string): Promise<string[]> {
  await ensurePrivateDirectory(directory);
  const names = await readdir(directory);
  const files: string[] = [];
  for (const name of names) {
    const filePath = path.join(directory, name);
    const info = await lstat(filePath);
    if (!info.isSymbolicLink() && info.isFile()) {
      await chmod(filePath, 0o600);
      files.push(name);
    }
  }
  return files;
}

export async function removeRegularFile(filePath: string): Promise<boolean> {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error("Jarvis data files must be regular files.");
    }
    await rm(filePath);
    return true;
  } catch (error) {
    if (isCode(error, "ENOENT")) return false;
    throw error;
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as NodeJS.ErrnoException).code === code;
}
