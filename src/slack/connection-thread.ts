import type { WebClient } from '@slack/web-api';
import type { KnownBlock } from '@slack/types';
import { getConnectionThread, saveConnectionThread } from '../db/connection-queue.js';

function getDateKey(date: Date = new Date()): string {
  return date.toISOString().split('T')[0];
}

export async function ensureConnectionThread(
  slackClient: WebClient,
  channelId: string,
  date: Date = new Date()
): Promise<{ threadTs: string }> {
  const key = getDateKey(date);
  const existing = getConnectionThread(key);
  if (existing) {
    return { threadTs: existing.thread_ts };
  }

  const parent = await slackClient.chat.postMessage({
    channel: channelId,
    text: `Actions for ${key}`,
  });

  if (!parent.ts) {
    throw new Error('Failed to create connection parent thread');
  }

  saveConnectionThread(key, channelId, parent.ts);
  return { threadTs: parent.ts };
}

export async function postConnectionMessage(
  slackClient: WebClient,
  channelId: string,
  payload: { text: string; blocks?: KnownBlock[] },
  date: Date = new Date()
): Promise<{ threadTs: string; messageTs: string }> {
  const { threadTs } = await ensureConnectionThread(slackClient, channelId, date);
  const res = await slackClient.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: payload.text,
    blocks: payload.blocks,
  });
  return { threadTs, messageTs: res.ts as string };
}
