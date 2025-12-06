import type { WebClient } from '@slack/web-api';
import type { KnownBlock } from '@slack/types';

// Current run's thread ts (reset each /posts invocation)
let currentThreadTs: string | null = null;
let currentChannelId: string | null = null;

/**
 * Start a new post thread (call at beginning of each /posts run)
 */
export async function startPostThread(
  slackClient: WebClient,
  channelId: string
): Promise<{ threadTs: string }> {
  const parent = await slackClient.chat.postMessage({
    channel: channelId,
    text: `Suggested posts`,
  });

  if (!parent.ts) {
    throw new Error('Failed to create post parent thread');
  }

  currentThreadTs = parent.ts;
  currentChannelId = channelId;
  return { threadTs: parent.ts };
}

/**
 * Post a message to the current post thread
 */
export async function postToPostThread(
  slackClient: WebClient,
  channelId: string,
  payload: { text: string; blocks?: KnownBlock[] }
): Promise<{ threadTs: string; messageTs: string }> {
  // If no thread started yet, start one
  if (!currentThreadTs || currentChannelId !== channelId) {
    await startPostThread(slackClient, channelId);
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
 * Reset the current thread (call before a new /posts run if you want a fresh thread)
 */
export function resetPostThread(): void {
  currentThreadTs = null;
  currentChannelId = null;
}

