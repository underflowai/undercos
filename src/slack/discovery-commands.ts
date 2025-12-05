import type { App } from '@slack/bolt';
import type { DiscoveryEngine } from '../discovery/engine.js';

export function registerDiscoveryCommands(app: App, engine: DiscoveryEngine | null): void {
  app.command('/posts', async ({ ack, respond }) => {
    await ack();

    if (!engine) {
      await respond({ text: 'Discovery engine not running (no DISCOVERY_CHANNEL_ID).', response_type: 'ephemeral' });
      return;
    }

    await respond({ text: 'Running post discovery...', response_type: 'ephemeral' });
    try {
      await engine.triggerNow('posts');
      await respond({ text: 'Post discovery finished.', response_type: 'ephemeral' });
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

    await respond({ text: 'Running connection discovery...', response_type: 'ephemeral' });
    try {
      await engine.triggerNow('people');
      await respond({ text: 'Connection discovery finished.', response_type: 'ephemeral' });
    } catch (error) {
      await respond({ text: `Connection discovery failed: ${error instanceof Error ? error.message : 'unknown error'}`, response_type: 'ephemeral' });
    }
  });
}

