/**
 * Webhook Setup - Register webhooks with Unipile on startup
 * 
 * Registers:
 * - users webhook: For new_relation events (connection accepted)
 * - messaging webhook: For message_received events (new DMs)
 * - mail webhook: For email delivery events (bounces, delivery status)
 */

import { 
  isUnipileConfigured,
  listWebhooks as sdkListWebhooks,
  createWebhook as sdkCreateWebhook,
  deleteWebhook as sdkDeleteWebhook,
} from '../tools/unipile-sdk.js';
import { env } from '../config/env.js';

// Type definition
interface UnipileWebhook {
  id: string;
  name?: string;
  source?: string;
  request_url?: string;
}

const WEBHOOK_NAMES = {
  USERS: 'ai-linkedin-users',
  MESSAGING: 'ai-linkedin-messaging',
  MAIL: 'ai-linkedin-mail',
} as const;

/**
 * Setup webhooks with Unipile
 * Checks for existing webhooks and creates new ones if needed
 */
export async function setupWebhooks(): Promise<void> {
  if (!isUnipileConfigured()) {
    console.log('[Webhooks] Unipile not configured - skipping webhook setup');
    return;
  }
  
  if (!env.WEBHOOK_URL) {
    console.warn('[Webhooks] WEBHOOK_URL not set - webhooks will not be registered');
    console.warn('[Webhooks] Set WEBHOOK_URL to a publicly accessible URL (e.g., ngrok)');
    return;
  }
  
  console.log('[Webhooks] Setting up webhooks...');
  console.log(`[Webhooks] Webhook URL: ${env.WEBHOOK_URL}`);
  
  try {
    // Get existing webhooks
    const existingWebhooks = await sdkListWebhooks() as UnipileWebhook[];
    console.log(`[Webhooks] Found ${existingWebhooks.length} existing webhooks`);
    
    // Check which webhooks we need to create
    const hasUsersWebhook = existingWebhooks.some(
      (w: UnipileWebhook) => w.source === 'users' && w.request_url === env.WEBHOOK_URL
    );
    const hasMessagingWebhook = existingWebhooks.some(
      (w: UnipileWebhook) => w.source === 'messaging' && w.request_url === env.WEBHOOK_URL
    );
    const hasEmailWebhook = existingWebhooks.some(
      (w: UnipileWebhook) => w.source === 'email' && w.request_url === env.WEBHOOK_URL
    );
    const hasEmailTrackingWebhook = existingWebhooks.some(
      (w: UnipileWebhook) => w.source === 'email_tracking' && w.request_url === env.WEBHOOK_URL
    );
    
    // Create users webhook (for connection accepted)
    if (!hasUsersWebhook) {
      console.log('[Webhooks] Creating users webhook...');
      try {
        await sdkCreateWebhook({
          source: 'users',
          requestUrl: env.WEBHOOK_URL,
          name: WEBHOOK_NAMES.USERS,
        });
        console.log('[Webhooks] Users webhook created');
      } catch (error) {
        console.error('[Webhooks] Failed to create users webhook:', error);
      }
    } else {
      console.log('[Webhooks] Users webhook already exists');
    }
    
    // Create messaging webhook (for new messages)
    if (!hasMessagingWebhook) {
      console.log('[Webhooks] Creating messaging webhook...');
      try {
        await sdkCreateWebhook({
          source: 'messaging',
          requestUrl: env.WEBHOOK_URL,
          name: WEBHOOK_NAMES.MESSAGING,
        });
        console.log('[Webhooks] Messaging webhook created');
      } catch (error) {
        console.error('[Webhooks] Failed to create messaging webhook:', error);
      }
    } else {
      console.log('[Webhooks] Messaging webhook already exists');
    }
    
    // Create email webhook (for new emails received/sent)
    if (!hasEmailWebhook) {
      console.log('[Webhooks] Creating email webhook...');
      try {
        await sdkCreateWebhook({
          source: 'email',
          requestUrl: env.WEBHOOK_URL,
          name: WEBHOOK_NAMES.MAIL,
        });
        console.log('[Webhooks] Email webhook created');
      } catch (error) {
        console.error('[Webhooks] Failed to create email webhook:', error);
      }
    } else {
      console.log('[Webhooks] Email webhook already exists');
    }
    
    // Create email tracking webhook (for opens/clicks)
    if (!hasEmailTrackingWebhook) {
      console.log('[Webhooks] Creating email tracking webhook...');
      try {
        await sdkCreateWebhook({
          source: 'email_tracking',
          requestUrl: env.WEBHOOK_URL,
          name: 'ai-linkedin-email-tracking',
        });
        console.log('[Webhooks] Email tracking webhook created');
      } catch (error) {
        console.error('[Webhooks] Failed to create email tracking webhook:', error);
      }
    } else {
      console.log('[Webhooks] Email tracking webhook already exists');
    }
    
    // List final webhook configuration
    const finalWebhooks = await sdkListWebhooks() as UnipileWebhook[];
    console.log('[Webhooks] Final webhook configuration:');
    finalWebhooks.forEach((w: UnipileWebhook) => {
      console.log(`  - ${w.source}: ${w.request_url} (${w.name || 'unnamed'})`);
    });
    
  } catch (error) {
    console.error('[Webhooks] Setup failed:', error);
  }
}

/**
 * Remove all webhooks created by this app
 */
export async function cleanupWebhooks(): Promise<void> {
  if (!isUnipileConfigured()) {
    console.log('[Webhooks] Unipile not configured - nothing to cleanup');
    return;
  }
  
  console.log('[Webhooks] Cleaning up webhooks...');
  
  try {
    const webhooks = await sdkListWebhooks() as UnipileWebhook[];
    
    for (const webhook of webhooks) {
      if (webhook.name === WEBHOOK_NAMES.USERS || webhook.name === WEBHOOK_NAMES.MESSAGING || webhook.name === WEBHOOK_NAMES.MAIL) {
        console.log(`[Webhooks] Deleting webhook: ${webhook.name}`);
        await sdkDeleteWebhook(webhook.id);
      }
    }
    
    console.log('[Webhooks] Cleanup complete');
  } catch (error) {
    console.error('[Webhooks] Cleanup failed:', error);
  }
}

/**
 * List all registered webhooks
 */
export async function listWebhooks(): Promise<UnipileWebhook[]> {
  if (!isUnipileConfigured()) {
    return [];
  }
  
  return sdkListWebhooks() as Promise<UnipileWebhook[]>;
}
