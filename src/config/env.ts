import { config } from 'dotenv';
import { z } from 'zod';

config();

const envSchema = z.object({
  // Slack
  SLACK_BOT_TOKEN: z.string().startsWith('xoxb-'),
  SLACK_SIGNING_SECRET: z.string().min(1),
  SLACK_APP_TOKEN: z.string().startsWith('xapp-'),

  // OpenAI
  OPENAI_API_KEY: z.string().startsWith('sk-'),

  // Anthropic Claude (optional - for natural writing tasks)
  ANTHROPIC_API_KEY: z.string().optional(),

  // Unipile (LinkedIn automation) - optional, enables real LinkedIn actions
  // Get from: https://developer.unipile.com/docs
  UNIPILE_ACCESS_TOKEN: z.string().optional(),
  UNIPILE_DSN: z.string().optional(), // e.g., api1.unipile.com:13371

  // Discovery settings
  DISCOVERY_CHANNEL_ID: z.string().optional(), // Slack channel for auto-discovery
  DISCOVERY_MENTION_USER: z.string().optional(), // User ID to mention

  // Server
  PORT: z.string().default('3000').transform(Number),

  // Webhooks
  WEBHOOK_URL: z.string().url().optional(), // Public URL for receiving webhooks (e.g., ngrok)
  WEBHOOK_SECRET: z.string().optional(), // Secret for webhook authentication
  WEBHOOK_PORT: z.string().default('3001').transform(Number),

  // Logging
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Timezone (for date context in LLM prompts)
  // Auto-detects from system if not set, defaults to America/Los_Angeles
  TIMEZONE: z.string().default(Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles'),

  // Data persistence
  // Set to a volume mount path on Railway (e.g., /data) for persistence across deploys
  DATA_DIR: z.string().default('./data'),

  // Safety / Config
  DRY_RUN: z.string().optional().default('false'),
  DRY_RUN_EMAIL: z.string().optional().default('false'),
  DRY_RUN_LINKEDIN: z.string().optional().default('false'),
  MAX_EMAILS_PER_DAY: z.string().optional().default('50'),
  MAX_LINKEDIN_INVITES_PER_DAY: z.string().optional().default('20'),
  MAX_LINKEDIN_MESSAGES_PER_DAY: z.string().optional().default('30'),
  ENABLE_AUTO_FOLLOWUP: z.string().optional().default('false'),
  ENABLE_AUTO_CONNECT: z.string().optional().default('false'),
});

function validateEnv() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error(' Invalid environment variables:');
    console.error(result.error.format());
    process.exit(1);
  }

  return result.data;
}

export const env = validateEnv();

export type Env = typeof env;
