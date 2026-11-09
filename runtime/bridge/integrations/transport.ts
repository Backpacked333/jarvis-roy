import { randomUUID } from "node:crypto";
import type { IntegrationContext, IntegrationLedger, IntegrationPrices } from "./contracts.ts";
import { IntegrationStore } from "./store.ts";

export class IntegrationTransport {
  readonly store: IntegrationStore; readonly ledger: IntegrationLedger; readonly prices: IntegrationPrices;
  readonly fetcher: typeof fetch; readonly now: () => Date;
  constructor(store: IntegrationStore, ledger: IntegrationLedger, prices: IntegrationPrices,
    fetcher: typeof fetch = fetch, now: () => Date = () => new Date()) {
    this.store = store; this.ledger = ledger; this.prices = prices; this.fetcher = fetcher; this.now = now;
  }
  price(name: keyof IntegrationPrices): number {
    const value = this.prices[name];
    if (value === undefined || !Number.isFinite(value) || value < 0) throw new Error(`Explicit provider price required: ${name}`);
    return value;
  }
  async request(url: URL, init: RequestInit, context: IntegrationContext, price: keyof IntegrationPrices, signal?: AbortSignal, beforeSend?: () => void): Promise<unknown> {
    const allowed = new Set(["api.telegram.org", "oauth2.googleapis.com", "gmail.googleapis.com", "www.googleapis.com", "api.twilio.com"]);
    if (url.protocol !== "https:" || !allowed.has(url.hostname) || url.username || url.password || url.port) throw new Error("Invalid provider endpoint");
    this.store.assertWritable(); signal?.throwIfAborted();
    const estimatedUsd = this.price(price), requestId = randomUUID();
    const reservation = await this.ledger.reserve({ projectId: context.projectId, objectiveId: context.objectiveId, requestId, authority: `integration:${price}`, estimatedUsd });
    let escaped = false, settled = false;
    try {
      signal?.throwIfAborted(); this.store.assertWritable(); beforeSend?.(); escaped = true;
      const response = await this.fetcher(url, { ...init, redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]) });
      const declared = Number(response.headers.get("content-length"));
      if (declared > 2_097_152) throw new Error("Provider response too large");
      const reader = response.body?.getReader(); const parts: Uint8Array[] = []; let size = 0;
      if (reader) while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 2_097_152) { await reader.cancel(); throw new Error("Provider response too large"); } parts.push(next.value); }
      await this.ledger.settle(reservation.id, { accounting: "measured", estimatedUsd }); settled = true;
      if (!response.ok) throw new ProviderHttpError(response.status);
      signal?.throwIfAborted();
      return JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
    } catch (error) {
      if (!settled) await this.ledger.settle(reservation.id, { accounting: escaped ? "unknown" : "measured", estimatedUsd: escaped ? null : 0 });
      throw error;
    }
  }
}
export class ProviderHttpError extends Error {
  readonly status: number;
  constructor(status: number) { super(`Provider request failed (${status})`); this.status = status; }
}
