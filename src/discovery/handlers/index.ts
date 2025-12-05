/**
 * Discovery Handlers Index
 * 
 * Re-exports all handler registration functions
 */

import type { App } from '@slack/bolt';
import { registerPostHandlers } from './post-handlers.js';
import { registerPeopleHandlers } from './people-handlers.js';
import { registerFollowUpHandlers } from './followup-handlers.js';

/**
 * Register all discovery-related Slack handlers
 */
export function registerDiscoveryHandlers(app: App): void {
  registerPostHandlers(app);
  registerPeopleHandlers(app);
  registerFollowUpHandlers(app);
}

export { registerPostHandlers } from './post-handlers.js';
export { registerPeopleHandlers } from './people-handlers.js';
export { registerFollowUpHandlers } from './followup-handlers.js';

