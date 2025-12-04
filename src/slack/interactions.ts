import type { App, BlockAction, ButtonAction } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { ResponsesRouter, PendingAction } from '../agent/responses-router.js';

/**
 * Register interactive component handlers (buttons, modals)
 */
export function registerInteractions(app: App, router: ResponsesRouter): void {
  // Approve button
  app.action<BlockAction<ButtonAction>>('approve_action', async ({ ack, body, client }) => {
    await ack();

    const actionId = body.actions[0].value || '';
    const threadTs = body.message?.thread_ts || body.message?.ts || '';
    const channelId = body.channel?.id || '';

    if (!actionId) return;

    console.log(`[Slack] Approve: ${actionId}`);

    try {
      const result = await router.executeAction(actionId);

      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: result.success 
          ? `✅ Done! ${result.message || ''}`
          : `❌ Failed: ${result.error}`,
      });

      // Update original message
      if (body.message?.ts) {
        await client.chat.update({
          channel: channelId,
          ts: body.message.ts,
          text: '✅ Approved and executed',
          blocks: [{
            type: 'section',
            text: { type: 'mrkdwn', text: '✅ *Approved and executed*' },
          }],
        });
      }
    } catch (error) {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `❌ Error: ${error instanceof Error ? error.message : 'Unknown'}`,
      });
    }
  });

  // Edit button - opens modal
  app.action<BlockAction<ButtonAction>>('edit_action', async ({ ack, body, client }) => {
    await ack();

    const actionData = JSON.parse(body.actions[0].value || '{}');
    
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'edit_modal',
        private_metadata: JSON.stringify({
          actionId: actionData.id,
          threadTs: body.message?.thread_ts || body.message?.ts,
          channelId: body.channel?.id,
          messageTs: body.message?.ts,
        }),
        title: { type: 'plain_text', text: 'Edit Draft' },
        submit: { type: 'plain_text', text: 'Send' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [{
          type: 'input',
          block_id: 'draft_block',
          element: {
            type: 'plain_text_input',
            action_id: 'draft_input',
            multiline: true,
            initial_value: actionData.draft || '',
          },
          label: { type: 'plain_text', text: 'Your message' },
        }],
      },
    });
  });

  // Modal submission
  app.view('edit_modal', async ({ ack, body, view, client }) => {
    await ack();

    const meta = JSON.parse(view.private_metadata);
    const newDraft = view.state.values.draft_block.draft_input.value || '';

    try {
      const result = await router.executeAction(meta.actionId, newDraft);

      await client.chat.postMessage({
        channel: meta.channelId,
        thread_ts: meta.threadTs,
        text: result.success ? '✅ Sent with your edits!' : `❌ Failed: ${result.error}`,
      });

      if (meta.messageTs) {
        await client.chat.update({
          channel: meta.channelId,
          ts: meta.messageTs,
          text: '✏️ Edited and sent',
          blocks: [{
            type: 'section',
            text: { type: 'mrkdwn', text: '✏️ *Edited and sent*' },
          }],
        });
      }
    } catch (error) {
      await client.chat.postMessage({
        channel: meta.channelId,
        thread_ts: meta.threadTs,
        text: `❌ Error: ${error instanceof Error ? error.message : 'Unknown'}`,
      });
    }
  });

  // Skip button
  app.action<BlockAction<ButtonAction>>('skip_action', async ({ ack, body, client }) => {
    await ack();

    const actionId = body.actions[0].value || '';
    const channelId = body.channel?.id || '';

    if (actionId) {
      router.cancelAction(actionId);
    }

    if (body.message?.ts) {
      await client.chat.update({
        channel: channelId,
        ts: body.message.ts,
        text: '⏭️ Skipped',
        blocks: [{
          type: 'section',
          text: { type: 'mrkdwn', text: '⏭️ *Skipped*' },
        }],
      });
    }
  });

  console.log('[Slack] Interactions registered');
}

/**
 * Post an approval message with Approve/Edit/Skip buttons
 */
export async function postApprovalMessage(
  client: WebClient,
  channelId: string,
  threadTs: string,
  action: PendingAction
): Promise<void> {
  const blocks: Array<{type: string; text?: {type: string; text: string}; elements?: Array<unknown>}> = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${action.title}*\n${action.description}`,
      },
    },
  ];

  // Show draft/preview if available
  if (action.draft) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `\`\`\`${action.draft}\`\`\``,
      },
    });
  }

  // Add context (post URL, profile URL, etc.)
  if (action.context) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `_${action.context}_`,
      },
    });
  }

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '✅ Approve', emoji: true },
        style: 'primary',
        action_id: 'approve_action',
        value: action.id,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '✏️ Edit', emoji: true },
        action_id: 'edit_action',
        value: JSON.stringify({ id: action.id, draft: action.draft }),
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '⏭️ Skip', emoji: true },
        action_id: 'skip_action',
        value: action.id,
      },
    ],
  });

  await client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: action.title,
    blocks,
  });
}

