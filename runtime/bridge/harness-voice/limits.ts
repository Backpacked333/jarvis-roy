export class TokenBucket {
  private tokens: number;
  private updated: number;
  private readonly capacity: number;
  private readonly perSecond: number;
  constructor(capacity: number, perSecond: number, now: number) {
    this.capacity = capacity;
    this.perSecond = perSecond;
    this.tokens = capacity;
    this.updated = now;
  }
  take(amount: number, now: number): boolean {
    this.tokens = Math.min(this.capacity, this.tokens + Math.max(0, now - this.updated) * this.perSecond / 1_000);
    this.updated = Math.max(this.updated, now);
    if (amount < 0 || amount > this.tokens) return false;
    this.tokens -= amount;
    return true;
  }
}

export class PCMQueue {
  private chunks: Buffer[] = [];
  private offset = 0;
  bytes = 0;
  readonly limit: number;
  constructor(limit: number) { this.limit = limit; }
  push(bytes: Buffer): void {
    if (!bytes.length || bytes.length % 2 || this.bytes + bytes.length > this.limit) throw new Error("PCM queue overflow or invalid sample");
    this.chunks.push(bytes);
    this.bytes += bytes.length;
  }
  take(maxBytes: number): Buffer | undefined {
    const first = this.chunks[0];
    if (!first) return undefined;
    const size = Math.min(maxBytes - maxBytes % 2, first.length - this.offset);
    const result = first.subarray(this.offset, this.offset + size);
    this.offset += size;
    this.bytes -= size;
    if (this.offset === first.length) { this.chunks.shift(); this.offset = 0; }
    return result;
  }
  clear(): void { this.chunks = []; this.offset = 0; this.bytes = 0; }
}
