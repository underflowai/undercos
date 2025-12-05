import type { App } from '@slack/bolt';
import type { WebClient, KnownBlock } from '@slack/web-api';
import { getActivitySummary } from '../discovery/activity-tracker.js';
import { getActionCountsByDate, getPendingActions } from '../db/actions-log.js';
import { getPendingSurfacedMeetings } from '../db/sales-leads.js';
import { getQueuedSuggestionCounts } from '../db/connection-queue.js';
import { getDiscoveryConfig } from '../discovery/config.js';

type SummarySection = {
  title: string;
  lines: string[];
};

function formatSection(section: SummarySection): KnownBlock[] {
  const blocks: KnownBlock[] = [];
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*${section.title}*` },
  });

  if (section.lines.length === 0) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: 'None' }],
    });
    return blocks;
  }

  for (const line of section.lines) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: line }],
    });
  }

  blocks.push({ type: 'divider' });
  return blocks;
}

function buildSummarySections(date: Date = new Date()): SummarySection[] {
  const todayKey = date.toISOString().split('T')[0];

  const pendingMeetings = getPendingSurfacedMeetings();
  const queued = getQueuedSuggestionCounts(date);
  const actionCounts = getActionCountsByDate(date);
  const pendingActions = getPendingActions(date);
  const activity = getActivitySummary();

  const findCount = (actionType: string, status: string) =>
    actionCounts.find((a) => a.actionType === actionType && a.status === status)?.count || 0;

  const pendingSection: SummarySection = {
    title: 'Pending actions',
    lines: [],
  };

  pendingSection.lines.push(
    `Meeting follow-ups awaiting decision: ${pendingMeetings.length}` +
      (pendingMeetings.length > 0
        ? ` (e.g., ${pendingMeetings.slice(0, 3).map((m) => m.meeting_title || m.recipient_email).join(', ')})`
        : '')
  );

  pendingSection.lines.push(
    `Ad-hoc connection suggestions queued: ${queued.dueToday} due today, ${queued.future} deferred`
  );

  const pendingConnections = findCount('send_connection_request', 'pending');
  const pendingDrafts = findCount('create_draft', 'pending');
  const failedConnections = findCount('send_connection_request', 'failed');
  const failedDrafts = findCount('create_draft', 'failed');

  pendingSection.lines.push(`Pending sends: connections ${pendingConnections}, drafts ${pendingDrafts}`);
  pendingSection.lines.push(`Failures today: connections ${failedConnections}, drafts ${failedDrafts}`);

  const activitySection: SummarySection = {
    title: `Today's activity (${todayKey})`,
    lines: [],
  };

  const sentConnections = findCount('send_connection_request', 'succeeded');
  const draftsCreated = findCount('create_draft', 'succeeded');
  activitySection.lines.push(`Connections sent: ${sentConnections}`);
  activitySection.lines.push(`Drafts created: ${draftsCreated}`);

  const limitsSection: SummarySection = {
    title: 'Limits status (today)',
    lines: [],
  };

  for (const item of activity.activities) {
    const weeklyPart = item.weeklyLimit ? `, weekly ${item.weeklyCount}/${item.weeklyLimit}` : '';
    limitsSection.lines.push(
      `${item.type}: ${item.count}/${item.dailyLimit}${weeklyPart} (${item.status}, ${item.percentUsed}%)`
    );
  }

  const deferredSection: SummarySection = {
    title: 'Deferred to tomorrow',
    lines: [
      `Connection suggestions scheduled later: ${queued.future}`,
    ],
  };

  const diagnosticsSection: SummarySection = {
    title: 'Diagnostics',
    lines: [
      `Pending action records: ${pendingActions.length}`,
    ],
  };

  return [pendingSection, activitySection, deferredSection, limitsSection, diagnosticsSection];
}

export async function postDailySummary(slackClient: WebClient, channelId: string, date: Date = new Date()): Promise<void> {
  const sections = buildSummarySections(date);
  const blocks: KnownBlock[] = [];

  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: `End of day summary (${date.toISOString().split('T')[0]})`, emoji: false },
  });
  blocks.push({ type: 'divider' });

  for (const section of sections) {
    blocks.push(...formatSection(section));
  }

  const text = sections
    .map((s) => `${s.title}: ${s.lines.join(' | ')}`)
    .join('\n');

  await slackClient.chat.postMessage({
    channel: channelId,
    text,
    blocks,
  });
}

export function registerSummaryCommand(app: App, channelId: string): void {
  app.command('/summary', async ({ ack, respond, client }) => {
    await ack();

    await respond({
      text: `Posting summary to <#${channelId}>`,
      response_type: 'ephemeral',
    });

    try {
      await postDailySummary(client, channelId);
    } catch (error) {
      await respond({
        text: `Failed to post summary: ${error instanceof Error ? error.message : 'Unknown error'}`,
        response_type: 'ephemeral',
      });
    }
  });
}

export function getSummaryChannel(): string {
  const config = getDiscoveryConfig();
  return config.slack.channelId;
}

