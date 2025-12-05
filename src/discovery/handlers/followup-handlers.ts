/**
 * Follow-up Handlers
 * 
 * Slack handlers for email follow-ups, meeting follow-ups, and lead cadence follow-ups
 */

import type { App, BlockAction, ButtonAction } from '@slack/bolt';
import { emailHandlers } from '../../tools/email.js';

export function registerFollowUpHandlers(app: App): void {
  // ============================================
  // EMAIL FOLLOW-UP ACTIONS
  // ============================================

  // Send follow-up email (with edit modal)
  app.action<BlockAction<ButtonAction>>('discovery_send_followup', async ({ ack, body, client }) => {
    await ack();

    const data = JSON.parse(body.actions[0].value || '{}');
    const channelId = body.channel?.id || '';
    const messageTs = body.message?.ts || '';

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
      body: emailBody.replace(/\n/g, '<br>'),
    });

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
              : ` *Failed*: ${result.error}`,
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

  // Create meeting follow-up draft
  app.action<BlockAction<ButtonAction>>('meeting_followup_send', async ({ ack, body, client }) => {
    await ack();

    const data = JSON.parse(body.actions[0].value || '{}');
    const channelId = body.channel?.id || '';
    const messageTs = body.message?.ts || '';

    const result = await emailHandlers.createDraft({
      to: data.to,
      subject: data.subject,
      body: data.body.replace(/\n/g, '<br>'),
    });

    if (result.success && data.meetingId) {
      const { markMeetingSent } = await import('../../db/sales-leads.js');
      markMeetingSent(data.meetingId);
    }

    if (messageTs && channelId) {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: messageTs,
        text: result.success
          ? ` Draft created for ${data.recipientName || data.to[0]} - check your Drafts folder`
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
              initial_value: data.subject || '',
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

  // Submit edited meeting follow-up
  app.view('meeting_followup_submit', async ({ ack, body, view, client }) => {
    await ack();

    const meta = JSON.parse(view.private_metadata);
    const subject = view.state.values.subject_block?.subject_input?.value || '';
    const emailBody = view.state.values.body_block?.body_input?.value || '';

    const result = await emailHandlers.createDraft({
      to: meta.to || [meta.recipientEmail],
      subject,
      body: emailBody.replace(/\n/g, '<br>'),
    });

    if (result.success && meta.meetingId) {
      const { markMeetingSent } = await import('../../db/sales-leads.js');
      markMeetingSent(meta.meetingId);
    }

    if (meta.messageTs && meta.channelId) {
      await client.chat.postMessage({
        channel: meta.channelId,
        thread_ts: meta.messageTs,
        text: result.success
          ? ` Draft created for ${meta.recipientName || meta.recipientEmail} - check your Drafts folder`
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

    if (meetingId) {
      const { markMeetingSkipped } = await import('../../db/sales-leads.js');
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

  // Create lead follow-up draft
  app.action<BlockAction<ButtonAction>>('lead_followup_send', async ({ ack, body, client }) => {
    await ack();

    const data = JSON.parse(body.actions[0].value || '{}');
    const channelId = body.channel?.id || '';
    const messageTs = body.message?.ts || '';

    const { getLead } = await import('../../db/sales-leads.js');
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
          ? ` Draft created for ${lead.name || lead.email} - check your Drafts folder`
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

    const { getLead } = await import('../../db/sales-leads.js');
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

  // Submit edited lead follow-up
  app.view('lead_followup_submit', async ({ ack, body, view, client }) => {
    await ack();

    const meta = JSON.parse(view.private_metadata);
    const subject = view.state.values.subject_block?.subject_input?.value || '';
    const emailBody = view.state.values.body_block?.body_input?.value || '';

    const { getLead } = await import('../../db/sales-leads.js');
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
          ? ` Draft created for ${lead.name || lead.email} - check your Drafts folder`
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

    const db = (await import('better-sqlite3')).default;
    const path = await import('path');
    const dbPath = path.join(process.cwd(), 'data', 'sales-leads.db');
    const database = new db(dbPath);
    
    const snoozeDays = data.days || 3;
    const newDate = new Date();
    newDate.setDate(newDate.getDate() - (7 - snoozeDays));
    
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

    const { markLeadCold, getLead } = await import('../../db/sales-leads.js');
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

  console.log('[FollowUpHandlers] Registered');
}

