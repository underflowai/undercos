/**
 * People Discovery Handlers
 * 
 * Slack handlers for people-related actions (connect, view profile, skip)
 */

import type { App, BlockAction, ButtonAction } from '@slack/bolt';
import { executeLinkedInAction } from '../../tools/linkedin.js';
import { recordProfileAction } from '../../db/index.js';

export function registerPeopleHandlers(app: App): void {
  // Approve - send connection with draft as-is
  app.action<BlockAction<ButtonAction>>('discovery_connect_approve', async ({ ack, body, client }) => {
    await ack();

    const data = JSON.parse(body.actions[0].value || '{}');
    const channelId = body.channel?.id || '';
    const messageTs = body.message?.ts || '';

    const result = await executeLinkedInAction('send_connection_request', {
      profileId: data.profileId,
      profileUrl: data.profileUrl,
      profileName: data.profileName,
      note: data.draft,
    }, data.draft);

    // Record action in database
    if (result.success && data.profileUrl) {
      const publicId = data.profileUrl.replace('https://linkedin.com/in/', '');
      recordProfileAction(publicId, 'approved', data.draft);
    }

    if (messageTs && channelId) {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: messageTs,
        text: result.success 
          ? `Connection request sent${data.draft ? ` with note` : ''}`
          : `${result.error}`,
      });
    }
  });

  // View Profile - just acknowledge
  app.action<BlockAction<ButtonAction>>('discovery_view_profile', async ({ ack }) => {
    await ack();
  });

  // Edit Draft - opens modal to edit note
  app.action<BlockAction<ButtonAction>>('discovery_connect', async ({ ack, body, client }) => {
    await ack();

    const data = JSON.parse(body.actions[0].value || '{}');
    const channelId = body.channel?.id || '';
    const messageTs = body.message?.ts || '';

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'discovery_connect_submit',
        private_metadata: JSON.stringify({
          profileId: data.profileId,
          profileUrl: data.profileUrl,
          profileName: data.profileName,
          channelId,
          messageTs,
        }),
        title: { type: 'plain_text', text: 'Send Connection Request' },
        submit: { type: 'plain_text', text: 'Send' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'context',
            elements: [{
              type: 'mrkdwn',
              text: data.profileUrl || 'LinkedIn profile',
            }],
          },
          {
            type: 'input',
            block_id: 'note_block',
            element: {
              type: 'plain_text_input',
              action_id: 'note_input',
              multiline: true,
              initial_value: data.draft || '',
              max_length: 300,
              placeholder: { type: 'plain_text', text: 'Connection note (max 300 chars)' },
            },
            label: { type: 'plain_text', text: 'Edit note' },
            optional: true,
          },
        ],
      },
    });
  });

  // Connect with note (legacy)
  app.action<BlockAction<ButtonAction>>('discovery_connect_with_note', async ({ ack, body, client }) => {
    await ack();

    const data = JSON.parse(body.actions[0].value || '{}');
    const channelId = body.channel?.id || '';
    const messageTs = body.message?.ts || '';

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'discovery_connect_submit',
        private_metadata: JSON.stringify({
          profileId: data.profileId,
          profileUrl: data.profileUrl,
          profileName: data.profileName,
          channelId,
          messageTs,
        }),
        title: { type: 'plain_text', text: 'Send Connection' },
        submit: { type: 'plain_text', text: '🤝 Connect' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `Connecting with: ${data.profileUrl || 'LinkedIn user'}`,
            },
          },
          {
            type: 'input',
            block_id: 'note_block',
            element: {
              type: 'plain_text_input',
              action_id: 'note_input',
              multiline: true,
              initial_value: data.draft || '',
              max_length: 300,
              placeholder: { type: 'plain_text', text: 'Connection note (optional, max 300 chars)' },
            },
            label: { type: 'plain_text', text: 'Note' },
            optional: true,
          },
        ],
      },
    });
  });

  // Submit connection from modal
  app.view('discovery_connect_submit', async ({ ack, body, view, client }) => {
    await ack();

    const meta = JSON.parse(view.private_metadata);
    const note = view.state.values.note_block?.note_input?.value || '';

    const result = await executeLinkedInAction('send_connection_request', {
      profileId: meta.profileId,
      profileUrl: meta.profileUrl,
      profileName: meta.profileName,
      note,
    }, note);

    if (result.success && meta.profileUrl) {
      const publicId = meta.profileUrl.replace('https://linkedin.com/in/', '');
      recordProfileAction(publicId, 'approved', note);
    }

    if (meta.messageTs && meta.channelId) {
      await client.chat.postMessage({
        channel: meta.channelId,
        thread_ts: meta.messageTs,
        text: result.success 
          ? `Connection request sent${note ? ` with note: "${note.slice(0, 50)}${note.length > 50 ? '...' : ''}"` : ''}`
          : `${result.error}`,
      });
    }
  });

  // Connect without note
  app.action<BlockAction<ButtonAction>>('discovery_connect_no_note', async ({ ack, body, client }) => {
    await ack();

    const data = JSON.parse(body.actions[0].value || '{}');
    const channelId = body.channel?.id || '';
    const messageTs = body.message?.ts || '';

    const result = await executeLinkedInAction('send_connection_request', {
      profileId: data.profileId,
      profileUrl: data.profileUrl,
    });

    if (result.success && data.profileUrl) {
      const publicId = data.profileUrl.replace('https://linkedin.com/in/', '');
      recordProfileAction(publicId, 'approved');
    }

    if (messageTs && channelId) {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: messageTs,
        text: result.success ? 'Connection request sent' : `${result.error}`,
      });
    }
  });

  // Skip a discovered person
  app.action<BlockAction<ButtonAction>>('discovery_skip_person', async ({ ack, body, client }) => {
    await ack();

    const profileId = body.actions[0].value || '';
    const channelId = body.channel?.id || '';
    const messageTs = body.message?.ts || '';

    if (profileId) {
      recordProfileAction(profileId, 'skipped');
    }

    if (messageTs && channelId) {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: messageTs,
        text: 'Skipped',
      });
    }
  });
}

