import express from 'express';
import { createSlackApp, registerHandlers, registerInteractions } from './slack/index.js';
import { registerSummaryCommand } from './slack/summary.js';
import { registerDiscoveryCommands } from './slack/discovery-commands.js';
import { createResponsesClient } from './llm/index.js';
import { createResponsesRouter } from './agent/index.js';
import { isUnipileConfigured } from './tools/index.js';
import { DiscoveryEngine, updateDiscoveryConfig } from './discovery/index.js';
import { registerDiscoveryHandlers } from './discovery/handlers/index.js';
import { registerWebhookRoutes, setupWebhooks, setSlackClient } from './webhooks/index.js';
import { registerLinkedInMessagingHandlers } from './slack/linkedin-messaging.js';
import { env } from './config/env.js';
import { MODEL_CONFIG } from './config/models.js';
import { clearDataDir } from './utils/clear-data.js';

async function main() {
  console.log('🚀 Starting LinkedIn AI Bot...\n');

  // Create Express app for health check and webhooks
  const expressApp = express();
  expressApp.use(express.json());
  
  expressApp.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Register webhook routes on same port (for Railway/production)
  if (env.WEBHOOK_URL) {
    registerWebhookRoutes(expressApp);
  }

  // Start Express server
  expressApp.listen(env.PORT, () => {
    console.log(`[Express] Server on port ${env.PORT}`);
    console.log(`[Express] Health: http://localhost:${env.PORT}/health`);
    if (env.WEBHOOK_URL) {
      console.log(`[Express] Webhooks: http://localhost:${env.PORT}/webhooks/unipile`);
    }
  });

  // Initialize Responses API client with web search
  console.log('[Init] Creating Responses API client (with web search)');
  const responsesClient = createResponsesClient(env.OPENAI_API_KEY, {
    enableWebSearch: MODEL_CONFIG.ENABLE_WEB_SEARCH,
  });
  const router = createResponsesRouter(responsesClient);

  // Create Slack app
  console.log('[Init] Creating Slack app');
  const slackApp = createSlackApp();

  // Optional: clear data dir on start (for ephemeral environments)
  clearDataDir();

  // Register handlers
  registerHandlers(slackApp, router);
  registerInteractions(slackApp, router);
  registerDiscoveryHandlers(slackApp);
  registerLinkedInMessagingHandlers(slackApp);
  if (env.DISCOVERY_CHANNEL_ID) {
    registerSummaryCommand(slackApp, responsesClient, env.DISCOVERY_CHANNEL_ID);
  }

  // Start Slack app (Socket Mode)
  await slackApp.start();

  // Pass Slack client to webhook handlers
  setSlackClient(slackApp.client);

  // Register webhooks with Unipile (routes already added to Express above)
  if (env.WEBHOOK_URL) {
    console.log('[Init] Registering webhooks with Unipile');
    await setupWebhooks();
  } else {
    console.log('[Init] Webhooks disabled (no WEBHOOK_URL)');
  }

  // Initialize discovery engine if channel is configured
  let discoveryEngine: DiscoveryEngine | null = null;
  
  if (env.DISCOVERY_CHANNEL_ID) {
    console.log('[Init] Starting discovery engine');
    
    // Update config with env settings
    updateDiscoveryConfig({
      slack: {
        channelId: env.DISCOVERY_CHANNEL_ID,
        mentionUser: env.DISCOVERY_MENTION_USER,
      },
    });

    // Create and start discovery engine
    discoveryEngine = new DiscoveryEngine(slackApp.client, responsesClient);
    discoveryEngine.start();
  } else {
    console.log('[Init] Discovery disabled (no DISCOVERY_CHANNEL_ID)');
  }

  // Slash commands for manual discovery runs
  registerDiscoveryCommands(slackApp, discoveryEngine);

  // Status output
  const unipileStatus = isUnipileConfigured() 
    ? ' Unipile connected - real LinkedIn actions enabled'
    : '⚠️  Unipile not configured - using mock mode';

  const discoveryStatus = env.DISCOVERY_CHANNEL_ID
    ? ` Auto-discovery enabled → #${env.DISCOVERY_CHANNEL_ID}`
    : '⚠️  Auto-discovery disabled (set DISCOVERY_CHANNEL_ID)';

  const webhookStatus = env.WEBHOOK_URL
    ? ` Webhooks enabled → ${env.WEBHOOK_URL}`
    : '⚠️  Webhooks disabled (set WEBHOOK_URL)';

  console.log('\n LinkedIn AI Bot is running!');
  console.log(`   ${unipileStatus}`);
  console.log(`   ${discoveryStatus}`);
  console.log(`   ${webhookStatus}`);
  console.log('   Mention @ai-li in Slack to interact');
  console.log('\n   Manual tools:');
  console.log('   • search_posts_by_keywords  • get_profile');
  console.log('   • comment_on_post           • search_profiles');
  console.log('   • like_post                 • send_connection_request');
  console.log('   • send_dm                   • list_chats');
  console.log('\n   Auto-discovery (when enabled):');
  console.log('   • Finds relevant posts → drafts comments → asks for approval');
  console.log('   • Finds relevant people → drafts connection notes → asks for approval\n');
}

main().catch((error) => {
  console.error(' Fatal error:', error);
  process.exit(1);
});
