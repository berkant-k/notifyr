/**
 * The shared-store implementation of `MessageStore`, for deployments where more
 * than one instance serves the same endpoint.
 *
 * Redis is not here for speed. Three of the store's invariants are things the
 * in-memory implementation holds by being careful, and Redis holds structurally:
 * `HINCRBY` counters cannot walk backwards when retention trims the list,
 * `LPUSH` + `LTRIM` make the 100-message cap the write itself, and `HSETNX`
 * makes "a taken id returns 409" atomic rather than a check-then-set that is a
 * race in principle. See docs/REDIS-STORE.md for the full mapping.
 *
 * Every key carries a TTL refreshed on write, which is also the endpoint expiry
 * a public instance needs; there is deliberately no equivalent of the in-memory
 * store's `MAX_ENDPOINTS` cap, because a TTL bounds the same thing better.
 */

import { observe, type ContinuityObservation } from "@/lib/continuity";
import { randomEndpointId } from "@/lib/endpointId";
import type { MessageStore } from "@/lib/store";
import {
  DEFAULT_HEARTBEAT_PERIOD_SECONDS,
  defaultResponseRules,
  emptyNotificationCounts,
  MAX_RECENT_MESSAGES,
  MAX_STORED_MESSAGES,
  NOTIFICATION_TYPES,
  OVERRIDABLE_NOTIFICATION_TYPES,
  type Endpoint,
  type EndpointSnapshot,
  type Message,
  type NewMessage,
  type PayloadContent,
  type ResponseRule,
  type ResponseRules,
  type SubscriptionContinuity,
  type ValidationError,
} from "@/lib/types";

/**
 * The commands this store uses, and nothing else.
 *
 * Narrower than the Upstash client on purpose: it documents the whole surface
 * this depends on, and lets the test suite run the same contract against a fake
 * without a network or a container.
 */
export interface RedisPipelineLike {
  hset(key: string, kv: Record<string, string | number>): RedisPipelineLike;
  hincrby(key: string, field: string, increment: number): RedisPipelineLike;
  lpush(key: string, element: string): RedisPipelineLike;
  ltrim(key: string, start: number, stop: number): RedisPipelineLike;
  lrange(key: string, start: number, stop: number): RedisPipelineLike;
  hgetall(key: string): RedisPipelineLike;
  expire(key: string, seconds: number): RedisPipelineLike;
  exec(): Promise<unknown[]>;
}

export interface RedisLike {
  hsetnx(key: string, field: string, value: string): Promise<number>;
  hgetall(key: string): Promise<Record<string, unknown> | null>;
  hset(key: string, kv: Record<string, string | number>): Promise<number>;
  hdel(key: string, field: string): Promise<number>;
  exists(key: string): Promise<number>;
  pipeline(): RedisPipelineLike;
}

/**
 * An hour with no traffic. This is endpoint expiry: abandoned endpoints stop
 * holding stored `x-forwarded-for` values indefinitely, which is a retention
 * question as much as a capacity one.
 */
export const TTL_SECONDS = 3600;

/** Matches the in-memory store: one endpoint is normally one subscription. */
const MAX_TRACKED_SUBSCRIPTIONS = 20;

const endpointKey = (id: string) => `endpoint:${id}`;
const messagesKey = (id: string) => `endpoint:${id}:messages`;

export class RedisStore implements MessageStore {
  constructor(private readonly redis: RedisLike) {}

  async createEndpoint(id?: string): Promise<Endpoint | null> {
    const endpoint = newEndpoint(id ?? randomEndpointId());
    const key = endpointKey(endpoint.id);

    // The 409, atomically: of two racing creates only one sets the field, so
    // nobody joins a stranger's stream by guessing its name even when the two
    // requests land on different instances.
    if ((await this.redis.hsetnx(key, "id", endpoint.id)) === 0) return null;

    await this.redis.pipeline().hset(key, toHash(endpoint)).expire(key, TTL_SECONDS).exec();

    return endpoint;
  }

  async getEndpoint(endpointId: string): Promise<Endpoint | null> {
    const hash = await this.redis.hgetall(endpointKey(endpointId));
    return hash && hash.id !== undefined ? fromHash(hash) : null;
  }

  async addMessage(endpointId: string, input: NewMessage): Promise<Message | null> {
    const key = endpointKey(endpointId);
    // A pipeline cannot branch, and an unknown endpoint is a null rather than a
    // throw, so the existence check has to be its own round trip.
    if ((await this.redis.exists(key)) === 0) return null;

    const message: Message = { ...input, id: crypto.randomUUID(), endpointId };
    const pipeline = this.redis.pipeline();

    pipeline.lpush(messagesKey(endpointId), JSON.stringify(message));
    // Retention is the write itself. The counters below are HINCRBY on separate
    // fields, so trimming can never make them decrease.
    pipeline.ltrim(messagesKey(endpointId), 0, MAX_STORED_MESSAGES - 1);
    pipeline.hincrby(key, message.isValid ? "validCount" : "invalidCount", 1);
    // Only valid notifications are tallied by type: an invalid Bundle has not
    // established what kind of notification it was.
    if (message.isValid && message.notificationType) {
      pipeline.hincrby(key, countField(message.notificationType), 1);
    }
    pipeline.hincrby(key, "version", 1);
    pipeline.expire(key, TTL_SECONDS);
    pipeline.expire(messagesKey(endpointId), TTL_SECONDS);

    await pipeline.exec();
    return message;
  }

  async getSnapshot(
    endpointId: string,
    limit: number = MAX_RECENT_MESSAGES,
  ): Promise<EndpointSnapshot | null> {
    // One round trip, and the TTL refresh rides along in it. Traffic is not the
    // only sign an endpoint is alive; somebody watching it counts too.
    const results = await this.redis
      .pipeline()
      .hgetall(endpointKey(endpointId))
      .lrange(messagesKey(endpointId), 0, limit - 1)
      .expire(endpointKey(endpointId), TTL_SECONDS)
      .expire(messagesKey(endpointId), TTL_SECONDS)
      .exec();

    const hash = results[0] as Record<string, unknown> | null;
    if (!hash || hash.id === undefined) return null;

    // Nothing is deep-copied on the way out: deserialising is already a copy,
    // so "snapshots must not alias live state" holds by construction here.
    const raw = (results[1] ?? []) as unknown[];
    return {
      endpoint: fromHash(hash),
      messages: raw.map((entry) => parseJson<Message>(entry)).filter((m): m is Message => m !== null),
    };
  }

  async updateResponseRules(
    endpointId: string,
    patch: Partial<ResponseRules>,
  ): Promise<Endpoint | null> {
    const key = endpointKey(endpointId);
    if ((await this.redis.exists(key)) === 0) return null;

    // One field per notification type, so a partial patch is a partial HSET
    // rather than a read-merge-write: two dashboards toggling different
    // switches cannot overwrite each other.
    const fields: Record<string, string> = {};
    for (const [type, rule] of Object.entries(patch)) {
      if (rule) fields[ruleField(type)] = JSON.stringify(rule);
    }

    const pipeline = this.redis.pipeline();
    if (Object.keys(fields).length > 0) pipeline.hset(key, fields);
    // Bump the version even for an empty patch, so a caller that sent one still
    // sees a consistent snapshot rather than a stale-looking one.
    pipeline.hincrby(key, "version", 1);
    pipeline.expire(key, TTL_SECONDS);
    await pipeline.exec();

    return this.getEndpoint(endpointId);
  }

  async updateExpectedPayloadContent(
    endpointId: string,
    expected: PayloadContent | null,
  ): Promise<Endpoint | null> {
    const key = endpointKey(endpointId);
    if ((await this.redis.exists(key)) === 0) return null;

    // Absent means unset, so unsetting is a delete rather than a sentinel.
    if (expected === null) await this.redis.hdel(key, "expectedPayloadContent");
    else await this.redis.hset(key, { expectedPayloadContent: expected });

    await this.redis.pipeline().hincrby(key, "version", 1).expire(key, TTL_SECONDS).exec();

    return this.getEndpoint(endpointId);
  }

  async updateHeartbeatPeriod(endpointId: string, seconds: number): Promise<Endpoint | null> {
    const key = endpointKey(endpointId);
    const hash = await this.redis.hgetall(key);
    if (!hash || hash.id === undefined) return null;

    // A count of heartbeats missed against a 120s period says nothing once the
    // period is 30s. The timestamps survive: the channel did not go quiet just
    // because the expectation changed.
    const continuity = readContinuity(hash).map((record) => ({ ...record, missedHeartbeats: 0 }));

    await this.redis
      .pipeline()
      .hset(key, {
        heartbeatPeriodSeconds: seconds,
        continuity: JSON.stringify(continuity),
      })
      .hincrby(key, "version", 1)
      .expire(key, TTL_SECONDS)
      .exec();

    return this.getEndpoint(endpointId);
  }

  async recordContinuity(
    endpointId: string,
    observation: Omit<ContinuityObservation, "heartbeatPeriodSeconds">,
  ): Promise<ValidationError[]> {
    const key = endpointKey(endpointId);
    const hash = await this.redis.hgetall(key);
    if (!hash || hash.id === undefined) return [];

    const records = readContinuity(hash);
    const index = records.findIndex((record) => record.reference === observation.reference);

    const { record, findings } = observe(index === -1 ? null : records[index], {
      ...observation,
      heartbeatPeriodSeconds: numberFrom(hash.heartbeatPeriodSeconds),
    });

    // Most recently active first, so the panel leads with the live subscription
    // and the cap evicts whichever has been silent longest.
    if (index !== -1) records.splice(index, 1);
    records.unshift(record);
    records.length = Math.min(records.length, MAX_TRACKED_SUBSCRIPTIONS);

    // The one read-modify-write in this store, and the one place it is weaker
    // than the in-memory one: two notifications for the same endpoint landing
    // on two instances at once can lose a fold. The blast radius is a warning
    // counter under-counting — never a corrupt record, and never a stored
    // message, a tally or a wire status, which are all HINCRBY and LPUSH.
    await this.redis.hset(key, { continuity: JSON.stringify(records) });
    return findings;
  }
}

function newEndpoint(id: string): Endpoint {
  return {
    id,
    createdAt: new Date().toISOString(),
    validCount: 0,
    invalidCount: 0,
    notificationCounts: emptyNotificationCounts(),
    responseRules: defaultResponseRules(),
    expectedPayloadContent: null,
    heartbeatPeriodSeconds: DEFAULT_HEARTBEAT_PERIOD_SECONDS,
    continuity: [],
    version: 0,
  };
}

const countField = (type: string) => `count:${type}`;
const ruleField = (type: string) => `rule:${type}`;

/** Flatten for storage: counters get their own fields so HINCRBY can reach them. */
function toHash(endpoint: Endpoint): Record<string, string | number> {
  const hash: Record<string, string | number> = {
    id: endpoint.id,
    createdAt: endpoint.createdAt,
    validCount: endpoint.validCount,
    invalidCount: endpoint.invalidCount,
    heartbeatPeriodSeconds: endpoint.heartbeatPeriodSeconds,
    continuity: JSON.stringify(endpoint.continuity),
    version: endpoint.version,
  };

  for (const type of NOTIFICATION_TYPES) hash[countField(type)] = endpoint.notificationCounts[type];
  for (const type of OVERRIDABLE_NOTIFICATION_TYPES) {
    hash[ruleField(type)] = JSON.stringify(endpoint.responseRules[type]);
  }
  if (endpoint.expectedPayloadContent !== null) {
    hash.expectedPayloadContent = endpoint.expectedPayloadContent;
  }

  return hash;
}

/** The inverse of `toHash`, and the only other place field names are known. */
function fromHash(hash: Record<string, unknown>): Endpoint {
  const notificationCounts = emptyNotificationCounts();
  for (const type of NOTIFICATION_TYPES) {
    notificationCounts[type] = numberFrom(hash[countField(type)]);
  }

  const responseRules = defaultResponseRules();
  for (const type of OVERRIDABLE_NOTIFICATION_TYPES) {
    const stored = parseJson<ResponseRule>(hash[ruleField(type)]);
    if (stored) responseRules[type] = stored;
  }

  const expected = hash.expectedPayloadContent;

  return {
    id: String(hash.id),
    createdAt: String(hash.createdAt),
    validCount: numberFrom(hash.validCount),
    invalidCount: numberFrom(hash.invalidCount),
    notificationCounts,
    responseRules,
    expectedPayloadContent: expected === undefined || expected === null
      ? null
      : (String(expected) as PayloadContent),
    heartbeatPeriodSeconds: numberFrom(hash.heartbeatPeriodSeconds),
    continuity: readContinuity(hash),
    version: numberFrom(hash.version),
  };
}

function readContinuity(hash: Record<string, unknown>): SubscriptionContinuity[] {
  return parseJson<SubscriptionContinuity[]>(hash.continuity) ?? [];
}

function numberFrom(value: unknown): number {
  if (typeof value === "number") return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Values come back either as the string we wrote or as the object Upstash
 * already parsed for us — its client JSON-decodes responses by default — so
 * both have to be accepted rather than one assumed.
 */
function parseJson<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
