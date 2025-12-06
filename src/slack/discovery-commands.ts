import type { App } from '@slack/bolt';
import type { DiscoveryEngine } from '../discovery/engine.js';

export function registerDiscoveryCommands(app: App, engine: DiscoveryEngine | null): void {
  app.command('/posts', async ({ ack, respond }) => {
    await ack();

    if (!engine) {
      await respond({ text: 'Discovery engine not running (no DISCOVERY_CHANNEL_ID).', response_type: 'ephemeral' });
      return;
    }

    try {
      await engine.triggerNow('posts');
    } catch (error) {
      await respond({ text: `Post discovery failed: ${error instanceof Error ? error.message : 'unknown error'}`, response_type: 'ephemeral' });
    }
  });

  app.command('/connect', async ({ ack, respond }) => {
    await ack();

    if (!engine) {
      await respond({ text: 'Discovery engine not running (no DISCOVERY_CHANNEL_ID).', response_type: 'ephemeral' });
      return;
    }

    try {
      await engine.triggerNow('people');
    } catch (error) {
      await respond({ text: `Connection discovery failed: ${error instanceof Error ? error.message : 'unknown error'}`, response_type: 'ephemeral' });
    }
  });
}

