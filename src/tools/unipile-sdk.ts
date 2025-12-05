/**
 * Unipile SDK Wrapper
 * 
 * Thin wrapper around the official unipile-node-sdk.
 * Uses SDK methods where available, falls back to request.send() for search.
 * 
 * This replaces ~800 lines of hand-rolled API clients with SDK calls.
 */

import { UnipileClient } from 'unipile-node-sdk';
import { env } from '../config/env.js';

// =============================================================================
// CLIENT SINGLETON
// =============================================================================

let client: UnipileClient | null = null;

let loggedInvitationSample = false;

export function getUnipileSDK(): UnipileClient | null {
  if (!env.UNIPILE_ACCESS_TOKEN || !env.UNIPILE_DSN) {
    return null;
  }
  
  if (!client) {
    // SDK expects baseUrl without protocol prefix in some cases
    const baseUrl = env.UNIPILE_DSN.startsWith('https://')
      ? env.UNIPILE_DSN
      : `https://${env.UNIPILE_DSN}`;
    
    client = new UnipileClient(baseUrl, env.UNIPILE_ACCESS_TOKEN);
    console.log(`[UnipileSDK] Initialized with DSN: ${env.UNIPILE_DSN}`);
  }
  
  return client;
}

export function isUnipileConfigured(): boolean {
  return !!(env.UNIPILE_ACCESS_TOKEN && env.UNIPILE_DSN);
}

// =============================================================================
// ACCOUNT MANAGEMENT
// =============================================================================

let cachedLinkedinAccountId: string | null = null;
let cachedEmailAccountId: string | null = null;

/**
 * Get the active LinkedIn account ID
 */
export async function getActiveLinkedinAccountId(): Promise<string | null> {
  if (cachedLinkedinAccountId) return cachedLinkedinAccountId;
  
  const sdk = getUnipileSDK();
  if (!sdk) return null;

  try {
    const { items: accounts } = await sdk.account.getAll();
    console.log(`[UnipileSDK] Found ${accounts.length} accounts`);
    
    // Find LinkedIn account with OK status
    const linkedinAccount = accounts.find((a: any) => {
      const accountType = (a.type || a.provider || '').toString().toUpperCase();
      const sources = a.sources as Array<{status: string}> | undefined;
      const hasOkSource = sources?.some(s => s.status === 'OK');
      return accountType === 'LINKEDIN' && hasOkSource;
    });
    
    if (linkedinAccount) {
      cachedLinkedinAccountId = linkedinAccount.id;
      console.log(`[UnipileSDK] Using LinkedIn account: ${linkedinAccount.name} (${linkedinAccount.id})`);
    } else {
      // Fallback: use first non-email account
      const possibleLinkedin = accounts.find((a: any) => !a.name?.includes('@'));
      if (possibleLinkedin) {
        cachedLinkedinAccountId = possibleLinkedin.id;
        console.log(`[UnipileSDK] Using fallback account: ${possibleLinkedin.id}`);
      }
    }
    
    return cachedLinkedinAccountId;
  } catch (error) {
    console.error('[UnipileSDK] Failed to get LinkedIn account:', error);
    return null;
  }
}

/**
 * Get the active email account ID
 */
export async function getActiveEmailAccountId(): Promise<string | null> {
  if (cachedEmailAccountId) return cachedEmailAccountId;
  
  const sdk = getUnipileSDK();
  if (!sdk) return null;

  try {
    const { items: accounts } = await sdk.account.getAll();
    
    // Find email account (Google/Microsoft) with OK status
    const emailAccount = accounts.find((a: any) => {
      const accountType = (a.type || a.provider || '').toString().toUpperCase();
      const sources = a.sources as Array<{status: string}> | undefined;
      const hasOkSource = sources?.some(s => s.status === 'OK');
      const isEmailAccount = accountType.includes('GOOGLE') || 
                             accountType.includes('MICROSOFT') || 
                             accountType.includes('MAIL');
      return isEmailAccount && hasOkSource;
    });
    
    if (emailAccount) {
      cachedEmailAccountId = emailAccount.id;
      console.log(`[UnipileSDK] Using email account: ${emailAccount.name} (${emailAccount.id})`);
    }
    
    return cachedEmailAccountId;
  } catch (error) {
    console.error('[UnipileSDK] Failed to get email account:', error);
    return null;
  }
}

// Legacy alias
export const getActiveAccountId = getActiveLinkedinAccountId;

// =============================================================================
// LINKEDIN OPERATIONS (using SDK)
// =============================================================================

/**
 * Get a LinkedIn profile
 */
export async function getProfile(identifier: string) {
  const sdk = getUnipileSDK();
  const accountId = await getActiveLinkedinAccountId();
  if (!sdk || !accountId) return null;
  
  return sdk.users.getProfile({
    account_id: accountId,
    identifier,
  });
}

/**
 * Send a LinkedIn connection invitation
 */
export async function sendInvitation(providerId: string, message?: string) {
  const sdk = getUnipileSDK();
  const accountId = await getActiveLinkedinAccountId();
  if (!sdk || !accountId) {
    return { success: false, error: 'Not configured' };
  }
  
  try {
    const response = await sdk.users.sendInvitation({
      account_id: accountId,
      provider_id: providerId,
      message,
    });
    return { success: true, data: response };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[UnipileSDK] Invitation failed:', errorMsg);
    
    // Map common errors to friendly messages
    let friendlyError = 'Could not complete request';
    if (errorMsg.includes('already_invited')) {
      friendlyError = 'Connection request already pending';
    } else if (errorMsg.includes('invalid_recipient') || errorMsg.includes('cannot be reached')) {
      friendlyError = 'Profile unavailable';
    } else if (errorMsg.includes('rate_limit') || errorMsg.includes('too_many_requests')) {
      friendlyError = 'Rate limited, try again later';
    }
    
    return { success: false, error: friendlyError };
  }
}

/**
 * List pending invitations
 */
export async function listInvitations() {
  const sdk = getUnipileSDK();
  const accountId = await getActiveLinkedinAccountId();
  if (!sdk || !accountId) return [];
  
  const response = await sdk.users.getAllInvitationsSent({ account_id: accountId });
  return response.items || [];
}

export async function hasPendingInvitation(providerId: string): Promise<boolean> {
  const items = await listInvitations();
  if (!loggedInvitationSample && items.length > 0) {
    const sample = items.slice(0, 1).map((inv: any) => ({ id: inv.id, provider_id: inv.provider_id, status: inv.status }));
    console.log('[UnipileSDK] Invitation sample', sample);
    loggedInvitationSample = true;
  }
  return items.some((inv: any) => inv.provider_id === providerId && (inv.status === 'PENDING' || inv.status === 'pending'));
}

/**
 * Get posts from a profile
 */
export async function getPosts(identifier: string, limit?: number) {
  const sdk = getUnipileSDK();
  const accountId = await getActiveLinkedinAccountId();
  if (!sdk || !accountId) return [];
  
  const response = await sdk.users.getAllPosts({
    account_id: accountId,
    identifier,
    limit,
  });
  return response.items || [];
}

/**
 * Get a specific post
 */
export async function getPost(postId: string) {
  const sdk = getUnipileSDK();
  const accountId = await getActiveLinkedinAccountId();
  if (!sdk || !accountId) return null;
  
  return sdk.users.getPost({
    account_id: accountId,
    post_id: postId,
  });
}

/**
 * Comment on a post
 */
export async function commentOnPost(postId: string, text: string) {
  const sdk = getUnipileSDK();
  const accountId = await getActiveLinkedinAccountId();
  if (!sdk || !accountId) {
    return { success: false, error: 'Not configured' };
  }
  
  try {
    const response = await sdk.users.sendPostComment({
      account_id: accountId,
      post_id: postId,
      text,
    });
    return { success: true, data: response };
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    };
  }
}

/**
 * React to a post
 */
export async function reactToPost(
  postId: string, 
  reactionType: 'like' | 'celebrate' | 'support' | 'love' | 'insightful' | 'funny' = 'like'
) {
  const sdk = getUnipileSDK();
  const accountId = await getActiveLinkedinAccountId();
  if (!sdk || !accountId) {
    return { success: false, error: 'Not configured' };
  }
  
  try {
    const response = await sdk.users.sendPostReaction({
      account_id: accountId,
      post_id: postId,
      reaction_type: reactionType,
    });
    return { success: true, data: response };
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    };
  }
}

// =============================================================================
// LINKEDIN SEARCH (via direct fetch - not in SDK yet)
// =============================================================================

interface SearchParams {
  api?: 'classic' | 'sales_navigator';
  category: 'people' | 'posts' | 'companies';
  keywords: string;
  limit?: number;
  network_distance?: number[];
  location?: string[];
  sort_by?: string;
  date_posted?: 'past_day' | 'past_week' | 'past_month';
}

/**
 * Make a direct API call (for endpoints not wrapped by SDK)
 */
async function rawRequest<T>(
  method: 'GET' | 'POST' | 'DELETE' | 'PUT',
  endpoint: string,
  body?: Record<string, unknown>
): Promise<T> {
  // These are guaranteed to be set when isUnipileConfigured() returns true
  const dsn = env.UNIPILE_DSN!;
  const token = env.UNIPILE_ACCESS_TOKEN!;
  
  const baseUrl = dsn.startsWith('https://') ? dsn : `https://${dsn}`;
  
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers: {
      'X-API-KEY': token,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    ...(body && { body: JSON.stringify(body) }),
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Unipile API error (${response.status}): ${error}`);
  }
  
  return response.json() as Promise<T>;
}

/**
 * Search LinkedIn (uses raw API since SDK doesn't wrap this yet)
 */
export async function searchLinkedIn(params: SearchParams) {
  const accountId = await getActiveLinkedinAccountId();
  if (!isUnipileConfigured() || !accountId) return { items: [], total: 0 };
  
  try {
    const response = await rawRequest<{ items: any[]; paging?: { total_count?: number } }>(
      'POST',
      `/api/v1/linkedin/search?account_id=${encodeURIComponent(accountId)}`,
      {
        api: params.api || 'classic',
        category: params.category,
        keywords: params.keywords,
        limit: params.limit || 10,
        ...(params.network_distance && { network_distance: params.network_distance }),
        ...(params.location && { location: params.location }),
        ...(params.sort_by && { sort_by: params.sort_by }),
        ...(params.date_posted && { date_posted: params.date_posted }),
      }
    );
    
    return {
      items: response.items || [],
      total: response.paging?.total_count || response.items?.length || 0,
    };
  } catch (error) {
    console.error('[UnipileSDK] Search failed:', error);
    return { items: [], total: 0 };
  }
}

/**
 * Get LinkedIn location IDs for search filtering
 */
export async function getLocationIds(location: string): Promise<string[]> {
  const accountId = await getActiveLinkedinAccountId();
  if (!isUnipileConfigured() || !accountId) return [];
  
  try {
    const response = await rawRequest<{ items: Array<{ id: string | number; title: string }> }>(
      'GET',
      `/api/v1/linkedin/search/parameters?account_id=${encodeURIComponent(accountId)}&type=LOCATION&keywords=${encodeURIComponent(location)}&limit=5`
    );
    return (response.items || []).map(item => String(item.id));
  } catch (error) {
    console.error('[UnipileSDK] Failed to get location IDs:', error);
    return [];
  }
}

// =============================================================================
// MESSAGING OPERATIONS (using SDK)
// =============================================================================

/**
 * List chats
 */
export async function listChats(limit?: number) {
  const sdk = getUnipileSDK();
  const accountId = await getActiveLinkedinAccountId();
  if (!sdk || !accountId) return [];
  
  const response = await sdk.messaging.getAllChats({
    account_id: accountId,
    limit,
  });
  return response.items || [];
}

/**
 * Get messages from a chat
 */
export async function getChatMessages(chatId: string, limit?: number) {
  const sdk = getUnipileSDK();
  if (!sdk) return [];
  
  const response = await sdk.messaging.getAllMessagesFromChat({
    chat_id: chatId,
    limit,
  });
  return response.items || [];
}

/**
 * Send a message to an existing chat
 */
export async function sendMessage(chatId: string, text: string) {
  const sdk = getUnipileSDK();
  if (!sdk) {
    return { success: false, error: 'Not configured' };
  }
  
  try {
    const response = await sdk.messaging.sendMessage({
      chat_id: chatId,
      text,
    });
    return { success: true, data: response };
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    };
  }
}

/**
 * Start a new chat (DM)
 */
export async function startNewChat(attendeeProviderId: string, text: string) {
  const sdk = getUnipileSDK();
  const accountId = await getActiveLinkedinAccountId();
  if (!sdk || !accountId) {
    return { success: false, error: 'Not configured' };
  }
  
  try {
    const response = await sdk.messaging.startNewChat({
      account_id: accountId,
      attendees_ids: [attendeeProviderId],
      text,
    });
    return { success: true, data: response };
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    };
  }
}

// =============================================================================
// EMAIL OPERATIONS (using SDK)
// =============================================================================

/**
 * Get emails
 */
export async function getEmails(params: {
  folder?: string;
  from?: string;
  to?: string;
  after?: string;
  before?: string;
  limit?: number;
} = {}): Promise<any[]> {
  const sdk = getUnipileSDK();
  const accountId = await getActiveEmailAccountId();
  if (!sdk || !accountId) return [];
  
  const response = await sdk.email.getAll({
    account_id: accountId,
    ...params,
  });
  return (response as any).items || [];
}

/**
 * Get a specific email
 */
export async function getEmail(emailId: string): Promise<any | null> {
  const sdk = getUnipileSDK();
  if (!sdk) return null;
  
  return sdk.email.getOne(emailId);
}

/**
 * Send an email
 */
export async function sendEmail(params: {
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
}) {
  const sdk = getUnipileSDK();
  const accountId = await getActiveEmailAccountId();
  if (!sdk || !accountId) {
    return { success: false, error: 'Email not configured' };
  }
  
  try {
    const response = await sdk.email.send({
      account_id: accountId,
      to: params.to.map(email => ({ identifier: email })),
      subject: params.subject,
      body: params.body,
      ...(params.cc && { cc: params.cc.map(email => ({ identifier: email })) }),
      ...(params.bcc && { bcc: params.bcc.map(email => ({ identifier: email })) }),
      ...(params.replyTo && { reply_to: params.replyTo }),
    });
    return { success: true, data: response };
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    };
  }
}


/**
 * Create an email draft (via raw API call)
 */
export async function createEmailDraft(params: {
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
}) {
  const sdk = getUnipileSDK();
  const accountId = await getActiveEmailAccountId();
  if (!sdk || !accountId) {
    return { success: false, error: 'Email not configured' };
  }

  try {
    const response = await rawRequest<any>(
      'POST',
      '/api/v1/drafts',
      {
        account_id: accountId,
        to: params.to.map(email => ({ identifier: email })),
        subject: params.subject,
        body: params.body,
        ...(params.cc && { cc: params.cc.map(email => ({ identifier: email })) }),
        ...(params.bcc && { bcc: params.bcc.map(email => ({ identifier: email })) }),
        ...(params.replyTo && { reply_to: params.replyTo }),
      }
    );
    return { success: true, data: response };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Get email folders
 */
export async function getEmailFolders(): Promise<any[]> {
  const sdk = getUnipileSDK();
  const accountId = await getActiveEmailAccountId();
  if (!sdk || !accountId) return [];
  
  const response = await sdk.email.getAllFolders({ account_id: accountId });
  return (response as any).items || [];
}

/**
 * Update email (move to folder, mark read/unread)
 */
export async function updateEmail(emailId: string, updates: { folders?: string[]; unread?: boolean }) {
  const sdk = getUnipileSDK();
  if (!sdk) {
    return { success: false, error: 'Not configured' };
  }
  
  try {
    const response = await sdk.email.update({
      email_id: emailId,
      ...updates,
    });
    return { success: true, data: response };
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    };
  }
}

// =============================================================================
// CALENDAR OPERATIONS (via raw request - limited SDK support)
// =============================================================================

/**
 * Get calendars
 */
export async function getCalendars(): Promise<any[]> {
  const accountId = await getActiveEmailAccountId();
  if (!isUnipileConfigured() || !accountId) return [];
  
  try {
    const response = await rawRequest<{ data: any[] }>(
      'GET',
      `/api/v1/calendars?account_id=${encodeURIComponent(accountId)}`
    );
    return response.data || [];
  } catch (error) {
    console.error('[UnipileSDK] Get calendars failed:', error);
    return [];
  }
}

/**
 * Get calendar events
 */
export async function getCalendarEvents(params: {
  calendarId?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
}): Promise<any[]> {
  const accountId = await getActiveEmailAccountId();
  if (!isUnipileConfigured() || !accountId) return [];
  
  try {
    // Get calendar ID if not provided
    let calendarId = params.calendarId;
    if (!calendarId) {
      const calendars = await getCalendars();
      const primary = calendars.find((c: any) => c.is_primary) || calendars[0];
      if (!primary?.id) return [];
      calendarId = primary.id as string;
    }
    
    const queryParams = new URLSearchParams({ account_id: accountId });
    if (params.startDate) queryParams.set('start', params.startDate);
    if (params.endDate) queryParams.set('end', params.endDate);
    if (params.limit) queryParams.set('limit', String(params.limit));
    
    const response = await rawRequest<{ data: any[] }>(
      'GET',
      `/api/v1/calendars/${encodeURIComponent(calendarId)}/events?${queryParams}`
    );
    return response.data || [];
  } catch (error) {
    console.error('[UnipileSDK] Get calendar events failed:', error);
    return [];
  }
}

// =============================================================================
// WEBHOOK OPERATIONS (via raw request)
// =============================================================================

/**
 * Create a webhook
 */
export async function createWebhook(params: {
  source: 'users' | 'messaging' | 'email' | 'email_tracking' | 'account_status' | 'calendar_event';
  requestUrl: string;
  name?: string;
}) {
  if (!isUnipileConfigured()) {
    return { success: false, error: 'Not configured' };
  }
  
  try {
    const response = await rawRequest<any>(
      'POST',
      '/api/v1/webhooks',
      {
        source: params.source,
        request_url: params.requestUrl,
        name: params.name,
        headers: [{ key: 'Content-Type', value: 'application/json' }],
      }
    );
    return { success: true, data: response };
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    };
  }
}

/**
 * List webhooks
 */
export async function listWebhooks(): Promise<any[]> {
  if (!isUnipileConfigured()) return [];
  
  try {
    const response = await rawRequest<{ items: any[] }>(
      'GET',
      '/api/v1/webhooks'
    );
    return response.items || [];
  } catch (error) {
    console.error('[UnipileSDK] List webhooks failed:', error);
    return [];
  }
}

/**
 * Delete a webhook
 */
export async function deleteWebhook(webhookId: string) {
  if (!isUnipileConfigured()) {
    return { success: false, error: 'Not configured' };
  }
  
  try {
    await rawRequest<void>(
      'DELETE',
      `/api/v1/webhooks/${webhookId}`
    );
    return { success: true };
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    };
  }
}

// =============================================================================
// UTILITY HELPERS (kept from old implementation)
// =============================================================================

type CalendarDateTime = string | { date_time: string; timezone?: string } | { date: string };

/**
 * Parse a calendar date/time value to a Date object
 */
export function parseCalendarDateTime(dt: CalendarDateTime | undefined): Date | null {
  if (!dt) return null;
  
  if (typeof dt === 'string') {
    return new Date(dt);
  }
  
  if ('date_time' in dt) {
    return new Date(dt.date_time);
  }
  
  if ('date' in dt) {
    return new Date(dt.date);
  }
  
  return null;
}

/**
 * Get the title from a calendar event (handles different field names)
 */
export function getEventTitle(event: { title?: string; summary?: string }): string {
  return event.title || event.summary || 'Untitled';
}

/**
 * Get start time from a calendar event
 */
export function getEventStartTime(event: { start_time?: CalendarDateTime; start?: CalendarDateTime }): Date | null {
  return parseCalendarDateTime(event.start_time || event.start);
}

/**
 * Get end time from a calendar event
 */
export function getEventEndTime(event: { end_time?: CalendarDateTime; end?: CalendarDateTime }): Date | null {
  return parseCalendarDateTime(event.end_time || event.end);
}

