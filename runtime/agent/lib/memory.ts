import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { ensurePrivateDirectory, getDataDirectory, listRegularFiles, removeRegularFile } from "./persistence.ts";

export interface MemoryEntry {
  id: string;
  text: string;
}

const MEMORY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CREDENTIAL_PATTERNS = [
  /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)["']?\s*[:=]\s*["']?\S+/i,
  /\b(?:token|client[_-]?secret|private[_-]?key|credential)["']?\s*[:=]\s*["']?\S+/i,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i,
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

export function containsCredentialLikeData(text: string): boolean {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text));
}

function memoryDirectory(dataDirectory = getDataDirectory()): string {
  return path.join(dataDirectory, "memories");
}

export async function listMemories(dataDirectory = getDataDirectory()): Promise<MemoryEntry[]> {
  const directory = memoryDirectory(dataDirectory);
  const names = await listRegularFiles(directory);
  const memories: MemoryEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || !MEMORY_ID.test(name.slice(0, -5))) continue;
    try {
      const entry = JSON.parse(await readFile(path.join(directory, name), "utf8")) as MemoryEntry;
      if (entry.id === name.slice(0, -5) && typeof entry.text === "string") {
        memories.push({ id: entry.id, text: entry.text });
      }
    } catch {
      continue;
    }
  }
  return memories.sort((left, right) => left.id.localeCompare(right.id));
}

export async function rememberPreference(
  text: string,
  signal?: AbortSignal,
  dataDirectory = getDataDirectory(),
): Promise<MemoryEntry> {
  if (text.trim().length === 0 || text.length > 2_000) {
    throw new Error("Memory text must contain 1–2000 characters.");
  }
  if (containsCredentialLikeData(text)) {
    throw new Error("Credentials cannot be saved in Jarvis memory.");
  }

  const directory = memoryDirectory(dataDirectory);
  await ensurePrivateDirectory(directory);
  const id = randomUUID();
  const destination = path.join(directory, `${id}.json`);
  const temporary = path.join(directory, `.${id}.${randomUUID()}.tmp`);
  const content = `${JSON.stringify({ id, text })}\n`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (signal?.aborted) throw new Error("Memory save was cancelled.");
    await rename(temporary, destination);
    return { id, text };
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function deleteMemory(
  id: string,
  dataDirectory = getDataDirectory(),
): Promise<boolean> {
  if (!MEMORY_ID.test(id)) return false;
  return removeRegularFile(path.join(memoryDirectory(dataDirectory), `${id}.json`));
}
