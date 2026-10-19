/**
 * 有界队列（PRD §7.4 / D5）。
 * 溢出时丢最旧的记录并累加 dropped_count；条数与总字节两条上限都生效。
 * 纯内存、无定时器，可在 `node --test` 里直接跑。
 */
export interface BoundedQueueOptions {
  maxRecords: number;
  maxBytes: number;
}

export class BoundedQueue<T> {
  private items: Array<{ item: T; bytes: number }> = [];
  private totalBytes = 0;
  private dropped = 0;
  // 注意：不能用「构造参数属性」写法（TS parameter property），
  // Node 的 strip-only 模式会报 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX
  private readonly sizeOf: (item: T) => number;
  private readonly options: BoundedQueueOptions;

  constructor(sizeOf: (item: T) => number, options: BoundedQueueOptions) {
    this.sizeOf = sizeOf;
    this.options = options;
  }

  push(item: T): void {
    const bytes = this.sizeOf(item);
    this.items.push({ item, bytes });
    this.totalBytes += bytes;
    this.trim();
  }

  /** 推送失败时把整批放回队首，保持原有顺序 */
  requeue(batch: T[]): void {
    const restored = batch.map((item) => ({ item, bytes: this.sizeOf(item) }));
    this.items.unshift(...restored);
    this.totalBytes += restored.reduce((sum, entry) => sum + entry.bytes, 0);
    this.trim();
  }

  take(max: number): T[] {
    const taken = this.items.splice(0, max);
    for (const entry of taken) this.totalBytes -= entry.bytes;
    return taken.map((entry) => entry.item);
  }

  /**
   * 按「条数 + 字节」两条上限取：服务端有 2 MB 硬上限，
   * 超限的整批会被 413 拒绝，所以客户端自己先按字节装车。
   */
  takeWithin(maxRecords: number, maxBytes: number): T[] {
    const taken: Array<{ item: T; bytes: number }> = [];
    let bytes = 0;
    while (this.items.length > 0 && taken.length < maxRecords) {
      const next = this.items[0];
      if (taken.length > 0 && bytes + next.bytes > maxBytes) break;
      this.items.shift();
      taken.push(next);
      bytes += next.bytes;
    }
    this.totalBytes -= bytes;
    return taken.map((entry) => entry.item);
  }

  get depth(): number {
    return this.items.length;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  clear(): void {
    this.items = [];
    this.totalBytes = 0;
  }

  private trim(): void {
    while (this.items.length > this.options.maxRecords || this.totalBytes > this.options.maxBytes) {
      const removed = this.items.shift();
      if (!removed) break;
      this.totalBytes -= removed.bytes;
      this.dropped += 1;
    }
  }
}
