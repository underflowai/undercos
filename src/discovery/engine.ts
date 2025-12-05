/**
 * Discovery Engine - Orchestrates proactive LinkedIn and email discovery
 * 
 * This is the main coordinator that ties together:
 * - Post discovery (post-discovery.ts)
 * - People discovery (people-discovery.ts)
 * - Email/meeting notes discovery (email-discovery.ts)
 * - Meeting follow-ups (meeting-followup.ts)
 * - Lead follow-up cadence (lead-followup.ts)
 */

import type { WebClient } from '@slack/web-api';
import type { ResponsesAPIClient } from '../llm/responses.js';
import { getDiscoveryConfig, type DiscoveryConfig } from './config.js';
import { scheduleTask, getSchedulerStatus, isWithinActiveHours } from './scheduler.js';
import { getActivitySummary, formatActivitySummaryForSlack } from './activity-tracker.js';

// Post discovery
import {
  discoverPosts,
  surfacePost,
  getSeenPostsCount,
  type DiscoveredPost,
} from './post-discovery.js';

// People discovery
import {
  discoverPeople,
  surfacePerson,
  surfaceQueuedConnections,
  type DiscoveredProfile,
} from './people-discovery.js';
import { getSeenProfilesCount, getLeadStatistics } from '../db/index.js';

// Email discovery (legacy meeting notes check)
import {
  checkMeetingNotes,
  surfaceMeetingNote,
  getSeenMeetingNotesCount,
  type MeetingNoteEmail,
} from './email-discovery.js';

// Meeting follow-ups (calendar-driven)
import { discoverMeetingFollowUps, runHistoricalBackfill } from './meeting-followup.js';

// Lead follow-up cadence
import { runFollowUpCadence, runResponseDetection as checkForResponses } from './lead-followup.js';

/**
 * Discovery Engine - the main orchestrator
 */
export class DiscoveryEngine {
  private slackClient: WebClient;
  private llm: ResponsesAPIClient;
  private isRunning = false;

  constructor(slackClient: WebClient, llm: ResponsesAPIClient) {
    this.slackClient = slackClient;
    this.llm = llm;
  }

  /**
   * Start the discovery engine
   */
  start(): void {
    const config = getDiscoveryConfig();

    // Schedule post discovery
    if (config.posts.enabled) {
      scheduleTask(
        'discover-posts',
        'Post Discovery',
        config.schedule.postsIntervalMinutes,
        () => this.runPostDiscovery()
      );
    }

    // Schedule people discovery
    if (config.people.enabled) {
      scheduleTask(
        'discover-people',
        'People Discovery',
        config.schedule.peopleIntervalMinutes,
        () => this.runPeopleDiscovery()
      );
    }

    // Schedule meeting notes check (legacy)
    scheduleTask(
      'check-meeting-notes',
      'Meeting Notes Check',
      120, // Every 2 hours
      () => this.runMeetingNotesCheck()
    );

    // Schedule meeting follow-up discovery (calendar-driven)
    // Runs every 15 minutes to catch meetings that just ended
    scheduleTask(
      'meeting-followups',
      'Meeting Follow-ups',
      15,
      () => this.runMeetingFollowUps()
    );

    // Schedule lead follow-up cadence check
    // Runs every 4 hours to check for leads needing follow-up
    scheduleTask(
      'lead-cadence',
      'Lead Follow-up Cadence',
      240, // Every 4 hours
      () => this.runLeadCadence()
    );

    // Schedule response detection (more frequent)
    // Runs every hour to check if leads have responded
    scheduleTask(
      'response-detection',
      'Response Detection',
      60,
      () => this.runResponseDetection()
    );

    this.isRunning = true;
    console.log('[Discovery] Engine started');

    // Run initial LinkedIn discovery after short delays (only during active hours)
    if (isWithinActiveHours()) {
      setTimeout(() => {
        if (config.posts.enabled) this.runPostDiscovery();
      }, 5000);

      setTimeout(() => {
        if (config.people.enabled) this.runPeopleDiscovery();
      }, 15000);
    } else {
      console.log('[Discovery] Outside active hours (9am-6pm Mon-Fri) - skipping LinkedIn discovery');
    }

    // Email follow-ups run regardless of active hours
    // Run historical backfill on startup to catch any missed meetings
    // Start with just 7 days for faster initial testing
    setTimeout(() => {
      console.log('[Discovery] Starting historical meeting backfill (last 7 days)...');
      this.runHistoricalBackfill(7);
    }, 10000);
  }

  /**
   * Run historical backfill for meetings from the last N days
   */
  async runHistoricalBackfill(daysBack: number = 30): Promise<void> {
    const config = getDiscoveryConfig();
    
    try {
      const result = await runHistoricalBackfill(this.slackClient, this.llm, config, daysBack);
      console.log(`[Discovery] Backfill complete: ${result.surfaced} follow-ups surfaced`);
    } catch (error) {
      console.error('[Discovery] Historical backfill failed:', error);
    }
  }

  /**
   * Stop the discovery engine
   */
  stop(): void {
    this.isRunning = false;
    console.log('[Discovery] Engine stopped');
  }

  // ============================================
  // DISCOVERY RUNNERS
  // ============================================

  /**
   * Run post discovery
   */
  private async runPostDiscovery(): Promise<void> {
    const config = getDiscoveryConfig();
    
    try {
      const posts = await discoverPosts(this.llm, config);
      
      for (const post of posts) {
        await surfacePost(this.slackClient, this.llm, post, config);
      }
    } catch (error) {
      console.error('[Discovery] Post discovery failed:', error);
    }
  }

  /**
   * Run people discovery
   */
  private async runPeopleDiscovery(): Promise<void> {
    const config = getDiscoveryConfig();
    
    try {
      await surfaceQueuedConnections(this.slackClient, config);

      const profiles = await discoverPeople(this.llm, config);
      
      for (const profile of profiles) {
        await surfacePerson(this.slackClient, this.llm, profile, config);
      }
    } catch (error) {
      console.error('[Discovery] People discovery failed:', error);
    }
  }

  /**
   * Run meeting notes check (legacy)
   */
  private async runMeetingNotesCheck(): Promise<void> {
    const config = getDiscoveryConfig();
    
    try {
      const meetingNotes = await checkMeetingNotes(this.llm, config);
      
      for (const email of meetingNotes) {
        await surfaceMeetingNote(this.slackClient, this.llm, email, config);
      }
    } catch (error) {
      console.error('[Discovery] Meeting notes check failed:', error);
    }
  }

  /**
   * Run meeting follow-ups (calendar-driven)
   */
  private async runMeetingFollowUps(): Promise<void> {
    const config = getDiscoveryConfig();
    
    try {
      await discoverMeetingFollowUps(this.slackClient, this.llm, config);
    } catch (error) {
      console.error('[Discovery] Meeting follow-ups failed:', error);
    }
  }

  /**
   * Run lead follow-up cadence check
   */
  private async runLeadCadence(): Promise<void> {
    const config = getDiscoveryConfig();
    
    try {
      await runFollowUpCadence(this.slackClient, this.llm, config);
    } catch (error) {
      console.error('[Discovery] Lead cadence check failed:', error);
    }
  }

  /**
   * Run response detection
   */
  private async runResponseDetection(): Promise<void> {
    const config = getDiscoveryConfig();
    
    try {
      await checkForResponses(this.slackClient, config);
    } catch (error) {
      console.error('[Discovery] Response detection failed:', error);
    }
  }

  // ============================================
  // STATUS & CONTROLS
  // ============================================

  /**
   * Get engine status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      tasks: getSchedulerStatus(),
      seenPosts: getSeenPostsCount(),
      seenProfiles: getSeenProfilesCount(),
      seenMeetingNotes: getSeenMeetingNotesCount(),
      leads: getLeadStatistics(),
      activity: getActivitySummary(),
    };
  }

  /**
   * Post activity status to Slack
   */
  async postActivityStatus(): Promise<void> {
    const config = getDiscoveryConfig();
    const statusText = formatActivitySummaryForSlack();
    
    try {
      await this.slackClient.chat.postMessage({
        channel: config.slack.channelId,
        text: statusText,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: statusText,
            },
          },
        ],
      });
    } catch (error) {
      console.error('[Discovery] Failed to post activity status:', error);
    }
  }

  /**
   * Manually trigger discovery
   */
  async triggerNow(type: 'posts' | 'people' | 'meeting_notes' | 'meeting_followups' | 'lead_cadence' | 'activity_status' | 'historical_backfill'): Promise<void> {
    switch (type) {
      case 'posts':
        await this.runPostDiscovery();
        break;
      case 'people':
        await this.runPeopleDiscovery();
        break;
      case 'meeting_notes':
        await this.runMeetingNotesCheck();
        break;
      case 'meeting_followups':
        await this.runMeetingFollowUps();
        break;
      case 'lead_cadence':
        await this.runLeadCadence();
        break;
      case 'activity_status':
        await this.postActivityStatus();
        break;
      case 'historical_backfill':
        await this.runHistoricalBackfill(30);
        break;
    }
  }
}

// Re-export types for convenience
export type { DiscoveredPost, DiscoveredProfile, MeetingNoteEmail };
