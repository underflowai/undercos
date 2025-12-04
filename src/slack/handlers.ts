import type { App } from '@slack/bolt';
import type { ResponsesRouter } from '../agent/responses-router.js';
import { extractMessageText, getThreadTs } from './app.js';
import { postApprovalMessage } from './interactions.js';

/**
 * Register message handlers for the Slack app
 */
export function registerHandlers(app: App, router: ResponsesRouter): void {
  // Handle app mentions (@ai-li)
  app.event('app_mention', async ({ event, client, context }) => {
    const botUserId = context.botUserId || '';
    const text = extractMessageText(event.text, botUserId);
    const threadTs = getThreadTs(event);
    const channelId = event.channel;
    const userId = event.user || 'unknown';

    console.log(`[Slack] @ai-li mention from ${userId}: "${text}"`);

    // Show thinking indicator
    const thinkingMsg = await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: '🤔 Thinking...',
    });

    try {
      // Process through the tool router
      const result = await router.process(text, { threadTs, channelId, userId });

      // Delete thinking message
      if (thinkingMsg.ts) {
        await client.chat.delete({
          channel: channelId,
          ts: thinkingMsg.ts,
        }).catch(() => {}); // Ignore if can't delete
      }

      // Handle pending actions that need approval
      if (result.pendingActions.length > 0) {
        for (const action of result.pendingActions) {
          await postApprovalMessage(client, channelId, threadTs, action);
        }
      }

      // Post the response
      if (result.response) {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: result.response,
          mrkdwn: true,
        });
      }
    } catch (error) {
      console.error('[Slack] Error:', error);
      
      // Delete thinking message on error
      if (thinkingMsg.ts) {
        await client.chat.delete({
          channel: channelId,
          ts: thinkingMsg.ts,
        }).catch(() => {});
      }

      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
  });

  // Handle direct messages
  app.event('message', async ({ event, client, context }) => {
    const msg = event as { bot_id?: string; subtype?: string; channel_type?: string; text?: string; user?: string; channel: string; ts: string; thread_ts?: string };
    
    // Only handle DMs, ignore bot messages and subtypes
    if (msg.bot_id || msg.subtype || msg.channel_type !== 'im') {
      return;
    }

    const botUserId = context.botUserId || '';
    const text = extractMessageText(msg.text || '', botUserId);
    const threadTs = getThreadTs(msg);
    const channelId = msg.channel;
    const userId = msg.user || 'unknown';

    if (!text) return;

    console.log(`[Slack] DM from ${userId}: "${text}"`);

    const thinkingMsg = await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: '🤔 Thinking...',
    });

    try {
      const result = await router.process(text, { threadTs, channelId, userId });

      if (thinkingMsg.ts) {
        await client.chat.delete({ channel: channelId, ts: thinkingMsg.ts }).catch(() => {});
      }

      if (result.pendingActions.length > 0) {
        for (const action of result.pendingActions) {
          await postApprovalMessage(client, channelId, threadTs, action);
        }
      }

      if (result.response) {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: result.response,
          mrkdwn: true,
        });
      }
    } catch (error) {
      if (thinkingMsg.ts) {
        await client.chat.delete({ channel: channelId, ts: thinkingMsg.ts }).catch(() => {});
      }
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
  });

  console.log('[Slack] Handlers registered');
}

