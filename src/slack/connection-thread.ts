import type { WebClient } from '@slack/web-api';
import type { KnownBlock } from '@slack/types';

// Current run's thread ts (reset each /connect invocation)
let currentThreadTs: string | null = null;
let currentChannelId: string | null = null;

/**
 * Start a new connection thread (call at beginning of each /connect run)
 */
export async function startConnectionThread(
  slackClient: WebClient,
  channelId: string
): Promise<{ threadTs: string }> {
  const parent = await slackClient.chat.postMessage({
    channel: channelId,
    text: `Suggested connections`,
  });

  if (!parent.ts) {
    throw new Error('Failed to create connection parent thread');
  }

  currentThreadTs = parent.ts;
  currentChannelId = channelId;
  return { threadTs: parent.ts };
}

/**
 * Post a message to the current connection thread
 */
export async function postConnectionMessage(
  slackClient: WebClient,
  channelId: string,
  payload: { text: string; blocks?: KnownBlock[] }
): Promise<{ threadTs: string; messageTs: string }> {
  // If no thread started yet, start one
  if (!currentThreadTs || currentChannelId !== channelId) {
    await startConnectionThread(slackClient, channelId);
  }

  const res = await slackClient.chat.postMessage({
    channel: channelId,
    thread_ts: currentThreadTs!,
    text: payload.text,
    blocks: payload.blocks,
  });
  return { threadTs: currentThreadTs!, messageTs: res.ts as string };
}

/**
 * Reset the current thread (call before a new /connect run if you want a fresh thread)
 */
export function resetConnectionThread(): void {
  currentThreadTs = null;
  currentChannelId = null;
}
