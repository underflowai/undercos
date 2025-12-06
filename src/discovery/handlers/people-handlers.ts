/**
 * People Discovery Handlers
 * 
 * Slack handlers for people-related actions (connect, view profile, skip)
 */

import type { App, BlockAction, ButtonAction } from '@slack/bolt';
import type { KnownBlock } from '@slack/types';
import { executeLinkedInAction } from '../../tools/linkedin.js';
import { recordProfileAction } from '../../db/index.js';

export function registerPeopleHandlers(app: App): void {
  // Approve - send connection with draft as-is
  app.action<BlockAction<ButtonAction>>('discovery_connect_approve', async ({ ack, body, client }) => {
    await ack();

    const data = JSON.parse(body.actions[0].value || '{}');
    const channelId = body.channel?.id || '';
    const messageTs = body.message?.ts || '';
    const baseText = data.profileName ? `Connection for ${data.profileName}` : 'Connection request';

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
      if (result.success) {
        await updateMessage(client, channelId, messageTs, {
          text: `${baseText}: sent${data.draft ? ' (with note)' : ''}`,
          blocks: buildStatusBlocks(baseText, data.draft, data.profileUrl),
        });
      } else {
        const errorText = result.error || 'Unknown error';
        await updateMessage(client, channelId, messageTs, {
          text: `${baseText}: failed – ${errorText}`,
          blocks: buildRetryBlocks({
            title: `${baseText}: failed – ${errorText}`,
            profileId: data.profileId,
            profileUrl: data.profileUrl,
            note: data.draft,
            personName: data.profileName,
            channelId,
            messageTs,
          }),
        });
      }
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
    const baseText = meta.profileName ? `Connection for ${meta.profileName}` : 'Connection request';

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
      if (result.success) {
        await updateMessage(client, meta.channelId, meta.messageTs, {
          text: `${baseText}: sent${note ? ' (with note)' : ''}`,
          blocks: buildStatusBlocks(baseText, note, meta.profileUrl),
        });
      } else {
        const errorText = result.error || 'Unknown error';
        await updateMessage(client, meta.channelId, meta.messageTs, {
          text: `${baseText}: failed – ${errorText}`,
          blocks: buildRetryBlocks({
            title: `${baseText}: failed – ${errorText}`,
            profileId: meta.profileId,
            profileUrl: meta.profileUrl,
            note,
            personName: meta.profileName,
            channelId: meta.channelId,
            messageTs: meta.messageTs,
          }),
        });
      }
    }
  });

  // Connect without note
  app.action<BlockAction<ButtonAction>>('discovery_connect_no_note', async ({ ack, body, client }) => {
    await ack();

    const data = JSON.parse(body.actions[0].value || '{}');
    const channelId = body.channel?.id || '';
    const messageTs = body.message?.ts || '';
    const baseText = data.profileName ? `Connection for ${data.profileName}` : 'Connection request';

    const result = await executeLinkedInAction('send_connection_request', {
      profileId: data.profileId,
      profileUrl: data.profileUrl,
    });

    if (result.success && data.profileUrl) {
      const publicId = data.profileUrl.replace('https://linkedin.com/in/', '');
      recordProfileAction(publicId, 'approved');
    }

    if (messageTs && channelId) {
      if (result.success) {
        await updateMessage(client, channelId, messageTs, {
          text: `${baseText}: sent`,
          blocks: buildStatusBlocks(baseText, undefined, data.profileUrl),
        });
      } else {
        const errorText = result.error || 'Unknown error';
        await updateMessage(client, channelId, messageTs, {
          text: `${baseText}: failed – ${errorText}`,
          blocks: buildRetryBlocks({
            title: `${baseText}: failed – ${errorText}`,
            profileId: data.profileId,
            profileUrl: data.profileUrl,
            personName: data.profileName,
            channelId,
            messageTs,
          }),
        });
      }
    }
  });


  // Skip a discovered person
  app.action<BlockAction<ButtonAction>>('discovery_skip_person', async ({ ack, body, client }) => {
    await ack();

    const data = safeParseActionValue(body.actions?.[0]?.value);
    const profileId = data.profileId || body.actions?.[0]?.value || '';
    const profileName = data.profileName || 'this person';
    const profileUrl = data.profileUrl;
    const channelId = body.channel?.id || '';
    const messageTs = body.message?.ts || '';

    if (profileId) {
      recordProfileAction(profileId, 'skipped');
    }

    if (messageTs && channelId) {
      await updateMessage(client, channelId, messageTs, {
        text: `Skipped sending connection request to ${profileName}`,
        blocks: buildSkipBlocks({
          title: `Skipped sending connection request to ${profileName}`,
          profileUrl,
        }),
      });
    }
  });

  // Mark as pending (already attempted)
  app.action<BlockAction<ButtonAction>>('discovery_mark_pending', async ({ ack, body, client }) => {
    await ack();

    const data = safeParseActionValue(body.actions?.[0]?.value);
    const channelId = body.channel?.id || data.channelId || '';
    const messageTs = body.message?.ts || data.messageTs || '';
    const profileName = data.profileName || 'this person';
    const profileId = data.profileId || '';

    if (profileId) {
      recordProfileAction(profileId, 'pending');
    }

    if (channelId && messageTs) {
      await updateMessage(client, channelId, messageTs, {
        text: `Marked as pending: ${profileName}`,
        blocks: buildStatusBlocks(`Marked as pending: ${profileName}`, undefined, data.profileUrl),
      });
    }
  });
}



function safeParseActionValue(raw?: string): any {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function buildStatusBlocks(title: string, note?: string, profileUrl?: string): KnownBlock[] {
  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: title },
    },
  ];

  if (note) {
    const trimmed = note.length > 150 ? `${note.slice(0, 150)}...` : note;
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Note: ${trimmed}` }],
    });
  }

  if (profileUrl) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'View Profile', emoji: false },
          url: profileUrl,
          action_id: 'discovery_view_profile',
        },
      ],
    });
  }

  return blocks;
}

function buildRetryBlocks(params: {
  title: string;
  profileId?: string;
  profileUrl?: string;
  note?: string;
  personName?: string;
  channelId?: string;
  messageTs?: string;
}): KnownBlock[] {
  const value = JSON.stringify({
    profileId: params.profileId,
    profileUrl: params.profileUrl,
    note: params.note,
    personName: params.personName,
    channelId: params.channelId,
    messageTs: params.messageTs,
  });

  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: params.title },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Mark Pending', emoji: false },
          action_id: 'discovery_mark_pending',
          value,
        },
        ...(params.profileUrl ? [{
          type: 'button' as const,
          text: { type: 'plain_text' as const, text: 'View Profile', emoji: false },
          url: params.profileUrl,
          action_id: 'discovery_view_profile',
        }] : []),
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Skip', emoji: false },
          action_id: 'discovery_skip_person',
          value: JSON.stringify({
            profileId: params.profileId,
            profileUrl: params.profileUrl,
            profileName: params.personName,
          }),
        },
      ],
    },
  ];
}

function buildSkipBlocks(params: { title: string; profileUrl?: string }): KnownBlock[] {
  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: params.title },
    },
  ];

  if (params.profileUrl) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'View Profile', emoji: false },
          url: params.profileUrl,
          action_id: 'discovery_view_profile',
        },
      ],
    });
  }

  return blocks;
}

async function updateMessage(client: any, channelId: string, ts: string, payload: { text: string; blocks?: KnownBlock[] }): Promise<void> {
  if (!channelId || !ts) return;

  await client.chat.update({
    channel: channelId,
    ts,
    text: payload.text,
    blocks: payload.blocks,
  });
}
