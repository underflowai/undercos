/**
 * People Discovery - Find and surface relevant LinkedIn profiles
 */

import type { WebClient } from '@slack/web-api';
import type { KnownBlock } from '@slack/bolt';
import { ResponsesAPIClient } from '../llm/responses.js';
import {
  isUnipileConfigured,
  getActiveLinkedinAccountId,
  searchLinkedIn,
  getProfile,
  getLocationIds,
} from '../tools/unipile-sdk.js';

// Type definition for profile
import { enqueueSuggestion, getSurfaceCount, incrementSurfaceCount, dequeueSuggestionsForDate } from '../db/connection-queue.js';
import { postConnectionMessage } from '../slack/connection-thread.js';
interface UnipileProfile {
  id: string;
  provider_id?: string;
  name: string;
  headline?: string;
  company?: string;
  location?: string;
  profile_url?: string;
  is_connection?: boolean;
  about?: string;
}
import type { DiscoveryConfig } from './config.js';
import { shouldThrottle, recordActivity } from './activity-tracker.js';
import { generateContent } from '../llm/content-generator.js';
import { env } from '../config/env.js';
import {
  isProfileSeen,
  addSurfacedProfile,
  getSeenProfilesCount,
} from '../db/index.js';
import { getLatestAction } from '../db/actions-log.js';
import {
  PERSON_RELEVANCE_PROMPT,
  CONNECTION_NOTE_PROMPT,
  PROFILE_RESEARCH_PROMPT,
  formatPersonForRelevanceCheck,
  formatProfileForConnectionNote,
  type RichProfile,
} from '../prompts/index.js';

// Static search terms for people discovery - targeting commercial insurance decision makers
// Keep queries short (3-5 words) for LinkedIn search effectiveness
const STATIC_PEOPLE_SEARCH_TERMS = [
  // MGA leadership
  'MGA CEO insurance',
  'MGA president underwriting',
  'managing general agent VP',
  'MGA chief underwriting officer',
  'program administrator director',
  
  // Wholesale brokers
  'wholesale broker VP',
  'wholesale insurance director',
  'surplus lines broker',
  'E&S broker executive',
  'wholesale operations director',
  
  // Underwriting leadership
  'VP underwriting commercial',
  'chief underwriting officer',
  'underwriting director specialty',
  'head of underwriting MGA',
  'commercial underwriting VP',
  
  // Operations & technology
  'insurance operations director',
  'VP operations MGA',
  'insurtech founder',
  'insurance technology director',
  'digital transformation insurance',
  
  // Specialty carriers
  'E&S carrier executive',
  'specialty insurance VP',
  'excess surplus director',
  'commercial P&C executive',
  'property casualty VP',
];

// Track which search terms we've used this session to rotate through them
let searchTermIndex = 0;

// LLM with web search for research (uses OpenAI for web search capability)
let researchLLM: ResponsesAPIClient | null = null;

function getResearchLLM(): ResponsesAPIClient {
  if (!researchLLM) {
    researchLLM = new ResponsesAPIClient(env.OPENAI_API_KEY, {
      enableWebSearch: true,
    });
    console.log(`[PeopleDiscovery] Research LLM initialized with web search`);
  }
  return researchLLM;
}

// Research findings for a profile
interface ProfileResearch {
  shared_context: string | null;
  recent_content: string | null;
  talking_point: string | null;
  inroad_quality: 'strong' | 'weak' | 'none';
  suggested_approach: 'shared_context' | 'event_based' | 'direct_cold' | 'no_note';
}

/**
 * Research a profile to find genuine connection points
 */
async function researchProfile(profile: RichProfile): Promise<ProfileResearch> {
  const defaultResearch: ProfileResearch = {
    shared_context: null,
    recent_content: null,
    talking_point: null,
    inroad_quality: 'none',
    suggested_approach: 'direct_cold',
  };

  try {
    const researchLlm = getResearchLLM();
    const formattedProfile = formatProfileForConnectionNote(profile);
    
    // Build search query from profile
    const searchQuery = `"${profile.name}" ${profile.company || ''} ${profile.headline?.split(' ').slice(0, 3).join(' ') || ''} insurance`;
    
    console.log(`[PeopleDiscovery] Researching ${profile.name}...`);
    console.log(`[PeopleDiscovery] Web search query: "${searchQuery}"`);
    
    const input = [
      { type: 'message' as const, role: 'system' as const, content: PROFILE_RESEARCH_PROMPT },
      { type: 'message' as const, role: 'user' as const, content: `Research this person and find a genuine inroad:

PROFILE:
${formattedProfile}

SEARCH FOR: "${profile.name}" to find recent articles, conference talks, or content they've created.

Ola's context for finding shared things:
- Ola went to McGill (Montreal)
- Ola is based in [check their location - if same city, note it]
- Ola worked at National Bank Financial, Faire
- Ola is building Underflow (commercial insurance automation)

Return the JSON research findings.` },
    ];
    
    const response = await researchLlm.createResponse(input, []);
    const text = response.outputText || '';
    
    // Try to parse JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as ProfileResearch;
      console.log(`[PeopleDiscovery] Research result: inroad=${parsed.inroad_quality}, approach=${parsed.suggested_approach}`);
      if (parsed.shared_context) console.log(`[PeopleDiscovery] Shared context: ${parsed.shared_context}`);
      if (parsed.talking_point) console.log(`[PeopleDiscovery] Talking point: ${parsed.talking_point}`);
      return parsed;
    }
    
    console.log('[PeopleDiscovery] Could not parse research response, using defaults');
    return defaultResearch;
  } catch (error) {
    console.error('[PeopleDiscovery] Research failed:', error);
    return defaultResearch;
  }
}

/**
 * Fetch full profile from Unipile and convert to RichProfile format
 */
async function fetchFullProfile(profileId: string): Promise<RichProfile | null> {
  if (!isUnipileConfigured()) {
    console.log('[PeopleDiscovery] Cannot fetch full profile - Unipile not configured');
    return null;
  }
  
  try {
    console.log(`[PeopleDiscovery] Fetching full profile for ${profileId}...`);
    const fullProfile = await getProfile(profileId) as any;
    
    if (!fullProfile) return null;
    
    // Convert to RichProfile
    const richProfile: RichProfile = {
      name: fullProfile.name,
      headline: fullProfile.headline,
      company: fullProfile.company,
      location: fullProfile.location,
      summary: fullProfile.about,
    };
    
    console.log(`[PeopleDiscovery] Fetched profile: ${richProfile.name} (${richProfile.location || 'no location'})`);
    if (richProfile.summary) {
      console.log(`[PeopleDiscovery] Has summary: ${richProfile.summary.slice(0, 100)}...`);
    }
    
    return richProfile;
  } catch (error) {
    console.error(`[PeopleDiscovery] Failed to fetch full profile for ${profileId}:`, error);
    return null;
  }
}

export interface DiscoveredProfile {
  id: string; // Public identifier for deduplication
  provider_id: string; // Internal LinkedIn ID (ACoAAA...) - REQUIRED for invitations
  name: string;
  headline?: string;
  profile_url?: string;
  company?: string;
  is_connection?: boolean;
  search_query?: string; // Which query found this person (for learning)
}

/**
 * Get next batch of people search queries from static list
 * Rotates through the list to get variety across runs
 */
export function getPeopleSearchQueries(count: number = 3): string[] {
  const queries: string[] = [];
  
  for (let i = 0; i < count; i++) {
    queries.push(STATIC_PEOPLE_SEARCH_TERMS[searchTermIndex]);
    searchTermIndex = (searchTermIndex + 1) % STATIC_PEOPLE_SEARCH_TERMS.length;
  }
  
  console.log(`[PeopleDiscovery] Using search queries: ${queries.join(', ')}`);
  return queries;
}

/**
 * Check if a person is relevant using AI
 */
export async function isPersonRelevant(
  llm: ResponsesAPIClient,
  profile: { name: string; headline?: string; company?: string }
): Promise<boolean> {
  try {
    const input = [
      { type: 'message' as const, role: 'system' as const, content: PERSON_RELEVANCE_PROMPT },
      { type: 'message' as const, role: 'user' as const, content: formatPersonForRelevanceCheck(profile) },
    ];

    const response = await llm.createResponse(input, []);
    const answer = (response.outputText || '').toLowerCase().trim();
    const isRelevant = answer.includes('yes');
    
    console.log(`[PeopleDiscovery] Relevance for ${profile.name}: ${isRelevant ? 'RELEVANT' : 'NOT RELEVANT'}`);
    return isRelevant;
  } catch (error) {
    console.error('[PeopleDiscovery] Failed to check relevance:', error);
    return false; // Be conservative
  }
}

/**
 * Generate a brief on this person like a human chief of staff would write it
 */
async function generatePersonBrief(
  profile: RichProfile,
  llm: ResponsesAPIClient
): Promise<string> {
  try {
    const formattedProfile = formatProfileForConnectionNote(profile);
    
    const result = await generateContent({
      systemPrompt: `You're a chief of staff sending your boss a quick Slack message about someone worth connecting with.

Write 1-2 casual sentences about who this person is and why they're worth a connection. Write like you're texting a colleague, not writing a formal brief.

Good examples:
- "SVP at Brown & Riding, one of the bigger wholesalers. Runs their production underwriting."
- "VP Ops at an MGA in Texas. Been there 8 years, probably knows everyone."
- "Underwriting director at a specialty carrier. Came from Travelers."

Bad examples (too formal/robotic):
- "This individual holds a senior position..."
- "Recommendation: Connect with this prospect..."
- "Key decision maker in the commercial insurance space."

Keep it under 150 chars. Sound human.`,
      userPrompt: formattedProfile,
      maxTokens: 256,
      effort: 'low',
    }, llm);
    
    return result.text?.slice(0, 200) || '';
  } catch (error) {
    console.error('[PeopleDiscovery] Failed to generate person brief:', error);
    return '';
  }
}

/**
 * Generate a connection note using Claude Opus 4.5 (effort: high)
 * 
 * Two-stage process:
 * 1. Research the profile (web search via OpenAI)
 * 2. Generate note based on findings (Claude Opus 4.5 for natural writing)
 * 
 * Returns empty string if AI recommends no note
 */
export async function generateConnectionNote(
  llm: ResponsesAPIClient, // Used for fallback if Claude unavailable
  profile: RichProfile
): Promise<{ note: string; research: ProfileResearch }> {
  const defaultResearch: ProfileResearch = {
    shared_context: null,
    recent_content: null,
    talking_point: null,
    inroad_quality: 'none',
    suggested_approach: 'direct_cold',
  };

  try {
    // Step 1: Research the profile (uses OpenAI with web search)
    const research = await researchProfile(profile);
    
    // Step 2: Generate note using Claude Opus 4.5 (high effort for quality)
    const formattedProfile = formatProfileForConnectionNote(profile);
    
    // Build research context for the note generator
    let researchContext = 'RESEARCH FINDINGS:\n';
    if (research.shared_context) {
      researchContext += `- Shared context: ${research.shared_context}\n`;
    }
    if (research.recent_content) {
      researchContext += `- Their recent content: ${research.recent_content}\n`;
    }
    if (research.talking_point) {
      researchContext += `- Talking point from web: ${research.talking_point}\n`;
    }
    researchContext += `- Inroad quality: ${research.inroad_quality}\n`;
    researchContext += `- Suggested approach: ${research.suggested_approach}\n`;
    
    if (research.inroad_quality === 'none') {
      researchContext += '\nNo strong inroad found. Use direct approach or no note.';
    }
    
    console.log(`[PeopleDiscovery] Generating connection note for ${profile.name} with Claude Opus 4.5...`);
    console.log(`[PeopleDiscovery] Research: ${research.inroad_quality} inroad, approach=${research.suggested_approach}`);
    
    // Use Claude Opus 4.5 for natural, human-like writing
    const result = await generateContent({
      systemPrompt: CONNECTION_NOTE_PROMPT,
      userPrompt: `PROFILE:\n${formattedProfile}\n\n${researchContext}`,
      maxTokens: 512, // Connection notes are short
      effort: 'high', // Use high effort for quality writing
    }, llm);
    
    console.log(`[PeopleDiscovery] Note generated by ${result.provider} (${result.model})`);
    
    let note = result.text?.trim() || '';
    
    // Handle [NO_NOTE] response
    if (note.includes('[NO_NOTE]') || note === 'NO_NOTE') {
      console.log(`[PeopleDiscovery] AI recommends no note for ${profile.name}`);
      return { note: '', research };
    }
    
    // Clean up the note
    note = note.replace(/^["']|["']$/g, '').slice(0, 300);
    console.log(`[PeopleDiscovery] Generated note: "${note}"`);
    return { note, research };
  } catch (error) {
    console.error('[PeopleDiscovery] Failed to generate connection note:', error);
    return { note: '', research: defaultResearch };
  }
}

/**
 * Discover relevant people - keeps searching until we have exactly the target number
 */
export async function discoverPeople(
  llm: ResponsesAPIClient,
  config: DiscoveryConfig
): Promise<DiscoveredProfile[]> {
  // Check throttling
  const throttleCheck = shouldThrottle();
  if (throttleCheck.throttle) {
    console.log(`[PeopleDiscovery] Throttling: ${throttleCheck.reason}`);
    return [];
  }

  const targetCount = config.people.maxPeoplePerRun;
  const maxSearchRounds = 3;

  console.log(`[PeopleDiscovery] Searching for exactly ${targetCount} people...`);

  const relevantProfiles: DiscoveredProfile[] = [];
  const seenInThisRun = new Set<string>();

  for (let round = 0; round < maxSearchRounds && relevantProfiles.length < targetCount; round++) {
    const searchQueries = getPeopleSearchQueries(3);
    
    let profiles: DiscoveredProfile[] = [];

    if (isUnipileConfigured()) {
      // Get location IDs if specified
      let locationIds: string[] | undefined;
      if (config.people.targetLocations.length > 0) {
        const allIds = await Promise.all(
          config.people.targetLocations.map(loc => getLocationIds(loc))
        );
        locationIds = allIds.flat();
      }
        
      for (const query of searchQueries) {
        if (relevantProfiles.length >= targetCount) break;
        
        try {
          recordActivity('search');
          const result = await searchLinkedIn({
            category: 'people',
            keywords: query,
            limit: 10,
            location: locationIds,
          });
          // Track which query found each profile
          // Note: Unipile returns id as the provider_id (ACoAAA...), public_identifier as the slug
          profiles.push(...result.items.map((p: any) => ({
            id: p.public_identifier || p.id, // Use slug for deduplication
            provider_id: p.id, // The ACoAAA... ID needed for invitations
            name: p.name,
            headline: p.headline,
            profile_url: p.profile_url,
            company: p.company,
            is_connection: p.network_distance === 'DISTANCE_1', // 1st degree = connected
            search_query: query,
          })));
        } catch (error) {
          console.error(`[PeopleDiscovery] Search failed for "${query}":`, error);
        }
      }
    } else {
      profiles = getMockProfiles();
    }

    // Filter: dedupe, exclude connected, exclude already checked this run
    const filtered = profiles
      .filter(p => {
        if (isProfileSeen(p.id)) {
          return false; // Already in database
        }
        if (seenInThisRun.has(p.id)) {
          return false; // Already checked this run
        }
        if (config.people.excludeConnected && p.is_connection) {
          return false;
        }
        return true;
      });

    // Check relevance until we have enough
    for (const profile of filtered) {
      if (relevantProfiles.length >= targetCount) break;
      
      seenInThisRun.add(profile.id);
      const isRelevant = await isPersonRelevant(llm, profile);
      
      if (isRelevant) {
        relevantProfiles.push(profile);
        console.log(`[PeopleDiscovery] Found ${relevantProfiles.length}/${targetCount}: ${profile.name}`);
      }
    }

    if (relevantProfiles.length < targetCount) {
      console.log(`[PeopleDiscovery] Round ${round + 1}: ${relevantProfiles.length}/${targetCount}, searching more...`);
    }
  }

  const totalSeen = getSeenProfilesCount();
  console.log(`[PeopleDiscovery] Found ${relevantProfiles.length} relevant people (${totalSeen} total in database)`);

  return relevantProfiles;
}

/**
 * Surface a person in Slack - formatted like a message from a human chief of staff
 */

const ADHOC_SURFACE_LIMIT = 20; // daily cap for ad-hoc suggestions; meeting-derived are uncapped

function getDateKey(date: Date = new Date()): string {
  return date.toISOString().split('T')[0];
}

function buildConnectionBlocks(
  messageText: string,
  profile: DiscoveredProfile,
  draftNote: string,
  opts: { includeSendWithoutNote?: boolean } = { includeSendWithoutNote: true }
): KnownBlock[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: messageText,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button' as const,
          text: { type: 'plain_text' as const, text: 'Approve', emoji: false },
          style: 'primary',
          action_id: 'discovery_connect_approve',
          value: JSON.stringify({ profileId: profile.provider_id, profileUrl: profile.profile_url, profileName: profile.name, draft: draftNote }),
        },
        ...(opts.includeSendWithoutNote
          ? [
              {
                type: 'button' as const,
                text: { type: 'plain_text' as const, text: 'Send without note', emoji: false },
                action_id: 'discovery_connect_no_note',
                value: JSON.stringify({ profileId: profile.provider_id, profileUrl: profile.profile_url, profileName: profile.name, draft: '' }),
              },
            ]
          : []),
        ...(profile.profile_url ? [{
          type: 'button' as const,
          text: { type: 'plain_text' as const, text: 'View Profile', emoji: false },
          url: profile.profile_url,
          action_id: 'discovery_view_profile',
        }] : []),
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Edit Note', emoji: false },
          action_id: 'discovery_connect',
          value: JSON.stringify({ profileId: profile.provider_id, profileUrl: profile.profile_url, profileName: profile.name, draft: draftNote }),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Skip', emoji: false },
          action_id: 'discovery_skip_person',
          value: JSON.stringify({
            profileId: profile.id,
            profileUrl: profile.profile_url,
            profileName: profile.name,
          }),
        },
      ],
    },
  ];
}

export async function surfacePerson(
  slackClient: WebClient,
  llm: ResponsesAPIClient,
  profile: DiscoveredProfile,
  config: DiscoveryConfig
): Promise<void> {
  // Fetch full profile for better context
  const fullProfile = await fetchFullProfile(profile.id);
  // Always use original profile.name as fallback (Unipile sometimes returns profile without name)
  const richProfile: RichProfile = {
    name: fullProfile?.name || profile.name,
    headline: fullProfile?.headline || profile.headline,
    company: fullProfile?.company || profile.company,
    location: fullProfile?.location,
    summary: fullProfile?.summary,
  };

  // Skip if already connected or recently attempted
  if (profile.provider_id) {
    const existing = getLatestAction('send_connection_request', 'linkedin_profile', profile.provider_id);
    if (existing && (existing.status === 'succeeded' || existing.status === 'pending')) {
      return;
    }
    const isConnected = (fullProfile as any)?.is_connection || profile.is_connection;
    if (isConnected) {
      return;
    }
  }

  // Generate brief about this person
  const brief = await generatePersonBrief(richProfile, llm);
  
  // Generate draft connection note (now includes research)
  let draftNote = '';
  let researchSummary = '';
  if (config.people.autoGenerateNotes) {
    const { note, research } = await generateConnectionNote(llm, richProfile);
    draftNote = note;
    
    // Build research summary for context
    if (research.inroad_quality !== 'none') {
      const parts: string[] = [];
      if (research.shared_context) parts.push(research.shared_context);
      if (research.talking_point) parts.push(research.talking_point);
      if (research.recent_content) parts.push(`Recent: ${research.recent_content.slice(0, 50)}`);
      if (parts.length > 0) {
        researchSummary = parts.join(' · ');
      }
    }
  }

  // Build message like a human chief of staff would write it
  let messageText = `*${profile.name}*`;
  if (brief) {
    messageText += `\n${brief}`;
  }
  // Show research findings if we found something
  if (researchSummary) {
    messageText += `\n_Inroad: ${researchSummary}_`;
  }
  if (draftNote) {
    messageText += `\n\nDraft:\n>${draftNote}`;
  } else {
    messageText += `\n\n_No note recommended - sometimes that converts better_`;
  }

  const blocks = buildConnectionBlocks(messageText, profile, draftNote);

  const todayCount = getSurfaceCount('ad_hoc');
  if (todayCount >= ADHOC_SURFACE_LIMIT) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const scheduledFor = getDateKey(tomorrow);
    // Record profile now even though surfacing is queued (prevents re-discovery)
    addSurfacedProfile({
      id: profile.id,
      provider_id: profile.provider_id,
      name: profile.name,
      headline: profile.headline,
      company: profile.company,
      profile_url: profile.profile_url,
      connection_note: draftNote || undefined,
      source: 'ad_hoc',
    });

    enqueueSuggestion({
      source: 'ad_hoc',
      scheduledFor,
      payload: {
        profileName: profile.name,
        profileUrl: profile.profile_url,
        providerId: profile.provider_id,
        draftNote,
        brief,
        researchSummary,
        blocks,
        text: profile.name,
      },
      priority: 0,
    });
    console.log(`[PeopleDiscovery] Surface cap reached (${todayCount}/${ADHOC_SURFACE_LIMIT}); queued ${profile.name} for ${scheduledFor}`);
    return;
  }

  // Record profile in database to prevent re-surfacing
  addSurfacedProfile({
    id: profile.id,
    provider_id: profile.provider_id,
    name: profile.name,
    headline: profile.headline,
    company: profile.company,
    profile_url: profile.profile_url,
    connection_note: draftNote || undefined,
    source: 'ad_hoc',
  });

  incrementSurfaceCount('ad_hoc');
  await postConnectionMessage(slackClient, config.slack.channelId, { text: profile.name, blocks });
}


/**
 * Drain queued ad-hoc suggestions for today (respecting surface cap)
 */
export async function surfaceQueuedConnections(
  slackClient: WebClient,
  config: DiscoveryConfig
): Promise<void> {
  const today = new Date();
  const todayKey = getDateKey(today);
  let remaining = Math.max(0, ADHOC_SURFACE_LIMIT - getSurfaceCount('ad_hoc'));
  if (remaining <= 0) return;

  const queued = dequeueSuggestionsForDate(todayKey, remaining);
  for (const item of queued) {
    const blocks = (item.blocks as KnownBlock[] | undefined) || buildConnectionBlocks(
      `*${item.profileName}*${item.brief ? `
${item.brief}` : ''}${item.researchSummary ? `
_Inroad: ${item.researchSummary}_` : ''}${item.draftNote ? `

Draft:
>${item.draftNote}` : ''}`,
      {
        id: item.providerId || item.profileUrl || item.profileName,
        provider_id: item.providerId || '',
        name: item.profileName,
        headline: '',
        profile_url: item.profileUrl,
        company: '',
        is_connection: false,
      } as DiscoveredProfile,
      item.draftNote || ''
    );

    incrementSurfaceCount('ad_hoc');
    await postConnectionMessage(slackClient, config.slack.channelId, {
      text: item.text || item.profileName,
      blocks,
    });

    remaining -= 1;
    if (remaining <= 0) break;
  }
}

// ============================================
// MOCK DATA
// ============================================

function getMockProfiles(): DiscoveredProfile[] {
  return [
    {
      id: `jennifer-walsh`,
      provider_id: `ACoAAMock-${Date.now()}-1`,
      name: 'Jennifer Walsh',
      headline: 'Chief Underwriting Officer at Apex Specialty',
      profile_url: 'https://linkedin.com/in/jennifer-walsh',
      company: 'Apex Specialty',
      is_connection: false,
    },
    {
      id: `david-kim`,
      provider_id: `ACoAAMock-${Date.now()}-2`,
      name: 'David Kim',
      headline: 'VP of Operations at NextGen MGA',
      profile_url: 'https://linkedin.com/in/david-kim',
      company: 'NextGen MGA',
      is_connection: false,
    },
  ];
}

