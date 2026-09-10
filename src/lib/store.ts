/**
 * Storage for endpoints and their messages.
 *
 * `MessageStore` is the seam: every method is async so a Redis/Postgres/KV
 * implementation can replace `InMemoryStore` without touching callers.
 *
 * The in-memory implementation is a development convenience only. On Vercel,
 * each serverless instance gets its own module scope, so a notification handled
 * by one instance is invisible to a dashboard poll served by another, and all
 * data is lost on cold start. See README "Known limitations".
 *
 * A deployment that sets UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN
 * gets `RedisStore` instead. Those variables are the switch: there is no
 * separate flag that could drift out of step with whether the credentials to
 * reach a shared store actually exist.
 */

import { Redis } from "@upstash/redis";

import { observe, type ContinuityObservation } from "@/lib/continuity";
import { randomEndpointId } from "@/lib/endpointId";
import { RedisStore } from "@/lib/redisStore";
import {
  DEFAULT_HEARTBEAT_PERIOD_SECONDS,
  defaultResponseRules,
  emptyNotificationCounts,
  MAX_RECENT_MESSAGES,
  MAX_STORED_MESSAGES,
  type Endpoint,
  type EndpointSnapshot,
  type Message,
  type NewMessage,
  type PayloadContent,
  type ResponseRules,
  type SubscriptionContinuity,
  type ValidationError,
} from "@/lib/types";

export interface MessageStore {
  /**
   * Create an endpoint, optionally with a caller-supplied id (already validated
   * by `lib/endpointId`). Returns null when that id is already in use — we do
   * not silently hand back the existing endpoint, since that would let anyone
   * join a stranger's stream by guessing its name.
   */
  createEndpoint(id?: string): Promise<Endpoint | null>;
  getEndpoint(endpointId: string): Promise<Endpoint | null>;
  /**
   * Just the version, for a dashboard asking "anything new?" — the answer is
   * no on almost every poll, and fetching a whole snapshot to discover that is
   * the dominant cost of running this on a metered store. Null when unknown.
   */
  getVersion(endpointId: string): Promise<number | null>;
  /** Returns null when the endpoint does not exist. */
  addMessage(endpointId: string, message: NewMessage): Promise<Message | null>;
  /** Returns null when the endpoint does not exist. */
  getSnapshot(endpointId: string, limit?: number): Promise<EndpointSnapshot | null>;
  /**
   * Merge a partial set of response rules. Returns the updated endpoint, or
   * null when it does not exist.
   */
  updateResponseRules(
    endpointId: string,
    patch: Partial<ResponseRules>,
  ): Promise<Endpoint | null>;
  /**
   * Set the payload level notifications are checked against, or null to check
   * only their internal consistency. Returns null when the endpoint does not
   * exist. Applies to notifications received from now on: stored messages carry
   * the expectation they were judged against and are never re-validated.
   */
  updateExpectedPayloadContent(
    endpointId: string,
    expected: PayloadContent | null,
  ): Promise<Endpoint | null>;
  /**
   * Set the heartbeat period, in seconds; 0 switches the check off. Clears the
   * missed-heartbeat counts, which were accumulated against the old period and
   * mean nothing under a new one. Returns null when the endpoint is unknown.
   */
  updateHeartbeatPeriod(endpointId: string, seconds: number): Promise<Endpoint | null>;
  /**
   * Fold one validated notification into its subscription's continuity record,
   * returning whatever that revealed — a late heartbeat, a jump in the event
   * counter — for the caller to store on the message.
   *
   * Separate from addMessage because the findings have to exist before the
   * message they belong to is written.
   */
  recordContinuity(
    endpointId: string,
    observation: Omit<ContinuityObservation, "heartbeatPeriodSeconds">,
  ): Promise<ValidationError[]>;
}

/**
 * Subscriptions tracked per endpoint. One endpoint is normally one
 * subscription; the cap stops a shared endpoint from growing without bound.
 */
const MAX_TRACKED_SUBSCRIPTIONS = 20;

/** Cap on live endpoints; the oldest is evicted past this. Bounds memory on a public deployment. */
const MAX_ENDPOINTS = 500;

export class InMemoryStore implements MessageStore {
  /** Insertion-ordered, so the first key is the oldest endpoint. */
  private endpoints = new Map<string, Endpoint>();
  /** endpointId -> messages, newest first. */
  private messages = new Map<string, Message[]>();

  async createEndpoint(id?: string): Promise<Endpoint | null> {
    if (id !== undefined && this.endpoints.has(id)) return null;

    if (this.endpoints.size >= MAX_ENDPOINTS) {
      const oldest = this.endpoints.keys().next();
      if (!oldest.done) {
        this.endpoints.delete(oldest.value);
        this.messages.delete(oldest.value);
      }
    }

    const endpoint: Endpoint = {
      id: id ?? randomEndpointId(),
      createdAt: new Date().toISOString(),
      // Nothing expires here: this store bounds itself with MAX_ENDPOINTS, and
      // the process it lives in is the real deadline. Null says "no moment to
      // name" rather than "never", which the dashboard renders as the caveat.
      expiresAt: null,
      validCount: 0,
      invalidCount: 0,
      notificationCounts: emptyNotificationCounts(),
      responseRules: defaultResponseRules(),
      expectedPayloadContent: null,
      heartbeatPeriodSeconds: DEFAULT_HEARTBEAT_PERIOD_SECONDS,
      continuity: [],
      version: 0,
    };
    this.endpoints.set(endpoint.id, endpoint);
    this.messages.set(endpoint.id, []);
    return endpoint;
  }

  async getEndpoint(endpointId: string): Promise<Endpoint | null> {
    return this.endpoints.get(endpointId) ?? null;
  }

  async getVersion(endpointId: string): Promise<number | null> {
    return this.endpoints.get(endpointId)?.version ?? null;
  }

  async addMessage(endpointId: string, input: NewMessage): Promise<Message | null> {
    const endpoint = this.endpoints.get(endpointId);
    if (!endpoint) return null;

    const message: Message = { ...input, id: crypto.randomUUID(), endpointId };

    const list = this.messages.get(endpointId) ?? [];
    list.unshift(message);
    // Counters are cumulative, so they must not be derived from this trimmed list.
    list.length = Math.min(list.length, MAX_STORED_MESSAGES);
    this.messages.set(endpointId, list);

    if (message.isValid) endpoint.validCount += 1;
    else endpoint.invalidCount += 1;

    // Only valid notifications are tallied by type: a Bundle that failed
    // validation has not established what kind of notification it was.
    if (message.isValid && message.notificationType) {
      endpoint.notificationCounts[message.notificationType] += 1;
    }

    endpoint.version += 1;

    return message;
  }

  async getSnapshot(
    endpointId: string,
    limit: number = MAX_RECENT_MESSAGES,
  ): Promise<EndpointSnapshot | null> {
    const endpoint = this.endpoints.get(endpointId);
    if (!endpoint) return null;

    return {
      // Copy the nested objects too, or callers would hold a live reference.
      endpoint: {
        ...endpoint,
        notificationCounts: { ...endpoint.notificationCounts },
        responseRules: structuredClone(endpoint.responseRules),
        continuity: structuredClone(endpoint.continuity),
      },
      messages: (this.messages.get(endpointId) ?? []).slice(0, limit),
    };
  }

  async updateResponseRules(
    endpointId: string,
    patch: Partial<ResponseRules>,
  ): Promise<Endpoint | null> {
    const endpoint = this.endpoints.get(endpointId);
    if (!endpoint) return null;

    endpoint.responseRules = { ...endpoint.responseRules, ...patch };
    // Bump the version so an open dashboard picks the change up on its next
    // poll, including one in another tab.
    endpoint.version += 1;

    return { ...endpoint, responseRules: structuredClone(endpoint.responseRules) };
  }

  async updateExpectedPayloadContent(
    endpointId: string,
    expected: PayloadContent | null,
  ): Promise<Endpoint | null> {
    const endpoint = this.endpoints.get(endpointId);
    if (!endpoint) return null;

    endpoint.expectedPayloadContent = expected;
    endpoint.version += 1;

    return { ...endpoint, responseRules: structuredClone(endpoint.responseRules) };
  }

  async updateHeartbeatPeriod(endpointId: string, seconds: number): Promise<Endpoint | null> {
    const endpoint = this.endpoints.get(endpointId);
    if (!endpoint) return null;

    endpoint.heartbeatPeriodSeconds = seconds;
    // A count of heartbeats missed against a 120s period says nothing once the
    // period is 30s. The timestamps survive: the channel did not go quiet just
    // because the expectation changed.
    for (const record of endpoint.continuity) record.missedHeartbeats = 0;
    endpoint.version += 1;

    return {
      ...endpoint,
      responseRules: structuredClone(endpoint.responseRules),
      continuity: structuredClone(endpoint.continuity),
    };
  }

  async recordContinuity(
    endpointId: string,
    observation: Omit<ContinuityObservation, "heartbeatPeriodSeconds">,
  ): Promise<ValidationError[]> {
    const endpoint = this.endpoints.get(endpointId);
    if (!endpoint) return [];

    const index = endpoint.continuity.findIndex(
      (record) => record.reference === observation.reference,
    );
    const previous: SubscriptionContinuity | null = index === -1 ? null : endpoint.continuity[index];

    const { record, findings } = observe(previous, {
      ...observation,
      heartbeatPeriodSeconds: endpoint.heartbeatPeriodSeconds,
    });

    // Most recently active first, so the panel leads with the live subscription
    // and the cap evicts whichever has been silent longest.
    if (index !== -1) endpoint.continuity.splice(index, 1);
    endpoint.continuity.unshift(record);
    endpoint.continuity.length = Math.min(
      endpoint.continuity.length,
      MAX_TRACKED_SUBSCRIPTIONS,
    );

    return findings;
  }
}

// Next.js reloads modules on edit in dev, which would otherwise reset the store
// on every save. Parking the singleton on globalThis keeps it across reloads.
const globalForStore = globalThis as typeof globalThis & {
  __notifyrStore?: MessageStore;
};

/**
 * Credentials, not configuration: a deployment either has somewhere shared to
 * put its data or it does not, and asking a second question about it only
 * creates a way for the two answers to disagree.
 */
export function createStore(): MessageStore {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return new RedisStore(new Redis({ url, token }));

  // Only the in-memory store needs the HMR parking above; RedisStore keeps its
  // state out of the process entirely, which is the whole point of it.
  return (globalForStore.__notifyrStore ??= new InMemoryStore());
}

export const store: MessageStore = createStore();
