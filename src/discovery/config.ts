import { z } from 'zod';

/**
 * Configuration for what the bot should proactively look for
 * 
 * NOTE: Keywords and search queries are NOT hardcoded.
 * The AI generates them dynamically based on Underflow's context.
 */
export const discoveryConfigSchema = z.object({
  // Post discovery settings
  posts: z.object({
    enabled: z.boolean().default(true),
    // AI generates search terms dynamically - no hardcoded keywords
    minEngagement: z.number().default(10).describe('Minimum likes + comments'),
    maxPostsPerRun: z.number().default(3).describe('Max posts to surface per run'),
    autoGenerateComments: z.boolean().default(true).describe('Auto-draft comments'),
    // Note: Location filtering not effective for posts via Unipile
  }),

  // Profile/people discovery settings
  people: z.object({
    enabled: z.boolean().default(true),
    // AI generates search queries dynamically - no hardcoded queries
    targetLocations: z.array(z.string()).default([]).describe('Target locations (e.g., ["United States"])'),
    excludeConnected: z.boolean().default(true).describe('Skip already connected'),
    maxPeoplePerRun: z.number().default(5).describe('Target number of people to surface per run'),
    autoGenerateNotes: z.boolean().default(true).describe('Auto-draft connection notes'),
  }),

  // Schedule settings
  schedule: z.object({
    postsIntervalMinutes: z.number().default(60).describe('How often to check for posts'),
    peopleIntervalMinutes: z.number().default(90).describe('How often to check for people'),
    activeHoursStart: z.number().min(0).max(23).default(9).describe('Start hour (24h)'),
    activeHoursEnd: z.number().min(0).max(23).default(18).describe('End hour (24h)'),
    activeDays: z.array(z.number().min(0).max(6)).default([1, 2, 3, 4, 5]).describe('Days (0=Sun)'),
  }),

  // Slack settings
  slack: z.object({
    channelId: z.string().describe('Channel to post discoveries'),
    mentionUser: z.string().optional().describe('User ID to mention'),
  }),
});

export type DiscoveryConfig = z.infer<typeof discoveryConfigSchema>;

/**
 * Default configuration - customize for your use case
 */
export const DEFAULT_DISCOVERY_CONFIG: DiscoveryConfig = {
  posts: {
    enabled: false,
    // AI generates search terms dynamically - no hardcoded keywords
    minEngagement: 10,
    maxPostsPerRun: 3, // Conservative - quality over quantity
    autoGenerateComments: true,
  },

  people: {
    enabled: false,
    // AI generates search queries dynamically - no hardcoded queries
    targetLocations: [
      'United States',
      'Canada',
      'United Kingdom',
    ],
    excludeConnected: true,
    maxPeoplePerRun: 5, // Exactly 5 people * 6 runs/day = 30/day
    autoGenerateNotes: true,
  },

  schedule: {
    postsIntervalMinutes: 60,      // Check for posts every hour
    peopleIntervalMinutes: 90,     // Every 90 min = 6 runs during 9am-6pm = ~30 people/day
    activeHoursStart: 9,           // 9 AM
    activeHoursEnd: 18,            // 6 PM
    activeDays: [1, 2, 3, 4, 5],   // Monday - Friday
  },

  slack: {
    channelId: '', // Must be set
    mentionUser: undefined,
  },
};

/**
 * In-memory config store (in production, use a database)
 */
let currentConfig: DiscoveryConfig = { ...DEFAULT_DISCOVERY_CONFIG };

export function getDiscoveryConfig(): DiscoveryConfig {
  return currentConfig;
}

export function updateDiscoveryConfig(updates: Partial<DiscoveryConfig>): DiscoveryConfig {
  currentConfig = {
    ...currentConfig,
    ...updates,
    posts: { ...currentConfig.posts, ...updates.posts },
    people: { ...currentConfig.people, ...updates.people },
    schedule: { ...currentConfig.schedule, ...updates.schedule },
    slack: { ...currentConfig.slack, ...updates.slack },
  };
  return currentConfig;
}

