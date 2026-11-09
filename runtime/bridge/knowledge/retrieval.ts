import { z } from "zod";
import { readWebpages, searchWeb, validateResearchUrl } from "../../agent/lib/web-research.ts";
import { containsCredentialLikeData } from "../../agent/lib/memory.ts";
import { BridgeError } from "../errors.ts";
import type { RetrieveInput } from "./contracts.ts";

export interface RetrievedEvidence {
  title: string; url: string; text: string; metadataOnly: boolean; truncated: boolean;
}
export interface RetrievalResult {
  sources: RetrievedEvidence[]; errors: string[];
  usage: { requests: number; estimatedUsd: null; accounting: "provider_cost_unavailable" };
}
async function bounded(response: Response, signal: AbortSignal, maximum = 2_000_000): Promise<string> {
  if (!response.ok) { await response.body?.cancel(); throw new BridgeError(`Research provider returned HTTP ${response.status}.`, 502); }
  if (!response.body) throw new BridgeError("Research provider returned no body.", 502);
  const reader = response.body.getReader(); const chunks: Buffer[] = []; let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted(); const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.length; if (bytes > maximum) throw new BridgeError("Research response exceeds its limit.", 502);
      chunks.push(Buffer.from(chunk.value));
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } finally { await reader.cancel().catch(() => {}); }
}
function xmlText(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/&(?:amp|lt|gt|quot|apos);/g, item => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" })[item]!)
    .replace(/\s+/g, " ").trim();
}
function tag(value: string, name: string): string { return xmlText(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i").exec(value)?.[1] ?? ""); }
const usage = () => ({ requests: 1, estimatedUsd: null, accounting: "provider_cost_unavailable" as const });

export async function retrievePublic(input: RetrieveInput, fetcher: typeof fetch, signal?: AbortSignal): Promise<RetrievalResult> {
  if (containsCredentialLikeData(input.query)) throw new BridgeError("Do not include credentials in research queries.", 400);
  const boundedSignal = AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]);
  if (input.provider === "tavily") {
    const result = await searchWeb({ query: input.query, maxResults: input.maxResults }, boundedSignal, { fetch: fetcher });
    return { sources: result.sources.map(source => ({ title: source.title, url: source.url, text: source.snippet ?? "", metadataOnly: true, truncated: source.truncated })),
      errors: result.errors.map(error => error.message), usage: usage() };
  }
  if (input.provider === "crossref") {
    const url = new URL("https://api.crossref.org/works");
    url.searchParams.set("query", input.query); url.searchParams.set("rows", String(input.maxResults));
    const body = JSON.parse(await bounded(await fetcher(url, { redirect: "error", signal: boundedSignal, headers: { accept: "application/json" } }), boundedSignal));
    const result = z.object({ message: z.object({ items: z.array(z.object({ DOI: z.string().max(500), title: z.array(z.string().max(4_000)).optional(), abstract: z.string().max(100_000).optional(), author: z.array(z.object({ given: z.string().optional(), family: z.string().optional() })).optional() })) }) }).parse(body);
    const sources = result.message.items.slice(0, input.maxResults).map(item => {
      const title = item.title?.[0] ?? item.DOI;
      const authors = item.author?.slice(0, 50).map(author => [author.given, author.family].filter(Boolean).join(" ")).join(", ") ?? "";
      return { title: title.slice(0, 240), url: validateResearchUrl(`https://doi.org/${encodeURI(item.DOI)}`),
        text: `Metadata only; full text was not retrieved.\nTitle: ${title}\nDOI: ${item.DOI}\nAuthors: ${authors}\n${xmlText(item.abstract ?? "")}`.slice(0, 16_000), metadataOnly: true, truncated: (item.abstract?.length ?? 0) > 15_000 };
    });
    return { sources, errors: [], usage: usage() };
  }
  const url = new URL("https://export.arxiv.org/api/query");
  url.searchParams.set("search_query", `all:${input.query}`); url.searchParams.set("start", "0"); url.searchParams.set("max_results", String(input.maxResults));
  const body = await bounded(await fetcher(url, { redirect: "error", signal: boundedSignal, headers: { accept: "application/atom+xml" } }), boundedSignal);
  if (/<!DOCTYPE|<!ENTITY/i.test(body) || !/<feed(?:\s|>)/i.test(body)) throw new BridgeError("Invalid scholarly metadata response.", 502);
  const entries = [...body.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)].slice(0, input.maxResults);
  const sources = entries.map(([, entry]) => {
    const rawId = tag(entry, "id"), parsed = new URL(rawId);
    if (!["arxiv.org", "www.arxiv.org"].includes(parsed.hostname) || !/^\/abs\/[A-Za-z0-9./-]+$/.test(parsed.pathname)) throw new BridgeError("Invalid arXiv source identity.", 502);
    parsed.protocol = "https:";
    const title = tag(entry, "title"), abstract = tag(entry, "summary");
    return { title: title.slice(0, 240), url: validateResearchUrl(parsed.href), text: `Metadata and abstract only; full text was not retrieved.\nTitle: ${title}\n${abstract}`.slice(0, 16_000), metadataOnly: true, truncated: abstract.length > 15_000 };
  });
  return { sources, errors: [], usage: usage() };
}

export async function extractPublic(urls: string[], fetcher: typeof fetch, signal?: AbortSignal): Promise<RetrievalResult> {
  const result = await readWebpages({ urls }, signal, { fetch: fetcher });
  return { sources: result.sources.map(source => ({ title: source.title, url: source.url, text: source.content ?? "", metadataOnly: false, truncated: source.truncated })),
    errors: result.errors.map(error => error.message), usage: usage() };
}
