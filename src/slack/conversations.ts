/**
 * LinkedIn Conversation Management
 * 
 * Displays LinkedIn message threads in Slack
 */

import type { WebClient } from '@slack/web-api';
import type { KnownBlock, View } from '@slack/bolt';
import { 
  isUnipileConfigured,
  getActiveLinkedinAccountId,
  listChats,
  getChatMessages,
} from '../tools/unipile-sdk.js';

// Type definition
interface UnipileMessage {
  id: string;
  text?: string;
  sender_id?: string;
  sender_name?: string;
  timestamp: string;
  is_outbound?: boolean;
}

/**
 * Format a message for display in Slack
 */
function formatMessage(msg: UnipileMessage, myUserId: string): string {
  const isMe = msg.sender_id === myUserId || msg.is_outbound;
  const sender = isMe ? 'You' : msg.sender_name || 'Them';
  const time = new Date(msg.timestamp).toLocaleString();
  const text = msg.text || '[No message content]';
  
  if (isMe) {
    return `*${sender}* (${time}):\n${text}`;
  } else {
    return `*${sender}* (${time}):\n>${text.replace(/\n/g, '\n>')}`;
  }
}

/**
 * Fetch and format a conversation thread
 */
export async function getConversationThread(chatId: string): Promise<{
  messages: UnipileMessage[];
  formatted: string;
}> {
  if (!isUnipileConfigured()) {
    return { messages: [], formatted: 'Unable to fetch conversation - Unipile not configured' };
  }
  
  try {
    const messages = await getChatMessages(chatId, 20) as unknown as UnipileMessage[];
    
    // Get my user ID (simplified - we'll mark outbound messages)
    const myUserId = await getActiveLinkedinAccountId() || '';
    
    // Reverse to show oldest first
    const sortedMessages = [...messages].reverse();
    
    // Format messages for display
    const formatted = sortedMessages
      .filter((msg: any) => !msg.hidden && !msg.deleted)
      .map((msg: any) => formatMessage(msg as UnipileMessage, myUserId))
      .join('\n\n---\n\n');
    
    return { messages: sortedMessages, formatted };
  } catch (error) {
    console.error('[Conversations] Failed to fetch thread:', error);
    return { messages: [], formatted: 'Error fetching conversation' };
  }
}

/**
 * Build Slack blocks for displaying a conversation
 */
export function buildConversationBlocks(
  formatted: string,
  senderName: string,
  chatId: string
): KnownBlock[] {
  const blocks: KnownBlock[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `Conversation with ${senderName}`,
        emoji: false,
      },
    },
    {
      type: 'divider',
    },
  ];
  
  // Split into chunks if too long (Slack has text limits)
  const maxLength = 2900;
  if (formatted.length > maxLength) {
    const chunks = [];
    let remaining = formatted;
    while (remaining.length > 0) {
      // Try to split at a message boundary
      let splitIndex = remaining.lastIndexOf('\n\n---\n\n', maxLength);
      if (splitIndex === -1 || splitIndex < maxLength / 2) {
        splitIndex = maxLength;
      }
      chunks.push(remaining.slice(0, splitIndex));
      remaining = remaining.slice(splitIndex).replace(/^[\n-]+/, '');
    }
    
    for (const chunk of chunks) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: chunk || '(empty)',
        },
      });
    }
  } else {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: formatted || 'No messages in this conversation yet.',
      },
    });
  }
  
  blocks.push({
    type: 'divider',
  });
  
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Reply', emoji: false },
        style: 'primary',
        action_id: 'linkedin_reply',
        value: JSON.stringify({ chatId, senderName }),
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Refresh', emoji: false },
        action_id: 'linkedin_refresh_thread',
        value: JSON.stringify({ chatId, senderName }),
      },
    ],
  });
  
  return blocks;
}

/**
 * Build a Slack modal view for displaying a conversation
 */
export function buildConversationModal(
  formatted: string,
  senderName: string,
  chatId: string
): View {
  return {
    type: 'modal',
    callback_id: 'linkedin_conversation_modal',
    title: {
      type: 'plain_text',
      text: `Chat: ${senderName.slice(0, 20)}`,
      emoji: false,
    },
    close: {
      type: 'plain_text',
      text: 'Close',
      emoji: false,
    },
    blocks: buildConversationBlocks(formatted, senderName, chatId) as View['blocks'],
    private_metadata: JSON.stringify({ chatId, senderName }),
  };
}

/**
 * Open conversation thread in a Slack modal
 */
export async function openConversationModal(
  client: WebClient,
  triggerId: string,
  chatId: string,
  senderName: string
): Promise<void> {
  const { formatted } = await getConversationThread(chatId);
  const view = buildConversationModal(formatted, senderName, chatId);
  
  await client.views.open({
    trigger_id: triggerId,
    view,
  });
}

