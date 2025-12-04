/**
 * LinkedIn Messaging Handlers for Slack
 * 
 * Handles:
 * - Replying to LinkedIn messages
 * - Viewing conversation threads
 * - Starting new conversations
 */

import type { App, BlockAction, ButtonAction, ViewSubmitAction } from '@slack/bolt';
import { getUnipileClient, getActiveAccountId } from '../tools/unipile.js';
import { openConversationModal, getConversationThread, buildConversationBlocks } from './conversations.js';

/**
 * Register LinkedIn messaging handlers with the Slack app
 */
export function registerLinkedInMessagingHandlers(app: App): void {
  // ==========================================================================
  // VIEW THREAD
  // ==========================================================================
  
  app.action<BlockAction<ButtonAction>>('linkedin_view_thread', async ({ ack, body, client }) => {
    await ack();
    
    try {
      const data = JSON.parse(body.actions[0].value || '{}');
      const { chatId, senderName } = data;
      
      if (!chatId) {
        console.error('[LinkedIn] No chatId provided for view thread');
        return;
      }
      
      await openConversationModal(client, body.trigger_id, chatId, senderName || 'LinkedIn User');
    } catch (error) {
      console.error('[LinkedIn] Failed to open conversation modal:', error);
    }
  });
  
  // ==========================================================================
  // REFRESH THREAD
  // ==========================================================================
  
  app.action<BlockAction<ButtonAction>>('linkedin_refresh_thread', async ({ ack, body, client }) => {
    await ack();
    
    try {
      const data = JSON.parse(body.actions[0].value || '{}');
      const { chatId, senderName } = data;
      
      if (!chatId) return;
      
      // Fetch updated conversation
      const { formatted } = await getConversationThread(chatId);
      const blocks = buildConversationBlocks(formatted, senderName || 'LinkedIn User', chatId);
      
      // Update the modal
      if (body.view?.id) {
        await client.views.update({
          view_id: body.view.id,
          view: {
            type: 'modal',
            callback_id: 'linkedin_conversation_modal',
            title: {
              type: 'plain_text',
              text: `Chat: ${(senderName || 'LinkedIn User').slice(0, 20)}`,
              emoji: false,
            },
            close: {
              type: 'plain_text',
              text: 'Close',
              emoji: false,
            },
            blocks: blocks as typeof body.view.blocks,
            private_metadata: JSON.stringify({ chatId, senderName }),
          },
        });
      }
    } catch (error) {
      console.error('[LinkedIn] Failed to refresh thread:', error);
    }
  });
  
  // ==========================================================================
  // REPLY TO MESSAGE
  // ==========================================================================
  
  app.action<BlockAction<ButtonAction>>('linkedin_reply', async ({ ack, body, client }) => {
    await ack();
    
    try {
      const data = JSON.parse(body.actions[0].value || '{}');
      const { chatId, senderName, senderId, profileUrl } = data;
      
      if (!chatId) {
        console.error('[LinkedIn] No chatId provided for reply');
        return;
      }
      
      // Open reply modal
      await client.views.open({
        trigger_id: body.trigger_id,
        view: {
          type: 'modal',
          callback_id: 'linkedin_reply_submit',
          private_metadata: JSON.stringify({
            chatId,
            senderName,
            senderId,
            profileUrl,
            channelId: body.channel?.id,
            messageTs: body.message?.ts,
          }),
          title: {
            type: 'plain_text',
            text: 'Reply on LinkedIn',
            emoji: false,
          },
          submit: {
            type: 'plain_text',
            text: 'Send Reply',
            emoji: false,
          },
          close: {
            type: 'plain_text',
            text: 'Cancel',
            emoji: false,
          },
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `Replying to *${senderName || 'LinkedIn User'}*`,
              },
            },
            {
              type: 'input',
              block_id: 'message_block',
              element: {
                type: 'plain_text_input',
                action_id: 'message_input',
                multiline: true,
                placeholder: {
                  type: 'plain_text',
                  text: 'Type your reply...',
                },
              },
              label: {
                type: 'plain_text',
                text: 'Message',
                emoji: false,
              },
            },
          ],
        },
      });
    } catch (error) {
      console.error('[LinkedIn] Failed to open reply modal:', error);
    }
  });
  
  // Handle reply submission
  app.view<ViewSubmitAction>('linkedin_reply_submit', async ({ ack, body, view, client }) => {
    await ack();
    
    try {
      const metadata = JSON.parse(view.private_metadata || '{}');
      const { chatId, senderName, channelId, messageTs } = metadata;
      
      const message = view.state.values.message_block?.message_input?.value;
      
      if (!message || !chatId) {
        console.error('[LinkedIn] Missing message or chatId');
        return;
      }
      
      // Send the message via Unipile
      const unipileClient = getUnipileClient();
      
      if (!unipileClient) {
        console.error('[LinkedIn] Unipile not configured');
        return;
      }
      
      const result = await unipileClient.sendMessage({
        chat_id: chatId,
        text: message,
      });
      
      // Update the original Slack message to show reply was sent
      if (channelId && messageTs) {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: messageTs,
          text: `✅ Reply sent to ${senderName || 'LinkedIn user'}:\n>"${message.slice(0, 100)}${message.length > 100 ? '...' : ''}"`,
        });
      }
      
      console.log(`[LinkedIn] Reply sent to ${senderName}: "${message.slice(0, 50)}..."`);
    } catch (error) {
      console.error('[LinkedIn] Failed to send reply:', error);
    }
  });
  
  // ==========================================================================
  // START NEW MESSAGE (from connection accepted notification)
  // ==========================================================================
  
  app.action<BlockAction<ButtonAction>>('linkedin_start_message', async ({ ack, body, client }) => {
    await ack();
    
    try {
      const data = JSON.parse(body.actions[0].value || '{}');
      const { providerId, name, profileUrl, chatId } = data;
      
      // Open message composition modal
      await client.views.open({
        trigger_id: body.trigger_id,
        view: {
          type: 'modal',
          callback_id: 'linkedin_send_message_submit',
          private_metadata: JSON.stringify({
            providerId,
            name,
            profileUrl,
            chatId, // May exist if they already have a chat
            channelId: body.channel?.id,
            messageTs: body.message?.ts,
          }),
          title: {
            type: 'plain_text',
            text: 'Message on LinkedIn',
            emoji: false,
          },
          submit: {
            type: 'plain_text',
            text: 'Send Message',
            emoji: false,
          },
          close: {
            type: 'plain_text',
            text: 'Cancel',
            emoji: false,
          },
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `Sending message to *${name || 'LinkedIn User'}*`,
              },
            },
            {
              type: 'input',
              block_id: 'message_block',
              element: {
                type: 'plain_text_input',
                action_id: 'message_input',
                multiline: true,
                placeholder: {
                  type: 'plain_text',
                  text: 'Type your message...',
                },
              },
              label: {
                type: 'plain_text',
                text: 'Message',
                emoji: false,
              },
            },
          ],
        },
      });
    } catch (error) {
      console.error('[LinkedIn] Failed to open message modal:', error);
    }
  });
  
  // Handle new message submission
  app.view<ViewSubmitAction>('linkedin_send_message_submit', async ({ ack, body, view, client }) => {
    await ack();
    
    try {
      const metadata = JSON.parse(view.private_metadata || '{}');
      const { providerId, name, chatId, channelId, messageTs } = metadata;
      
      const message = view.state.values.message_block?.message_input?.value;
      
      if (!message) {
        console.error('[LinkedIn] Missing message');
        return;
      }
      
      const unipileClient = getUnipileClient();
      const accountId = await getActiveAccountId();
      
      if (!unipileClient || !accountId) {
        console.error('[LinkedIn] Unipile not configured');
        return;
      }
      
      let result;
      
      if (chatId) {
        // Send to existing chat
        result = await unipileClient.sendMessage({
          chat_id: chatId,
          text: message,
        });
      } else if (providerId) {
        // Start new chat
        result = await unipileClient.sendDirectMessage({
          account_id: accountId,
          attendee_provider_id: providerId,
          text: message,
        });
      } else {
        console.error('[LinkedIn] No chatId or providerId');
        return;
      }
      
      // Update the original Slack message
      if (channelId && messageTs) {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: messageTs,
          text: `✅ Message sent to ${name || 'LinkedIn user'}:\n>"${message.slice(0, 100)}${message.length > 100 ? '...' : ''}"`,
        });
      }
      
      console.log(`[LinkedIn] Message sent to ${name}: "${message.slice(0, 50)}..."`);
    } catch (error) {
      console.error('[LinkedIn] Failed to send message:', error);
    }
  });
  
  // ==========================================================================
  // VIEW PROFILE LINK (no-op, handled by URL button)
  // ==========================================================================
  
  app.action<BlockAction<ButtonAction>>('linkedin_view_profile_link', async ({ ack }) => {
    await ack();
    // This is just a link button, no action needed
  });
  
  console.log('[Slack] LinkedIn messaging handlers registered');
}

