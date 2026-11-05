// Types core constructs and hands to a gateway. These are not validated at runtime.
import type {
  ConversationRef,
  DeliveryResult,
  InboundEvent,
  InteractionRef,
  MessageRef,
  SpaceId,
  UserId,
} from './schemas.ts';

export const PERSONA_ROLES = ['orchestrator', 'worker', 'board'] as const;
export type PersonaRole = (typeof PERSONA_ROLES)[number];

/** Who a delivered message speaks as. */
export interface Persona {
  name: string;
  role: PersonaRole;
}

/** A button-like choice attached to a delivered message; a press arrives as an `action` event. */
export interface Action {
  id: string;
  label: string;
}

export type RichTextInline =
  | { kind: 'text'; text: string }
  | { kind: 'emphasis'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; url: string; text: string }
  /** Core fills `user`, e.g. with the operator's id. */
  | { kind: 'mention'; user: UserId };

export type RichTextBlock =
  | { kind: 'paragraph'; children: readonly RichTextInline[] }
  | { kind: 'quote'; children: readonly RichTextInline[] }
  | { kind: 'code_block'; text: string };

/** Neutral rich text; each gateway renders it to its platform's format. */
export type RichText = readonly RichTextBlock[];

export const DELIVERY_TARGET_KINDS = ['open', 'reply', 'edit', 'close'] as const;
export type DeliveryTargetKind = (typeof DELIVERY_TARGET_KINDS)[number];

/**
 * Where a delivery goes. `open` starts a conversation in a space; `reply` posts into one;
 * `edit` replaces a message's text with the request body; `close` posts the body as the
 * closing line and marks the conversation done.
 */
export type DeliveryTarget =
  | { kind: 'open'; space: SpaceId; title: string }
  | { kind: 'reply'; conversation: ConversationRef }
  | { kind: 'edit'; message: MessageRef }
  | { kind: 'close'; conversation: ConversationRef };

export interface DeliverRequest {
  /** Stable delivery key from the outbox; the idempotency key (G3, G4, G7). */
  key: string;
  /** An earlier attempt with this key may have reached the platform (G3). */
  maybeSent: boolean;
  /** Earliest possible send of this key; absent means marker search must be unbounded (G3). */
  firstAttemptAt?: Date;
  target: DeliveryTarget;
  persona: Persona;
  body: RichText;
  actions?: readonly Action[];
}

export interface RecoverRequest {
  /** Conversations to read, each from after its last seen message when known. */
  conversations: readonly { ref: ConversationRef; after?: MessageRef }[];
  /** Lower time bound for everything recovered. */
  since: Date;
}

/**
 * What the gateway's platform supports, as data for the conformance suite (G12). Core never
 * branches on it; that rule is core's and is checked by core's tests, not by a gateway.
 */
export interface Capabilities {
  history: boolean;
  markerSearch: boolean;
  privateResponses: boolean;
}

/** Core's handler for inbound events; it resolves once the event is stored. */
export type InboundSink = (event: InboundEvent) => Promise<void>;

/**
 * `dropped`: the interaction expired or cannot be answered any more, or a private answer was
 * asked for and the platform has none (G15).
 */
export type RespondResult = 'sent' | 'dropped';

/**
 * A chat platform adapter. Core talks to platforms only through this interface.
 *
 * Obligations:
 * - G1: No retries of its own: one attempt per platform call, platform SDK retries off. The
 *   outbox owns retries.
 * - G2: A timeout, network error or other unknown request outcome returns
 *   `retry {uncertain: true}`; a rate limit returns `retry {afterMs}`. A known-invalid token,
 *   removed app, missing scope, or unavailable space destination returns
 *   `failed {permanent: true, scope: 'transport'}`: core raises one health item per gateway,
 *   and that space's rows wait. A rejection of this message only returns
 *   `scope: 'message'`, and only that row fails.
 * - G3: `deliver` is idempotent by `key`. With `maybeSent` the gateway prevents a duplicate its
 *   own way: a marker search, a marked repeat, or a second conversation carrying the same key.
 * - G4: Idempotent by step: a long body is split into parts `key#1..key#n`. With `maybeSent`,
 *   a gateway with marker search sends only the missing parts; one without it repeats each part
 *   with a repeat mark, as it does for a single message under G3.
 * - G5: `close` posts the closing line and sets a done mark; a mark already present counts as
 *   success.
 * - G6: `delivered` is returned only after every step is confirmed; it carries `conversation`
 *   for target `open`.
 * - G7: Every conversation root carries a marker of its delivery key; events from such a
 *   conversation set `originKey`.
 * - G8: One normalizer for live and recovered messages; a message keeps its `dedupeKey`.
 * - G9: An edit and a deletion get `dedupeKey`s of their own, distinct from the message's; each
 *   edit gets a distinct one.
 * - G10: No gateway state: conversations, cursors and dedupe belong to core. `recover` works
 *   from its request alone. It yields every missed event it can still obtain; when some may be
 *   lost and cannot be returned, it yields `gap`.
 * - G11: An inbound event is acknowledged to the platform only after `sink` resolves.
 * - G12: `capabilities` stay the same for the gateway's lifetime and match its behaviour (with
 *   `history: false`, `recover` yields `gap` when missed events cannot be returned). They never
 *   make an operation optional or change a result's shape: every operation follows the other
 *   obligations whatever they say.
 * - G13: After every connect and reconnect, the first one after `start` included, emit
 *   `connection {state: 'up'}` through `sink`; emit `{state: 'down'}` on loss. Core runs
 *   `recover` on `up`.
 * - G14: Every `connection` and `gap` event carries a `dedupeKey` unique to that occurrence,
 *   never reused, across restarts included.
 * - G15: With `private: true` and `capabilities.privateResponses: false`, `respond` posts
 *   nothing, publicly or otherwise, and returns `dropped`, so core can record the unanswered
 *   interaction.
 */
export interface Gateway {
  /** Gateway identifier, e.g. the platform name. */
  readonly kind: string;
  /** See G12. */
  readonly capabilities: Capabilities;
  /** Connects and starts passing inbound events to `sink` (G11, G13). */
  start(sink: InboundSink): Promise<void>;
  /** Disconnects; no events reach the sink after it resolves. */
  stop(): Promise<void>;
  /** Makes one delivery attempt (G1-G7). */
  deliver(request: DeliverRequest): Promise<DeliveryResult>;
  /** Yields events missed while disconnected, normalized as live ones (G8, G10, G14). */
  recover(request: RecoverRequest): AsyncIterable<InboundEvent>;
  /** Answers an interaction; a private answer never goes out publicly (G15). */
  respond(
    interaction: InteractionRef,
    text: RichText,
    options: { private: boolean; cliHint?: string },
  ): Promise<RespondResult>;
}
