import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { open, rm } from "node:fs/promises";
import path from "node:path";
import { containsCredentialLikeData } from "./memory.ts";
import { ensurePrivateDirectory, getDataDirectory } from "./persistence.ts";

export interface NoteInput {
  title: string;
  content: string;
}

export function validateHttpsUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Provide a valid HTTPS URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Only HTTPS URLs without a username or password are allowed.");
  }
  const sensitiveParameter = /^(?:token|key|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|credential|client[_-]?secret)$/i;
  if ([...url.searchParams.keys()].some((key) => sensitiveParameter.test(key)) ||
    /(?:token|key|password|secret|credential|authorization)\s*=/i.test(url.hash)) {
    throw new Error("URLs containing credential parameters are not allowed.");
  }
  return url.toString();
}

export async function saveNote(
  input: NoteInput,
  signal?: AbortSignal,
  dataDirectory = getDataDirectory(),
): Promise<string> {
  if (input.title.trim().length === 0 || input.title.length > 120) {
    throw new Error("Note titles must contain 1–120 characters.");
  }
  if (input.content.length > 20_000) {
    throw new Error("Note content must be at most 20000 characters.");
  }
  if (containsCredentialLikeData(`${input.title}\n${input.content}`)) {
    throw new Error("Credentials cannot be saved in Jarvis notes.");
  }

  const directory = path.join(dataDirectory, "notes");
  await ensurePrivateDirectory(directory);
  const notePath = path.join(directory, `${randomUUID()}.md`);
  if (signal?.aborted) throw new Error("Note save was cancelled.");
  const handle = await open(notePath, "wx", 0o600);
  try {
    await handle.writeFile(`# ${input.title}\n\n${input.content}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await rm(notePath, { force: true });
    throw error;
  } finally {
    await handle.close();
  }
  return notePath;
}

export async function openHttpsUrl(
  value: string,
  signal?: AbortSignal,
  platform = process.platform,
): Promise<string> {
  const url = validateHttpsUrl(value);
  if (platform !== "darwin") {
    throw new Error("Opening websites is available only on macOS.");
  }
  if (signal?.aborted) throw new Error("Opening the website was cancelled.");

  await new Promise<void>((resolve, reject) => {
    execFile("/usr/bin/open", [validateHttpsUrl(url)], { signal }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return url;
}
