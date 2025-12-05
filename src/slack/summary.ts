import type { App } from '@slack/bolt';
import type { WebClient, KnownBlock } from '@slack/web-api';
import type { ResponsesAPIClient } from '../llm/responses.js';
import { getActivitySummary } from '../discovery/activity-tracker.js';
import { getActionCountsByDate, getPendingActions } from '../db/actions-log.js';
import { getPendingSurfacedMeetings } from '../db/sales-leads.js';
import { getQueuedSuggestionCounts } from '../db/connection-queue.js';
import { getDiscoveryConfig } from '../discovery/config.js';
import { generateContent } from '../llm/content-generator.js';

type SummarySnapshot = {
  dateKey: string;
  pendingMeetings: ReturnType<typeof getPendingSurfacedMeetings>;
  queued: ReturnType<typeof getQueuedSuggestionCounts>;
  actionCounts: ReturnType<typeof getActionCountsByDate>;
  pendingActions: ReturnType<typeof getPendingActions>;
  activity: ReturnType<typeof getActivitySummary>;
};

function buildSnapshot(date: Date = new Date()): SummarySnapshot {
  const dateKey = date.toISOString().split('T')[0];
  return {
    dateKey,
    pendingMeetings: getPendingSurfacedMeetings(),
    queued: getQueuedSuggestionCounts(date),
    actionCounts: getActionCountsByDate(date),
    pendingActions: getPendingActions(date),
    activity: getActivitySummary(),
  };
}

function fallbackText(snapshot: SummarySnapshot): string {
  const findCount = (actionType: string, status: string) =>
    snapshot.actionCounts.find((a) => a.actionType === actionType && a.status === status)?.count || 0;

  const sentConnections = findCount('send_connection_request', 'succeeded');
  const draftsCreated = findCount('create_draft', 'succeeded');
  const pendingConnections = findCount('send_connection_request', 'pending');
  const pendingDrafts = findCount('create_draft', 'pending');
  const failedConnections = findCount('send_connection_request', 'failed');
  const failedDrafts = findCount('create_draft', 'failed');

  const lines: string[] = [];
  lines.push(`Summary for ${snapshot.dateKey}`);
  lines.push(`Pending meeting follow-ups: ${snapshot.pendingMeetings.length}`);
  lines.push(`Queued ad-hoc connections: ${snapshot.queued.dueToday} due, ${snapshot.queued.future} later`);
  lines.push(`Sent today: ${sentConnections} connections, ${draftsCreated} drafts`);
  lines.push(`Pending sends: ${pendingConnections} connections, ${pendingDrafts} drafts`);
  lines.push(`Failures: ${failedConnections} connections, ${failedDrafts} drafts`);

  const limits = snapshot.activity.activities
    .map((a) => `${a.type} ${a.count}/${a.dailyLimit}${a.weeklyLimit ? ` (weekly ${a.weeklyCount}/${a.weeklyLimit})` : ''}`)
    .join(' | ');
  lines.push(`Limits: ${limits}`);

  return lines.join('\n');
}

async function draftCosStyleSummary(
  llm: ResponsesAPIClient,
  snapshot: SummarySnapshot
): Promise<string> {
  try {
    const payload = {
      date: snapshot.dateKey,
      pending_meetings: snapshot.pendingMeetings.map((m) => ({
        meeting_title: m.meeting_title,
        recipient: m.recipient_name || m.recipient_email,
        status: m.status,
        surfaced_at: m.surfaced_at,
      })),
      queued_connections: snapshot.queued,
      action_counts: snapshot.actionCounts,
      pending_actions: snapshot.pendingActions.map((a) => ({
        action_type: a.action_type,
        entity_type: a.entity_type,
        status: a.status,
        created_at: a.created_at,
      })),
      activity: snapshot.activity,
    };

    const result = await generateContent(
      {
        systemPrompt: `You are a sharp chief of staff writing a brief end-of-day Slack update. Be crisp, prioritize what needs attention, skip noise, and keep it human. Use short sentences, no bullet spam. If nothing is urgent, say so.`,
        userPrompt: `Here is today's operational state in JSON:\n${JSON.stringify(payload, null, 2)}\n\nWrite a short summary (3-6 lines). Emphasize what needs attention now. If limits are fine, just say pacing is fine. If there are failures or pending items, mention the top few with names. Avoid emojis.`,
        maxTokens: 300,
        effort: 'low',
      },
      llm
    );

    return result.text?.trim() || fallbackText(snapshot);
  } catch (error) {
    console.error('[Summary] LLM generation failed, using fallback:', error);
    return fallbackText(snapshot);
  }
}

export async function postDailySummary(
  slackClient: WebClient,
  llm: ResponsesAPIClient,
  channelId: string,
  date: Date = new Date()
): Promise<void> {
  const snapshot = buildSnapshot(date);
  const summaryText = await draftCosStyleSummary(llm, snapshot);

  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: summaryText },
    },
  ];

  await slackClient.chat.postMessage({
    channel: channelId,
    text: summaryText,
    blocks,
  });
}

export function registerSummaryCommand(app: App, llm: ResponsesAPIClient, channelId: string): void {
  app.command('/summary', async ({ ack, respond, client }) => {
    await ack();

    await respond({
      text: `Posting summary to <#${channelId}>`,
      response_type: 'ephemeral',
    });

    try {
      await postDailySummary(client, llm, channelId);
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

