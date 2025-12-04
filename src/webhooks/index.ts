/**
 * Webhooks Module
 * 
 * Handles real-time events from Unipile:
 * - Connection accepted (new_relation)
 * - New messages (message_received)
 */

export { startWebhookServer, registerWebhookRoutes } from './server.js';
export { setupWebhooks, cleanupWebhooks, listWebhooks } from './setup.js';
export { handleWebhookEvent, setSlackClient, type WebhookEvent } from './handlers.js';

