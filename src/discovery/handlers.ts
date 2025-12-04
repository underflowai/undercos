import type { App, BlockAction, ButtonAction } from '@slack/bolt';
import { executeLinkedInAction } from '../tools/linkedin.js';
import { emailHandlers } from '../tools/email.js';
import { recordProfileAction, getProfileById } from '../db/index.js';

/**
 * Register Slack handlers for discovery actions (comment, like, connect buttons)
 */
export function registerDiscoveryHandlers(app: App): void {
  
  // ============================================
  // POST ACTIONS
  // ============================================

  // Comment on a discovered post
  app.action<BlockAction<ButtonAction>>('discovery_comment', async ({ ack, body, client }) => {
    await ack();

    const data = JSON.parse(body.actions[0].value || '{}');
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
        }),
        title: { type: 'plain_text', text: 'Post Comment' },
        submit: { type: 'plain_text', text: '💬 Post Comment' },
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
              initial_value: data.draft || '',
              placeholder: { type: 'plain_text', text: 'Your comment...' },
            },
            label: { type: 'plain_text', text: 'Comment' },
          },
        ],
      },
    });
  });

  // Submit comment from modal
  app.view('discovery_comment_submit', async ({ ack, body, view, client }) => {
    await ack();

    const meta = JSON.parse(view.private_metadata);
    const comment = view.state.values.comment_block.comment_input.value || '';

    const result = await executeLinkedInAction('comment_on_post', {
      postId: meta.postId,
      postUrl: meta.postUrl,
      comment,
    }, comment);

    // Update original message
    if (meta.messageTs && meta.channelId) {
      await client.chat.update({
        channel: meta.channelId,
        ts: meta.messageTs,
        text: result.success ? 'Comment posted' : `${result.error}`,
        blocks: [{
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: result.success 
              ? `Comment posted: "${comment.slice(0, 100)}..."`
              : `❌ *Failed*: ${result.error}`,
          },
        }],
      });
    }
  });

  // Like a discovered post
  app.action<BlockAction<ButtonAction>>('discovery_like', async ({ ack, body, client }) => {
    await ack();

    const data = JSON.parse(body.actions[0].value || '{}');
    const channelId = body.channel?.id || '';
    const messageTs = body.message?.ts || '';

    const result = await executeLinkedInAction('like_post', {
      postId: data.postId,
      postUrl: data.postUrl,
      reactionType: 'LIKE',
    });

    // Update original message
    if (messageTs && channelId) {
      await client.chat.update({
        channel: channelId,
        ts: messageTs,
        text: result.success ? 'Liked' : `${result.error}`,
        blocks: [{
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: result.success ? '👍 *Post liked*' : `❌ *Failed*: ${result.error}`,
          },
        }],
      });
    }
  });

  // Skip a discovered post
  app.action<BlockAction<ButtonAction>>('discovery_skip', async ({ ack, body, client }) => {
    await ack();

    const channelId = body.channel?.id || '';
    const messageTs = body.message?.ts || '';

    if (messageTs && channelId) {
      await client.chat.update({
        channel: channelId,
        ts: messageTs,
        text: 'Skipped',
      });
    }
  });

  // ============================================
  // PEOPLE ACTIONS
  // ============================================

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

    // Record action in database (extract public_id from URL)
    if (result.success && data.profileUrl) {
      const publicId = data.profileUrl.replace('https://linkedin.com/in/', '');
      recordProfileAction(publicId, 'approved', data.draft);
    }

    // Reply in thread instead of replacing message
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

  // View Profile - just acknowledge (link opens in browser)
  app.action<BlockAction<ButtonAction>>('discovery_view_profile', async ({ ack }) => {
    await ack();
  });

  // Edit Draft - opens modal to edit note
  app.action<BlockAction<ButtonAction>>('discovery_connect', async ({ ack, body, client }) => {
    await ack();
    console.log('[Handler] Edit Draft clicked');

    const data = JSON.parse(body.actions[0].value || '{}');
    const channelId = body.channel?.id || '';
    const messageTs = body.message?.ts || '';
    
    console.log('[Handler] Opening modal for:', data.profileName);

    // Open modal to edit note before connecting
    try {
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
      console.log('[Handler] Modal opened successfully');
    } catch (error) {
      console.error('[Handler] Failed to open modal:', error);
    }
  });

  // Connect with note (legacy)
  app.action<BlockAction<ButtonAction>>('discovery_connect_with_note', async ({ ack, body, client }) => {
    await ack();

    const data = JSON.parse(body.actions[0].value || '{}');
    const channelId = body.channel?.id || '';
    const messageTs = body.message?.ts || '';

    // Open modal to edit note before connecting
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

    // Record action in database
    if (result.success && meta.profileUrl) {
      const publicId = meta.profileUrl.replace('https://linkedin.com/in/', '');
      recordProfileAction(publicId, 'approved', note);
    }

    // Reply in thread instead of replacing message
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

    // Record action in database
    if (result.success && data.profileUrl) {
      const publicId = data.profileUrl.replace('https://linkedin.com/in/', '');
      recordProfileAction(publicId, 'approved');
    }

    // Reply in thread instead of replacing message
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

    // Record skip action in database
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

  // ============================================
  // EMAIL FOLLOW-UP ACTIONS
  // ============================================

  // Send follow-up email (with edit modal)
  app.action<BlockAction<ButtonAction>>('discovery_send_followup', async ({ ack, body, client }) => {
    await ack();

    const data = JSON.parse(body.actions[0].value || '{}');
    const channelId = body.channel?.id || '';
    const messageTs = body.message?.ts || '';

    // Open modal to edit email before sending
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'discovery_followup_submit',
        private_metadata: JSON.stringify({
          emailId: data.emailId,
          recipient: data.recipient,
          recipientName: data.recipientName,
          channelId,
          messageTs,
        }),
        title: { type: 'plain_text', text: 'Send Follow-up Email' },
        submit: { type: 'plain_text', text: '✉️ Send Email' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `Sending to: *${data.recipientName}* (${data.recipient})`,
            },
          },
          {
            type: 'input',
            block_id: 'subject_block',
            element: {
              type: 'plain_text_input',
              action_id: 'subject_input',
              initial_value: `Following up - ${data.recipientName}`,
              placeholder: { type: 'plain_text', text: 'Email subject' },
            },
            label: { type: 'plain_text', text: 'Subject' },
          },
          {
            type: 'input',
            block_id: 'body_block',
            element: {
              type: 'plain_text_input',
              action_id: 'body_input',
              multiline: true,
              initial_value: data.draft || '',
              placeholder: { type: 'plain_text', text: 'Email body...' },
            },
            label: { type: 'plain_text', text: 'Email Body' },
          },
        ],
      },
    });
  });

  // Submit follow-up email from modal
  app.view('discovery_followup_submit', async ({ ack, body, view, client }) => {
    await ack();

    const meta = JSON.parse(view.private_metadata);
    const subject = view.state.values.subject_block.subject_input.value || '';
    const emailBody = view.state.values.body_block.body_input.value || '';

    const result = await emailHandlers.sendEmail({
      to: [meta.recipient],
      subject,
      body: emailBody.replace(/\n/g, '<br>'), // Convert newlines to HTML
    });

    // Update original message
    if (meta.messageTs && meta.channelId) {
      await client.chat.update({
        channel: meta.channelId,
        ts: meta.messageTs,
        text: result.success ? 'Follow-up email sent' : `${result.error}`,
        blocks: [{
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: result.success 
              ? `Follow-up sent to ${meta.recipientName}`
              : `❌ *Failed*: ${result.error}`,
          },
        }],
      });
    }
  });

  // Skip follow-up
  app.action<BlockAction<ButtonAction>>('discovery_skip_followup', async ({ ack, body, client }) => {
    await ack();

    const channelId = body.channel?.id || '';
    const messageTs = body.message?.ts || '';

    if (messageTs && channelId) {
      await client.chat.update({
        channel: channelId,
        ts: messageTs,
        text: 'Skipped',
        blocks: [{
          type: 'section',
          text: { type: 'mrkdwn', text: 'Skipped' },
        }],
      });
    }
  });

  // ============================================
  // MEETING FOLLOW-UP HANDLERS
  // ============================================

  // Create meeting follow-up draft (instead of sending directly)
  app.action<BlockAction<ButtonAction>>('meeting_followup_send', async ({ ack, body, client }) => {
    await ack();

    const data = JSON.parse(body.actions[0].value || '{}');
    const channelId = body.channel?.id || '';
    const messageTs = body.message?.ts || '';

    // Create draft instead of sending
    const result = await emailHandlers.createDraft({
      to: data.to,
      subject: data.subject,
      body: data.body.replace(/\n/g, '<br>'),
    });

    if (result.success) {
      // Mark meeting as surfaced but NOT sent (draft only)
      const { markMeetingSent } = await import('../db/sales-leads.js');
      if (data.meetingId) {
        markMeetingSent(data.meetingId);
      }
    }

    // Reply in thread
    if (messageTs && channelId) {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: messageTs,
        text: result.success
          ? `✏️ Draft created for ${data.recipientName || data.to[0]} - check your Drafts folder`
          : `${result.error}`,
      });
    }
  });

  // Edit meeting follow-up draft
  app.action<BlockAction<ButtonAction>>('meeting_followup_edit', async ({ ack, body, client }) => {
    await ack();

    const data = JSON.parse(body.actions[0].value || '{}');
    const channelId = body.channel?.id || '';
    const messageTs = body.message?.ts || '';

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'meeting_followup_submit',
        private_metadata: JSON.stringify({
          meetingId: data.meetingId,
          meetingTitle: data.meetingTitle,
          notesId: data.notesId,
          to: data.to,
          recipientEmail: data.recipientEmail,
          recipientName: data.recipientName,
          channelId,
          messageTs,
        }),
        title: { type: 'plain_text', text: 'Create Draft' },
        submit: { type: 'plain_text', text: 'Create Draft' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'context',
            elements: [{
              type: 'mrkdwn',
              text: `To: ${data.recipientName || data.to?.[0] || 'Unknown'}`,
            }],
          },
          {
            type: 'input',
            block_id: 'subject_block',
            element: {
              type: 'plain_text_input',
              action_id: 'subject_input',
              initial_value: data.subject || `Following up: ${data.meetingTitle}`,
            },
            label: { type: 'plain_text', text: 'Subject' },
          },
          {
            type: 'input',
            block_id: 'body_block',
            element: {
              type: 'plain_text_input',
              action_id: 'body_input',
              multiline: true,
              initial_value: data.body || '',
            },
            label: { type: 'plain_text', text: 'Email' },
          },
        ],
      },
    });
  });

  // Submit edited meeting follow-up (creates draft)
  app.view('meeting_followup_submit', async ({ ack, body, view, client }) => {
    await ack();

    const meta = JSON.parse(view.private_metadata);
    const subject = view.state.values.subject_block?.subject_input?.value || '';
    const emailBody = view.state.values.body_block?.body_input?.value || '';

    // Create draft instead of sending
    const result = await emailHandlers.createDraft({
      to: meta.to || [meta.recipientEmail],
      subject,
      body: emailBody.replace(/\n/g, '<br>'),
    });

    if (result.success) {
      // Mark meeting as surfaced
      const { markMeetingSent } = await import('../db/sales-leads.js');
      if (meta.meetingId) {
        markMeetingSent(meta.meetingId);
      }
    }

    // Reply in thread
    if (meta.messageTs && meta.channelId) {
      await client.chat.postMessage({
        channel: meta.channelId,
        thread_ts: meta.messageTs,
        text: result.success
          ? `✏️ Draft created for ${meta.recipientName || meta.recipientEmail} - check your Drafts folder`
          : `${result.error}`,
      });
    }
  });

  // Skip meeting follow-up
  app.action<BlockAction<ButtonAction>>('meeting_followup_skip', async ({ ack, body, client }) => {
    await ack();

    const meetingId = body.actions[0].value || '';
    const channelId = body.channel?.id || '';
    const messageTs = body.message?.ts || '';

    // Mark as skipped in database
    if (meetingId) {
      const { markMeetingSkipped } = await import('../db/sales-leads.js');
      markMeetingSkipped(meetingId);
    }

    if (messageTs && channelId) {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: messageTs,
        text: 'Skipped',
      });
    }
  });

  // ============================================
  // LEAD FOLLOW-UP CADENCE HANDLERS
  // ============================================

  // Create lead follow-up draft (instead of sending directly)
  app.action<BlockAction<ButtonAction>>('lead_followup_send', async ({ ack, body, client }) => {
    await ack();

    const data = JSON.parse(body.actions[0].value || '{}');
    const channelId = body.channel?.id || '';
    const messageTs = body.message?.ts || '';

    const { getLead } = await import('../db/sales-leads.js');
    const lead = getLead(data.leadId);

    if (!lead) {
      if (messageTs && channelId) {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: messageTs,
          text: 'Lead not found',
        });
      }
      return;
    }

    // Create draft instead of sending
    const result = await emailHandlers.createDraft({
      to: [lead.email],
      subject: data.subject,
      body: data.body.replace(/\n/g, '<br>'),
    });

    if (messageTs && channelId) {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: messageTs,
        text: result.success
          ? `✏️ Draft created for ${lead.name || lead.email} - check your Drafts folder`
          : `${result.error}`,
      });
    }
  });

  // Edit lead follow-up draft
  app.action<BlockAction<ButtonAction>>('lead_followup_edit', async ({ ack, body, client }) => {
    await ack();

    const data = JSON.parse(body.actions[0].value || '{}');
    const channelId = body.channel?.id || '';
    const messageTs = body.message?.ts || '';

    const { getLead } = await import('../db/sales-leads.js');
    const lead = getLead(data.leadId);

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'lead_followup_submit',
        private_metadata: JSON.stringify({
          leadId: data.leadId,
          stage: data.stage,
          channelId,
          messageTs,
        }),
        title: { type: 'plain_text', text: 'Create Draft' },
        submit: { type: 'plain_text', text: 'Create Draft' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'context',
            elements: [{
              type: 'mrkdwn',
              text: `To: ${lead?.name || lead?.email || 'Unknown'}`,
            }],
          },
          {
            type: 'input',
            block_id: 'subject_block',
            element: {
              type: 'plain_text_input',
              action_id: 'subject_input',
              initial_value: data.subject,
            },
            label: { type: 'plain_text', text: 'Subject' },
          },
          {
            type: 'input',
            block_id: 'body_block',
            element: {
              type: 'plain_text_input',
              action_id: 'body_input',
              multiline: true,
              initial_value: data.body,
            },
            label: { type: 'plain_text', text: 'Email' },
          },
        ],
      },
    });
  });

  // Submit edited lead follow-up (creates draft)
  app.view('lead_followup_submit', async ({ ack, body, view, client }) => {
    await ack();

    const meta = JSON.parse(view.private_metadata);
    const subject = view.state.values.subject_block?.subject_input?.value || '';
    const emailBody = view.state.values.body_block?.body_input?.value || '';

    const { getLead } = await import('../db/sales-leads.js');
    const lead = getLead(meta.leadId);

    if (!lead) {
      if (meta.messageTs && meta.channelId) {
        await client.chat.postMessage({
          channel: meta.channelId,
          thread_ts: meta.messageTs,
          text: 'Lead not found',
        });
      }
      return;
    }

    // Create draft instead of sending
    const result = await emailHandlers.createDraft({
      to: [lead.email],
      subject,
      body: emailBody.replace(/\n/g, '<br>'),
    });

    if (meta.messageTs && meta.channelId) {
      await client.chat.postMessage({
        channel: meta.channelId,
        thread_ts: meta.messageTs,
        text: result.success
          ? `✏️ Draft created for ${lead.name || lead.email} - check your Drafts folder`
          : `${result.error}`,
      });
    }
  });

  // Snooze lead follow-up
  app.action<BlockAction<ButtonAction>>('lead_followup_snooze', async ({ ack, body, client }) => {
    await ack();

    const data = JSON.parse(body.actions[0].value || '{}');
    const channelId = body.channel?.id || '';
    const messageTs = body.message?.ts || '';

    // Update last_email_date to push back the follow-up
    const { getLead } = await import('../db/sales-leads.js');
    const db = (await import('better-sqlite3')).default;
    const path = await import('path');
    const dbPath = path.join(process.cwd(), 'data', 'sales-leads.db');
    const database = new db(dbPath);
    
    const snoozeDays = data.days || 3;
    const newDate = new Date();
    newDate.setDate(newDate.getDate() - (7 - snoozeDays)); // Adjust date to delay follow-up
    
    database.prepare(`
      UPDATE sales_leads 
      SET last_email_date = ?, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).run(newDate.toISOString(), data.leadId);
    database.close();

    if (messageTs && channelId) {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: messageTs,
        text: `Snoozed for ${snoozeDays} days`,
      });
    }
  });

  // Mark lead as cold
  app.action<BlockAction<ButtonAction>>('lead_mark_cold', async ({ ack, body, client }) => {
    await ack();

    const leadId = body.actions[0].value || '';
    const channelId = body.channel?.id || '';
    const messageTs = body.message?.ts || '';

    const { markLeadCold, getLead } = await import('../db/sales-leads.js');
    const lead = getLead(leadId);
    markLeadCold(leadId);

    if (messageTs && channelId) {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: messageTs,
        text: `Marked ${lead?.name || lead?.email || 'lead'} as cold`,
      });
    }
  });

  // Skip lead follow-up
  app.action<BlockAction<ButtonAction>>('lead_followup_skip', async ({ ack, body, client }) => {
    await ack();

    const channelId = body.channel?.id || '';
    const messageTs = body.message?.ts || '';

    if (messageTs && channelId) {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: messageTs,
        text: 'Skipped',
      });
    }
  });

  console.log('[Discovery] Slack handlers registered');
}

