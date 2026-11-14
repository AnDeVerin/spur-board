import type { WebClient } from '@slack/web-api';
import { type DeliverRequest, type DeliveryResult, type Gateway } from '@spur-board/contracts';
import { apiFailure, isAlreadyReacted, readMessages } from './api.ts';
import { conversationRef, messageRef, parseRef } from './ref.ts';
import {
  iconFor,
  markerFromBlocks,
  markerId,
  messageBlocks,
  originMarkerId,
  renderText,
  splitContext,
  splitText,
} from './render.ts';

export interface SlackChannels {
  orchestrators: string;
  feed: string;
}

function messageTs(message: unknown): string | undefined {
  return typeof message === 'object' &&
    message !== null &&
    'ts' in message &&
    typeof message.ts === 'string'
    ? message.ts
    : undefined;
}

function messageMarker(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null || !('blocks' in message)) return undefined;
  return markerFromBlocks(message.blocks);
}

function oldest(at: Date | undefined): string | undefined {
  if (at === undefined || !Number.isFinite(at.getTime())) return undefined;
  // Slack excludes an exact `oldest` match unless `inclusive` is set. Include the prior second.
  return String(Math.max(0, Math.floor(at.getTime() / 1000) - 1));
}

function marked(messages: readonly unknown[], marker: string): string | undefined {
  return messageTs(messages.find((message) => messageMarker(message) === marker));
}

function failedMessage(reason: string): DeliveryResult {
  return { status: 'failed', permanent: true, scope: 'message', reason };
}

export function createDeliveryGateway(
  client: WebClient,
  channels: SlackChannels,
): Pick<Gateway, 'kind' | 'capabilities' | 'deliver'> {
  async function post(
    channel: string,
    threadTs: string | undefined,
    text: string,
    marker: string,
    request: DeliverRequest,
    first: boolean,
    context: readonly string[],
    originKey?: string,
  ): Promise<string> {
    const response = await client.chat.postMessage({
      channel,
      ...(threadTs === undefined ? {} : { thread_ts: threadTs }),
      text,
      blocks: messageBlocks(
        text,
        marker,
        first ? request.actions : undefined,
        originKey,
        first ? context : [],
      ),
      username: request.persona.name,
      icon_emoji: iconFor(request.persona),
    });
    if (typeof response.ts !== 'string') throw new Error('chat.postMessage returned no timestamp');
    return response.ts;
  }

  async function permalink(channel: string, ts: string): Promise<string> {
    const response = await client.chat.getPermalink({ channel, message_ts: ts });
    if (typeof response.permalink !== 'string' || response.permalink.length === 0) {
      throw new Error('chat.getPermalink returned no permalink');
    }
    return response.permalink;
  }

  async function deliver(request: DeliverRequest): Promise<DeliveryResult> {
    const { body, context } = splitContext(request.body);
    const text = renderText(body);
    const parts = splitText(text);
    if (parts === null) return failedMessage('part_too_long');
    if (parts.length === 0) return failedMessage('no_text');
    if ((request.actions?.length ?? 0) > 25) return failedMessage('too_many_actions');
    const keys = parts.map((_, i) =>
      parts.length === 1 ? request.key : `${request.key}#${String(i + 1)}`,
    );
    const markers = keys.map(markerId);
    if (markers.some((marker) => marker === null)) return failedMessage('marker_too_long');
    if (
      request.target.kind === 'open' &&
      parts.length > 1 &&
      originMarkerId(request.key) === null
    ) {
      return failedMessage('marker_too_long');
    }
    let confirmed = false;
    try {
      const target = request.target;
      if (target.kind === 'edit') {
        const addressed = parseRef(target.message);
        if (addressed === null) return failedMessage('invalid_message_ref');
        const marker = markers[0];
        if (marker === null || marker === undefined || parts.length !== 1) {
          return failedMessage('edit_too_long');
        }
        if (request.maybeSent) {
          const history = await readMessages(client, {
            channel: addressed.channel,
            threadTs: addressed.threadTs,
          });
          const existing = history.find((message) => messageTs(message) === addressed.ts);
          if (existing !== undefined && messageMarker(existing) === keys[0]) confirmed = true;
        }
        if (!confirmed) {
          await client.chat.update({
            channel: addressed.channel,
            ts: addressed.ts,
            text: parts[0] ?? '',
            blocks: messageBlocks(parts[0] ?? '', marker, request.actions, undefined, context),
          });
          confirmed = true;
        }
        return {
          status: 'delivered',
          message: target.message,
          permalink: await permalink(addressed.channel, addressed.ts),
        };
      }

      const destination =
        target.kind === 'open'
          ? { channel: channels[target.space], threadTs: undefined }
          : parseRef(target.conversation);
      if (destination === null || destination.channel.length === 0) {
        return failedMessage('invalid_conversation_ref');
      }
      const channel = destination.channel;
      let threadTs = destination.threadTs;
      let firstTs: string | undefined;
      let prior: unknown[] = [];
      if (request.maybeSent) {
        try {
          if (target.kind === 'open') {
            const lowerBound = oldest(request.firstAttemptAt);
            prior = await readMessages(client, {
              channel,
              ...(lowerBound === undefined ? {} : { oldest: lowerBound }),
            });
            firstTs = marked(prior, keys[0] ?? request.key);
            if (firstTs !== undefined) {
              threadTs = firstTs;
              confirmed = true;
              prior = await readMessages(client, { channel, threadTs });
            } else prior = [];
          } else {
            if (threadTs === undefined) return failedMessage('invalid_conversation_ref');
            prior = await readMessages(client, { channel, threadTs });
          }
        } catch (error) {
          return apiFailure(error);
        }
      }

      for (let i = 0; i < parts.length; i++) {
        const key = keys[i];
        const marker = markers[i];
        if (key === undefined || marker === null || marker === undefined) {
          return failedMessage('invalid_marker');
        }
        const existing = request.maybeSent ? marked(prior, key) : undefined;
        if (i === 0 && firstTs !== undefined) continue;
        const ts =
          existing ??
          (await post(
            channel,
            threadTs,
            parts[i] ?? '',
            marker,
            request,
            i === 0,
            context,
            target.kind === 'open' && i === 0 && parts.length > 1 ? request.key : undefined,
          ));
        confirmed = true;
        if (i === 0) firstTs = ts;
        if (target.kind === 'open' && i === 0) threadTs = ts;
      }
      if (firstTs === undefined) return { status: 'retry', uncertain: true };
      if (threadTs === undefined) return { status: 'retry', uncertain: true };
      if (target.kind === 'close') {
        try {
          await client.reactions.add({ channel, timestamp: threadTs, name: 'white_check_mark' });
        } catch (error) {
          if (!isAlreadyReacted(error)) throw error;
        }
        confirmed = true;
      }
      return {
        status: 'delivered',
        ...(target.kind === 'open' ? { conversation: conversationRef(channel, threadTs) } : {}),
        message: messageRef(channel, firstTs, threadTs),
        permalink: await permalink(channel, firstTs),
      };
    } catch (error) {
      const result = apiFailure(error);
      if (!confirmed) return result;
      // G2: after a confirmed step part of the body is out, so any failure retries as uncertain.
      return result.status === 'retry'
        ? { ...result, uncertain: true }
        : { status: 'retry', uncertain: true };
    }
  }

  return {
    kind: 'slack',
    capabilities: { history: true, markerSearch: true, privateResponses: true },
    deliver,
  };
}
