/**
 * Post Discovery Handlers
 * 
 * Slack handlers for post-related actions (comment, like, skip)
 */

import type { App, BlockAction, ButtonAction } from '@slack/bolt';
import { executeLinkedInAction } from '../../tools/linkedin.js';

function parseActionValue(raw?: string): any {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function updateQueueStatus(
  client: any,
  channelId?: string,
  messageTs?: string,
  statusText?: string
): Promise<void> {
  if (!channelId || !messageTs || !statusText) return;
  await client.chat.update({
    channel: channelId,
    ts: messageTs,
    text: statusText,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: statusText },
      },
    ],
  });
}

export function registerPostHandlers(app: App): void {
  // Comment on a discovered post
  app.action<BlockAction<ButtonAction>>('discovery_comment', async ({ ack, body, client }) => {
    await ack();

    const data = parseActionValue(body.actions[0].value);
    const channelId = body.channel?.id || '';
    const messageTs = body.message?.ts || '';

    // Open modal to edit comment before posting
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'discovery_comment_submit',
        private_metadata: JSON.stringify({
          postId: data.postId,
          postUrl: data.postUrl,
          channelId,
          messageTs,
          queueChannelId: data.queueChannelId,
          queueMessageTs: data.queueMessageTs,
        }),
        title: { type: 'plain_text', text: 'Post Comment' },
        submit: { type: 'plain_text', text: 'Post Comment' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `Posting comment on: ${data.postUrl || 'LinkedIn post'}`,
            },
          },
          {
            type: 'input',
            block_id: 'comment_block',
            element: {
              type: 'plain_text_input',
              action_id: 'comment_input',
              multiline: true,
              initial_value: data.draftComment || '',
              placeholder: { type: 'plain_text', text: 'Write your comment...' },
            },
            label: { type: 'plain_text', text: 'Comment' },
          },
        ],
      },
    });
  });

  // Handle comment modal submission
  app.view('discovery_comment_submit', async ({ ack, body, view, client }) => {
    await ack();

    const metadata = JSON.parse(view.private_metadata || '{}');
    const comment = view.state.values.comment_block?.comment_input?.value;

    if (!comment || !metadata.postId) {
      console.error('[Discovery] Missing comment or postId');
      return;
    }

    // Execute the comment action
    const result = await executeLinkedInAction('comment_on_post', {
      postId: metadata.postId,
      postUrl: metadata.postUrl,
      comment,
    });

    // Update the original message with result
    if (metadata.channelId && metadata.messageTs) {
      await client.chat.postMessage({
        channel: metadata.channelId,
        thread_ts: metadata.messageTs,
        text: result.success
          ? `Comment posted: "${comment.slice(0, 100)}${comment.length > 100 ? '...' : ''}"`
          : `Failed to post comment: ${result.error}`,
      });
    }

    await updateQueueStatus(
      client,
      metadata.queueChannelId,
      metadata.queueMessageTs,
      result.success
        ? 'Post action: comment posted'
        : `Post action failed: ${result.error}`
    );
  });

  // Like a post
  app.action<BlockAction<ButtonAction>>('discovery_like', async ({ ack, body, client }) => {
    await ack();

    const data = parseActionValue(body.actions[0].value);
    const channelId = body.channel?.id || '';
    const messageTs = body.message?.ts || '';

    const result = await executeLinkedInAction('like_post', {
      postId: data.postId,
      postUrl: data.postUrl,
    });

    if (channelId && messageTs) {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: messageTs,
        text: result.success ? 'Post liked' : `Failed to like: ${result.error}`,
      });
    }

    await updateQueueStatus(
      client,
      data.queueChannelId,
      data.queueMessageTs,
      result.success ? 'Post action: liked' : `Post action failed: ${result.error}`
    );
  });

  // Skip a post
  app.action<BlockAction<ButtonAction>>('discovery_skip', async ({ ack, body, client }) => {
    await ack();

    const data = parseActionValue(body.actions[0].value);
    const channelId = body.channel?.id || '';
    const messageTs = body.message?.ts || '';

    if (channelId && messageTs) {
      await client.chat.update({
        channel: channelId,
        ts: messageTs,
        text: 'Post skipped',
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: '_Post skipped_' },
          },
        ],
      });
    }

    await updateQueueStatus(client, data.queueChannelId, data.queueMessageTs, 'Post action: skipped');
  });
}

