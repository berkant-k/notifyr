/**
 * An in-process stand-in for the Redis commands `RedisStore` uses.
 *
 * It exists so the store contract can run against `RedisStore` in the normal
 * suite: this project's tests need no dev server and no network, and CI has no
 * Redis to point at. What that buys is real coverage of *this* store's logic —
 * ordering, trimming, counter arithmetic, the 409, continuity folding. What it
 * cannot cover is Upstash's own wire behaviour, so a live smoke test is still
 * owed before anything is deployed.
 *
 * Values are held as strings and JSON-decoded on read, which is what the
 * Upstash client does to responses: storing a JSON string and reading back a
 * parsed object is the behaviour `RedisStore` has to tolerate, so the fake had
 * better reproduce it rather than hand back exactly what it was given.
 */

import type { RedisLike, RedisPipelineLike } from "@/lib/redisStore";

type Entry = { hash: Map<string, string> } | { list: string[] };

const isHash = (entry: Entry): entry is { hash: Map<string, string> } => "hash" in entry;
const isList = (entry: Entry): entry is { list: string[] } => "list" in entry;

/** Mirrors the Upstash client's automatic deserialisation of responses. */
function decode(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** Redis range ends are inclusive, and -1 means "the last element". */
function resolveEnd(stop: number, length: number): number {
  if (stop < 0) return length + stop;
  return Math.min(stop, length - 1);
}

export class FakeRedis implements RedisLike {
  private readonly data = new Map<string, Entry>();
  /** Recorded but never enforced: no test waits an hour. */
  readonly ttls = new Map<string, number>();

  private hash(key: string, create = false): Map<string, string> | null {
    const entry = this.data.get(key);
    if (entry && isHash(entry)) return entry.hash;
    if (entry) return null;
    if (!create) return null;

    const hash = new Map<string, string>();
    this.data.set(key, { hash });
    return hash;
  }

  private list(key: string, create = false): string[] | null {
    const entry = this.data.get(key);
    if (entry && isList(entry)) return entry.list;
    if (entry) return null;
    if (!create) return null;

    const list: string[] = [];
    this.data.set(key, { list });
    return list;
  }

  async hsetnx(key: string, field: string, value: string): Promise<number> {
    const hash = this.hash(key, true)!;
    if (hash.has(field)) return 0;
    hash.set(field, String(value));
    return 1;
  }

  async hget(key: string, field: string): Promise<unknown> {
    const value = this.hash(key)?.get(field);
    return value === undefined ? null : decode(value);
  }

  /** Redis's own vocabulary: -2 for a missing key, -1 for one with no expiry. */
  async ttl(key: string): Promise<number> {
    if (!this.data.has(key)) return -2;
    return this.ttls.get(key) ?? -1;
  }

  async hgetall(key: string): Promise<Record<string, unknown> | null> {
    const hash = this.hash(key);
    if (!hash || hash.size === 0) return null;

    return Object.fromEntries([...hash].map(([field, value]) => [field, decode(value)]));
  }

  async hset(key: string, kv: Record<string, string | number>): Promise<number> {
    const hash = this.hash(key, true)!;
    for (const [field, value] of Object.entries(kv)) hash.set(field, String(value));
    return Object.keys(kv).length;
  }

  async hdel(key: string, field: string): Promise<number> {
    const hash = this.hash(key);
    return hash?.delete(field) ? 1 : 0;
  }

  async exists(key: string): Promise<number> {
    return this.data.has(key) ? 1 : 0;
  }

  private hincrby(key: string, field: string, increment: number): number {
    const hash = this.hash(key, true)!;
    const next = Number(hash.get(field) ?? 0) + increment;
    hash.set(field, String(next));
    return next;
  }

  private lpush(key: string, element: string): number {
    const list = this.list(key, true)!;
    list.unshift(element);
    return list.length;
  }

  private ltrim(key: string, start: number, stop: number): "OK" {
    const list = this.list(key);
    if (list) list.splice(0, list.length, ...list.slice(start, resolveEnd(stop, list.length) + 1));
    return "OK";
  }

  private lrange(key: string, start: number, stop: number): unknown[] {
    const list = this.list(key);
    if (!list) return [];
    return list.slice(start, resolveEnd(stop, list.length) + 1).map(decode);
  }

  pipeline(): RedisPipelineLike {
    const queued: (() => unknown)[] = [];

    // Commands run at exec, in order, exactly as a real pipeline delivers them.
    const pipeline: RedisPipelineLike = {
      hset: (key, kv) => {
        queued.push(() => this.hset(key, kv));
        return pipeline;
      },
      hincrby: (key, field, increment) => {
        queued.push(() => this.hincrby(key, field, increment));
        return pipeline;
      },
      lpush: (key, element) => {
        queued.push(() => this.lpush(key, element));
        return pipeline;
      },
      ltrim: (key, start, stop) => {
        queued.push(() => this.ltrim(key, start, stop));
        return pipeline;
      },
      lrange: (key, start, stop) => {
        queued.push(() => this.lrange(key, start, stop));
        return pipeline;
      },
      hgetall: (key) => {
        queued.push(() => this.hgetall(key));
        return pipeline;
      },
      ttl: (key) => {
        queued.push(() => this.ttl(key));
        return pipeline;
      },
      expire: (key, seconds) => {
        queued.push(() => {
          if (!this.data.has(key)) return 0;
          this.ttls.set(key, seconds);
          return 1;
        });
        return pipeline;
      },
      exec: async () => Promise.all(queued.map((run) => run())),
    };

    return pipeline;
  }
}
