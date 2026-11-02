/** Exhaustiveness check: call it in the `default` branch of a switch over a union. */
export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
}

export {
  DELIVERY_TARGET_KINDS,
  PERSONA_ROLES,
  type Action,
  type Block,
  type Capabilities,
  type DeliverRequest,
  type DeliveryTarget,
  type DeliveryTargetKind,
  type Gateway,
  type InboundSink,
  type Inline,
  type Persona,
  type PersonaRole,
  type RecoverRequest,
  type RespondResult,
  type RichText,
} from './gateway/gateway.ts';
export {
  CONNECTION_STATES,
  DELIVERY_STATUSES,
  FAILURE_SCOPES,
  INBOUND_EVENT_KINDS,
  SPACE_IDS,
  conversationRefSchema,
  deliveryResultSchema,
  inboundEventSchema,
  interactionRefSchema,
  messageRefSchema,
  userIdSchema,
  type ConnectionState,
  type ConversationRef,
  type DeliveryResult,
  type DeliveryStatus,
  type FailureScope,
  type InboundEvent,
  type InboundEventKind,
  type InteractionRef,
  type MessageRef,
  type SpaceId,
  type UserId,
} from './gateway/schemas.ts';
