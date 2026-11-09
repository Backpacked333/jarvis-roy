import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { MAX_EXTRACTED_CHARACTERS, type EvidencePassage } from "./contracts.ts";
import { BridgeError } from "../errors.ts";

export interface ExtractedPage { text: string; page: number | null }
export type PdfExtractor = (bytes: Uint8Array, signal?: AbortSignal) => Promise<ExtractedPage[]>;

/** pdftotext receives bytes on stdin: no model-selected executable or filesystem path. */
export const extractPdf: PdfExtractor = async (bytes, signal) => {
  const binary = ["/usr/bin/pdftotext", "/opt/homebrew/bin/pdftotext", "/usr/local/bin/pdftotext"].find(existsSync);
  if (!binary) throw new BridgeError("PDF text extraction is unavailable. Install Poppler or import a text/Markdown export; scanned PDFs require OCR first.", 503);
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["-layout", "-enc", "UTF-8", "-", "-"], {
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, stdio: ["pipe", "pipe", "ignore"],
    });
    const chunks: Buffer[] = []; let size = 0, failure: Error | undefined;
    const fail = (error: Error) => { failure ??= error; child.kill("SIGKILL"); };
    const abort = () => fail(new BridgeError("Document extraction cancelled.", 409));
    const timer = setTimeout(() => fail(new BridgeError("PDF text extraction timed out.", 408)), 15_000);
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", () => fail(new BridgeError("PDF extractor could not start.", 503)));
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_EXTRACTED_CHARACTERS * 4) fail(new BridgeError("Extracted document exceeds the text limit.", 413));
      else chunks.push(chunk);
    });
    child.stdin.on("error", () => {});
    child.on("close", code => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new BridgeError("PDF text extraction failed. Encrypted or scanned documents may require a text export.", 422));
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.length > MAX_EXTRACTED_CHARACTERS) return reject(new BridgeError("Extracted document exceeds the text limit.", 413));
      resolve(text.split("\f").map((text, index) => ({ text, page: index + 1 })).filter(value => value.text.trim()));
    });
    child.stdin.end(bytes);
  });
};

const textExtensions = /\.(?:txt|md|markdown|csv|tsv|json|jsonl|yaml|yml|toml|xml|html|css|js|jsx|mjs|cjs|ts|tsx|py|swift|c|h|cpp|hpp|rs|go|java|sh|sql|tex|r)$/i;
export async function extractDocument(bytes: Buffer, filename: string, mediaType: string, pdf: PdfExtractor, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (mediaType === "application/pdf" || /\.pdf$/i.test(filename)) {
    if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new BridgeError("The file is not a PDF document.", 422);
    const pages = await pdf(bytes, signal);
    if (pages.length > 2_000 || pages.reduce((n, page) => n + page.text.length, 0) > MAX_EXTRACTED_CHARACTERS) throw new BridgeError("Extracted document exceeds the text limit.", 413);
    return { pages, extraction: pages.some(page => page.text.trim()) ? "pdf_text" as const : "empty" as const };
  }
  if (!mediaType.startsWith("text/") && !textExtensions.test(filename) && !["application/json", "application/xml"].includes(mediaType)) {
    throw new BridgeError("Unsupported document format. Use PDF, text, Markdown, CSV, or a supported source-code file.", 415);
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new BridgeError("Text documents must use UTF-8.", 422); }
  if (text.includes("\0")) throw new BridgeError("Binary content is not a supported text document.", 422);
  if (text.length > MAX_EXTRACTED_CHARACTERS) throw new BridgeError("Document exceeds the text indexing limit.", 413);
  return { pages: [{ text, page: null }], extraction: text.trim() ? "text" as const : "empty" as const };
}

export function documentFormat(filename = ""): "pdf" | "markdown" | "csv" | "code" | "text" {
  if (/\.pdf$/i.test(filename)) return "pdf";
  if (/\.(md|markdown)$/i.test(filename)) return "markdown";
  if (/\.(csv|tsv)$/i.test(filename)) return "csv";
  if (/\.(ts|tsx|js|jsx|py|swift|rs|go|java|c|cpp|h|hpp|sql|sh)$/i.test(filename)) return "code";
  return "text";
}
export function passageParts(pages: ExtractedPage[], options: { filename?: string } = {}): Pick<EvidencePassage, "text" | "locator">[] {
  const output: Pick<EvidencePassage, "text" | "locator">[] = [];
  const format = documentFormat(options.filename);
  for (const page of pages) {
    const lines = page.text.replace(/\r\n?/g, "\n").split("\n");
    let buffer = "", start = 1, end = 1, section: string | undefined, symbol: string | undefined;
    const headings: string[] = [];
    const flush = () => { if (buffer.trim()) output.push({ text: buffer, locator: { page: page.page, lineStart: start, lineEnd: end,
      ...(section ? { section } : {}), ...(symbol ? { symbol } : {}),
      ...(format === "csv" ? { rowStart: start, rowEnd: end } : {}),
    } }); buffer = ""; };
    lines.forEach((line, index) => {
      const heading = format === "markdown" ? /^(#{1,6})\s+(.+)$/.exec(line) : null;
      const declaration = format === "code" ? /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|def|func|struct|interface|enum|fn)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line) : null;
      if (heading || declaration || !line.trim() && format !== "csv") flush();
      if (heading) { headings.length = heading[1].length - 1; headings[heading[1].length - 1] = heading[2]; section = headings.filter(Boolean).join(" / ").slice(0, 1000); }
      if (declaration) symbol = declaration[1].slice(0, 240);
      if (format === "csv" && index === 0) section = `Columns (original header): ${line}`.slice(0, 1000);
      if (buffer.length + line.length + 1 > 4_000) flush();
      if (!buffer) start = index + 1;
      end = index + 1;
      // A long single source line retains its locator across bounded fragments.
      for (let offset = 0; offset < line.length; offset += 4_000) {
        const part = line.slice(offset, offset + 4_000);
        if (buffer.length + part.length + 1 > 4_000) flush();
        if (!buffer) start = index + 1;
        buffer += (buffer ? "\n" : "") + part;
        if (offset + 4_000 < line.length) flush();
      }
      if (!line.length && buffer) buffer += "\n";
    });
    flush();
  }
  if (output.length > 5_000) throw new BridgeError("Document has too many indexed passages.", 413);
  return output;
}
