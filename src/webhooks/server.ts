/**
 * Webhook Server - Receives webhooks from Unipile
 * 
 * Handles:
 * - new_relation: Connection accepted (up to 8hr delay)
 * - message_received: New LinkedIn messages (real-time)
 */

import express, { Express, Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import { handleWebhookEvent, type WebhookEvent } from './handlers.js';

/**
 * Verify webhook authenticity using Unipile-Auth header
 */
function verifyWebhook(req: Request, res: Response, next: NextFunction): void {
  const webhookSecret = env.WEBHOOK_SECRET;
  
  // If no secret configured, skip verification (development mode)
  if (!webhookSecret) {
    console.log('[Webhook] No secret configured - skipping verification');
    next();
    return;
  }
  
  const providedSecret = req.headers['unipile-auth'] as string;
  
  if (providedSecret !== webhookSecret) {
    console.warn('[Webhook] Invalid authentication header');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  
  next();
}

/**
 * Register webhook routes on an Express app
 * This allows webhooks to run on the same port as the main app (for Railway/Heroku)
 */
export function registerWebhookRoutes(app: Express): void {
  // Webhook endpoint
  app.post('/webhooks/unipile', verifyWebhook, async (req: Request, res: Response) => {
    const startTime = Date.now();
    
    try {
      const event = req.body as WebhookEvent;
      
      console.log(`[Webhook] Received event: ${event.event || 'unknown'}`, {
        account_type: event.account_type,
        account_id: event.account_id,
      });
      
      // Process the webhook asynchronously but respond immediately
      // Unipile requires 200 response within 30 seconds
      setImmediate(() => {
        handleWebhookEvent(event).catch(err => {
          console.error('[Webhook] Handler error:', err);
        });
      });
      
      res.status(200).json({ received: true });
      
      console.log(`[Webhook] Responded in ${Date.now() - startTime}ms`);
    } catch (error) {
      console.error('[Webhook] Error processing webhook:', error);
      // Still respond 200 to prevent retries for malformed events
      res.status(200).json({ received: true, error: 'Processing error' });
    }
  });
  
  console.log('[Webhook] Routes registered: POST /webhooks/unipile');
}

/**
 * Start a standalone webhook server (for local dev with separate port)
 */
export function startWebhookServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const port = env.WEBHOOK_PORT;
    
    const app = express();
    app.use(express.json());
    
    // Health check
    app.get('/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok', service: 'webhook-server' });
    });
    
    // Register webhook routes
    registerWebhookRoutes(app);
    
    const server = app.listen(port, () => {
      console.log(`[Webhook] Standalone server on port ${port}`);
      
      if (env.WEBHOOK_URL) {
        console.log(`[Webhook] Public URL: ${env.WEBHOOK_URL}`);
      }
      
      resolve();
    });
    
    server.on('error', (error) => {
      console.error('[Webhook] Server error:', error);
      reject(error);
    });
  });
}

