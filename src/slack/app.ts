import pkg from '@slack/bolt';
const { App, LogLevel } = pkg;
import { env } from '../config/env.js';

/**
 * Create and configure the Slack Bolt app
 */
export function createSlackApp() {
  const app = new App({
    token: env.SLACK_BOT_TOKEN,
    signingSecret: env.SLACK_SIGNING_SECRET,
    appToken: env.SLACK_APP_TOKEN,
    socketMode: true,
    logLevel: LogLevel.INFO,
  });

  return app;
}

/**
 * Extract the actual message text, removing the bot mention
 */
export function extractMessageText(text: string, botUserId: string): string {
  const mentionPattern = new RegExp(`<@${botUserId}>\\s*`, 'g');
  return text.replace(mentionPattern, '').trim();
}

/**
 * Get the thread timestamp
 */
export function getThreadTs(event: { thread_ts?: string; ts: string }): string {
  return event.thread_ts || event.ts;
}

