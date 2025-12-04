import { env } from '../config/env.js';

/**
 * Unipile API Client for LinkedIn automation
 * Documentation: https://developer.unipile.com/docs
 * 
 * Unipile provides comprehensive LinkedIn integration:
 * - Send messages (DMs)
 * - Send connection invitations
 * - Get user profiles
 * - Posts and comments
 * - Webhooks for real-time updates
 */
export class UnipileClient {
  private accessToken: string;
  private dsn: string;

  constructor(accessToken: string, dsn: string) {
    this.accessToken = accessToken;
    this.dsn = dsn;
  }

  /**
   * Get the base URL for API requests
   */
  private get baseUrl(): string {
    return `https://${this.dsn}`;
  }

  /**
   * Make authenticated request to Unipile API
   */
  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    
    console.log(`[Unipile] ${options.method || 'GET'} ${endpoint}`);
    
    const response = await fetch(url, {
      ...options,
      headers: {
        'X-API-KEY': this.accessToken,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Unipile API error (${response.status}): ${error}`);
    }

    return response.json() as Promise<T>;
  }

  // ============================================
  // ACCOUNTS
  // ============================================

  /**
   * List all connected accounts
   */
  async listAccounts(): Promise<UnipileAccount[]> {
    const response = await this.request<{ items: UnipileAccount[] }>('/api/v1/accounts');
    return response.items;
  }

  /**
   * Get a specific account
   */
  async getAccount(accountId: string): Promise<UnipileAccount> {
    return this.request<UnipileAccount>(`/api/v1/accounts/${accountId}`);
  }

  // ============================================
  // USERS / PROFILES
  // ============================================

  /**
   * Get user profile by ID or URL
   */
  async getProfile(params: {
    account_id: string;
    identifier: string; // LinkedIn profile URL or ID
  }): Promise<UnipileProfile> {
    const query = new URLSearchParams({
      account_id: params.account_id,
      identifier: params.identifier,
    });
    return this.request<UnipileProfile>(`/api/v1/users/provider_id?${query}`);
  }

  /**
   * Search for users on LinkedIn using LinkedIn Search API
   * Docs: https://developer.unipile.com/docs/linkedin-search
   */
  async searchUsers(params: {
    account_id: string;
    query: string;
    limit?: number;
    locations?: string[];
    excludeConnections?: boolean;
  }): Promise<UnipileSearchResult> {
    // Build search params
    const searchParams: Record<string, unknown> = {
      api: 'classic',
      category: 'people',
      keywords: params.query,
      limit: params.limit || 10,
    };
    
    // Filter to 2nd and 3rd degree connections only (exclude 1st degree = already connected)
    // network_distance: 1 = 1st degree, 2 = 2nd degree, 3 = 3rd+
    if (params.excludeConnections !== false) {
      // Only show 2nd and 3rd degree connections by default
      searchParams.network_distance = [2, 3];
      console.log(`[Unipile] Filtering to 2nd/3rd degree connections only`);
    }
    
    // Get location IDs if locations specified (must be string array of numeric IDs)
    if (params.locations && params.locations.length > 0) {
      const locationIds: string[] = [];
      for (const loc of params.locations) {
        const ids = await this.getLocationIds({ account_id: params.account_id, location: loc });
        locationIds.push(...ids);
      }
      if (locationIds.length > 0) {
        searchParams.location = locationIds;
        console.log(`[Unipile] Using location IDs: ${locationIds.join(', ')}`);
      }
    }
    
    const response = await this.request<{ items: Record<string, unknown>[]; paging?: { total_count?: number } }>(`/api/v1/linkedin/search?account_id=${encodeURIComponent(params.account_id)}`, {
      method: 'POST',
      body: JSON.stringify(searchParams),
    });
    
    return {
      items: (response.items || []).map(item => this.mapLinkedInSearchPersonToProfile(item)),
      total: response.paging?.total_count || response.items?.length || 0,
    };
  }
  
  /**
   * Map LinkedIn search person result to our UnipileProfile format
   * 
   * IMPORTANT ID distinction:
   * - public_identifier: The username part of LinkedIn URL (e.g., "john-doe-123") - stable for dedup
   * - provider_id: The internal LinkedIn ID (e.g., "ACoAAA...") - REQUIRED for invitations
   * 
   * LinkedIn search API returns provider_id in the 'id' field (starting with ACoAAA)
   */
  private mapLinkedInSearchPersonToProfile(item: Record<string, unknown>): UnipileProfile {
    // public_identifier is the stable LinkedIn username (e.g., "john-doe-123")
    const publicId = item.public_identifier as string;
    
    // The 'id' field contains the internal LinkedIn provider_id (e.g., "ACoAAA...")
    // This is REQUIRED for sending invitations
    const internalId = item.id as string;
    
    // network_distance can be string like "DISTANCE_2" or number
    const networkDistanceRaw = item.network_distance;
    const isConnection = networkDistanceRaw === 1 || networkDistanceRaw === 'DISTANCE_1';
    
    // Get headline and company
    const headline = (item.headline as string) || (item.title as string) || '';
    const company = (item.current_company as string) || (item.company_name as string) || '';
    
    console.log(`[Unipile] Profile: ${item.name} | id: ${internalId} | public_id: ${publicId} | headline: "${headline.slice(0, 50)}" | company: "${company}"`);
    
    return {
      // Use public_identifier for deduplication (stable across searches)
      id: publicId || internalId || '',
      // CRITICAL: provider_id must be the internal LinkedIn ID (ACoAAA...) for invitations
      provider_id: internalId || '',
      public_identifier: publicId,
      name: (item.name as string) || '',
      first_name: (item.first_name as string),
      last_name: (item.last_name as string),
      headline,
      profile_url: publicId ? `https://linkedin.com/in/${publicId}` : (item.profile_url as string),
      location: (item.location as string),
      company,
      connections_count: item.connections_count as number,
      is_connection: isConnection,
    };
  }

  // ============================================
  // INVITATIONS (Connection Requests)
  // ============================================

  /**
   * Send a connection invitation
   */
  async sendInvitation(params: {
    account_id: string;
    provider_id: string; // LinkedIn user ID
    message?: string;
  }): Promise<UnipileInvitationResponse> {
    try {
      const response = await this.request<Record<string, unknown>>('/api/v1/users/invite', {
        method: 'POST',
        body: JSON.stringify({
          account_id: params.account_id,
          provider_id: params.provider_id,
          message: params.message,
        }),
      });
      
      // Unipile returns invitation details on success, not { success: true }
      // If we got here without throwing, it was successful
      console.log('[Unipile] Invitation response:', JSON.stringify(response));
      
      return {
        success: true,
        invitation_id: (response.id as string) || (response.invitation_id as string),
      };
    } catch (error) {
      const rawError = error instanceof Error ? error.message : 'Unknown error';
      console.error('[Unipile] Invitation failed:', rawError);
      
      // Status messages (not failures - just what happened)
      let friendlyError = 'Could not complete request';
      if (rawError.includes('already_invited_recently')) {
        friendlyError = 'Connection request already pending';
      } else if (rawError.includes('invalid_recipient') || rawError.includes('cannot be reached')) {
        friendlyError = 'Profile unavailable';
      } else if (rawError.includes('rate_limit') || rawError.includes('too_many_requests')) {
        friendlyError = 'Rate limited, try again later';
      } else if (rawError.includes('invalid_parameters')) {
        friendlyError = 'Could not resolve profile';
      }
      
      return {
        success: false,
        error: friendlyError,
      };
    }
  }

  /**
   * List pending invitations
   */
  async listInvitations(accountId: string): Promise<UnipileInvitation[]> {
    const response = await this.request<{ items: UnipileInvitation[] }>(
      `/api/v1/users/invitations?account_id=${encodeURIComponent(accountId)}`
    );
    return response.items;
  }

  // ============================================
  // CHATS / MESSAGES
  // ============================================

  /**
   * List chats for an account
   */
  async listChats(params: {
    account_id: string;
    limit?: number;
  }): Promise<UnipileChat[]> {
    const query = new URLSearchParams({
      account_id: params.account_id,
      ...(params.limit && { limit: params.limit.toString() }),
    });
    const response = await this.request<{ items: UnipileChat[] }>(`/api/v1/chats?${query}`);
    return response.items;
  }

  /**
   * Get messages in a chat
   */
  async getChatMessages(params: {
    chat_id: string;
    limit?: number;
  }): Promise<UnipileMessage[]> {
    const query = params.limit ? `?limit=${params.limit}` : '';
    const response = await this.request<{ items: UnipileMessage[] }>(
      `/api/v1/chats/${params.chat_id}/messages${query}`
    );
    return response.items;
  }

  /**
   * Send a message in an existing chat
   */
  async sendMessage(params: {
    chat_id: string;
    text: string;
  }): Promise<UnipileMessageResponse> {
    return this.request<UnipileMessageResponse>(`/api/v1/chats/${params.chat_id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text: params.text }),
    });
  }

  /**
   * Start a new chat / send DM to a user
   */
  async sendDirectMessage(params: {
    account_id: string;
    attendee_provider_id: string; // LinkedIn user ID
    text: string;
  }): Promise<UnipileMessageResponse> {
    return this.request<UnipileMessageResponse>('/api/v1/chats', {
      method: 'POST',
      body: JSON.stringify({
        account_id: params.account_id,
        attendees_ids: [params.attendee_provider_id],
        text: params.text,
      }),
    });
  }

  // ============================================
  // POSTS & COMMENTS
  // ============================================

  /**
   * Get posts from a user or company
   */
  async getPosts(params: {
    account_id: string;
    identifier: string; // Profile URL or ID
    limit?: number;
  }): Promise<UnipilePost[]> {
    const query = new URLSearchParams({
      account_id: params.account_id,
      identifier: params.identifier,
      ...(params.limit && { limit: params.limit.toString() }),
    });
    const response = await this.request<{ items: UnipilePost[] }>(`/api/v1/posts?${query}`);
    return response.items;
  }

  /**
   * Get a specific post
   */
  async getPost(params: {
    account_id: string;
    post_id: string;
  }): Promise<UnipilePost> {
    return this.request<UnipilePost>(
      `/api/v1/posts/${encodeURIComponent(params.post_id)}?account_id=${encodeURIComponent(params.account_id)}`
    );
  }

  /**
   * Comment on a post
   */
  async commentOnPost(params: {
    account_id: string;
    post_id: string;
    text: string;
  }): Promise<UnipileCommentResponse> {
    // post_id should be social_id (e.g., urn:li:activity:xxx) - needs URL encoding
    return this.request<UnipileCommentResponse>(`/api/v1/posts/${encodeURIComponent(params.post_id)}/comments`, {
      method: 'POST',
      body: JSON.stringify({
        account_id: params.account_id,
        text: params.text,
      }),
    });
  }

  /**
   * React/Like a post
   */
  async reactToPost(params: {
    account_id: string;
    post_id: string;
    reaction_type?: 'LIKE' | 'CELEBRATE' | 'SUPPORT' | 'LOVE' | 'INSIGHTFUL' | 'FUNNY';
  }): Promise<UnipileReactionResponse> {
    // post_id should be social_id (e.g., urn:li:activity:xxx) - needs URL encoding
    return this.request<UnipileReactionResponse>(`/api/v1/posts/${encodeURIComponent(params.post_id)}/reactions`, {
      method: 'POST',
      body: JSON.stringify({
        account_id: params.account_id,
        reaction_type: params.reaction_type || 'LIKE',
      }),
    });
  }

  // ============================================
  // EMAIL (Gmail, Microsoft)
  // ============================================

  /**
   * List emails from an account
   * Docs: https://developer.unipile.com/docs/retrieving-emails
   */
  async getEmails(params: {
    account_id: string;
    limit?: number;
    folder?: string; // e.g., 'INBOX', 'SENT', or custom label name
    unread_only?: boolean;
  }): Promise<UnipileEmail[]> {
    const query = new URLSearchParams({
      account_id: params.account_id,
      ...(params.limit && { limit: params.limit.toString() }),
      ...(params.folder && { folder: params.folder }),
      ...(params.unread_only && { unread: 'true' }),
    });
    const response = await this.request<{ items: UnipileEmail[] }>(`/api/v1/emails?${query}`);
    return response.items || [];
  }

  /**
   * Get a specific email by ID
   */
  async getEmail(params: {
    account_id: string;
    email_id: string;
  }): Promise<UnipileEmail> {
    return this.request<UnipileEmail>(
      `/api/v1/emails/${params.email_id}?account_id=${encodeURIComponent(params.account_id)}`
    );
  }

  /**
   * Send an email
   * Docs: https://developer.unipile.com/docs/send-email
   */
  async sendEmail(params: {
    account_id: string;
    to: string[];
    subject: string;
    body: string;
    cc?: string[];
    bcc?: string[];
    reply_to_email_id?: string; // For replies
  }): Promise<UnipileEmailResponse> {
    return this.request<UnipileEmailResponse>('/api/v1/emails', {
      method: 'POST',
      body: JSON.stringify({
        account_id: params.account_id,
        to: params.to,
        subject: params.subject,
        body: params.body,
        body_type: 'text/html',
        ...(params.cc && { cc: params.cc }),
        ...(params.bcc && { bcc: params.bcc }),
        ...(params.reply_to_email_id && { reply_to_email_id: params.reply_to_email_id }),
      }),
    });
  }

  /**
   * Create an email draft
   * Docs: https://developer.unipile.com/reference/draftscontroller_createdraft
   */
  async createEmailDraft(params: {
    account_id: string;
    to: string[];
    subject: string;
    body: string;
    cc?: string[];
    bcc?: string[];
  }): Promise<UnipileEmailResponse> {
    // Format recipients as objects with identifier field
    const formatRecipients = (emails: string[]) => 
      emails.map(email => ({ identifier: email }));

    return this.request<UnipileEmailResponse>('/api/v1/drafts', {
      method: 'POST',
      body: JSON.stringify({
        account_id: params.account_id,
        to: formatRecipients(params.to),
        subject: params.subject,
        body: params.body,
        body_type: 'text/html',
        ...(params.cc && { cc: formatRecipients(params.cc) }),
        ...(params.bcc && { bcc: formatRecipients(params.bcc) }),
      }),
    });
  }

  /**
   * Get email folders/labels
   */
  async getEmailFolders(accountId: string): Promise<UnipileEmailFolder[]> {
    const response = await this.request<{ items: UnipileEmailFolder[] }>(
      `/api/v1/emails/folders?account_id=${encodeURIComponent(accountId)}`
    );
    return response.items || [];
  }

  /**
   * Modify email labels (add/remove)
   * Used to move emails to "Sales Leads" folder
   */
  async modifyEmailLabels(params: {
    account_id: string;
    email_id: string;
    add_labels?: string[];
    remove_labels?: string[];
  }): Promise<{ success: boolean; error?: string }> {
    try {
      await this.request(`/api/v1/emails/${params.email_id}/labels`, {
        method: 'PATCH',
        body: JSON.stringify({
          account_id: params.account_id,
          add_labels: params.add_labels || [],
          remove_labels: params.remove_labels || [],
        }),
      });
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get all emails in a thread
   * Used to check if recipient has responded
   */
  async getEmailThread(params: {
    account_id: string;
    thread_id: string;
  }): Promise<UnipileEmail[]> {
    const query = new URLSearchParams({
      account_id: params.account_id,
      thread_id: params.thread_id,
    });
    const response = await this.request<{ items: UnipileEmail[] }>(
      `/api/v1/emails?${query}`
    );
    return response.items || [];
  }

  /**
   * Search emails by sender
   * Used to find meeting notes from assistant@day.ai
   */
  async searchEmailsBySender(params: {
    account_id: string;
    sender: string;
    folder?: string;
    since?: string; // ISO date
    limit?: number;
  }): Promise<UnipileEmail[]> {
    const query = new URLSearchParams({
      account_id: params.account_id,
      from: params.sender,
      ...(params.folder && { folder: params.folder }),
      ...(params.since && { since: params.since }),
      ...(params.limit && { limit: params.limit.toString() }),
    });
    const response = await this.request<{ items: UnipileEmail[] }>(
      `/api/v1/emails?${query}`
    );
    return response.items || [];
  }

  /**
   * Search emails sent TO a recipient
   * Used to check if we've already emailed someone
   */
  async searchEmailsToRecipient(params: {
    account_id: string;
    recipient: string;
    folder?: string; // e.g., 'SENT'
    since?: string; // ISO date
    limit?: number;
  }): Promise<UnipileEmail[]> {
    const query = new URLSearchParams({
      account_id: params.account_id,
      to: params.recipient,
      ...(params.folder && { folder: params.folder }),
      ...(params.since && { since: params.since }),
      ...(params.limit && { limit: params.limit.toString() }),
    });
    const response = await this.request<{ items: UnipileEmail[] }>(
      `/api/v1/emails?${query}`
    );
    return response.items || [];
  }

  /**
   * Get email history with a contact (both sent and received)
   * Returns emails sorted by date (most recent first)
   */
  async getEmailHistoryWithContact(params: {
    account_id: string;
    contactEmail: string;
    limit?: number;
  }): Promise<UnipileEmail[]> {
    const limit = params.limit || 20;
    
    // Get emails FROM them
    const fromContact = await this.searchEmailsBySender({
      account_id: params.account_id,
      sender: params.contactEmail,
      limit,
    });
    
    // Get emails TO them
    const toContact = await this.searchEmailsToRecipient({
      account_id: params.account_id,
      recipient: params.contactEmail,
      limit,
    });
    
    // Combine and sort by date (most recent first)
    const allEmails = [...fromContact, ...toContact];
    allEmails.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    
    // Dedupe by ID (in case same email appears in both)
    const seen = new Set<string>();
    return allEmails.filter(email => {
      if (seen.has(email.id)) return false;
      seen.add(email.id);
      return true;
    }).slice(0, limit);
  }

  // ============================================
  // CALENDAR
  // ============================================

  /**
   * Get calendar events
   */
  /**
   * Get calendars for an account
   */
  async getCalendars(params: {
    account_id: string;
    limit?: number;
  }): Promise<Array<{ id: string; name: string; is_primary: boolean }>> {
    const query = new URLSearchParams({
      account_id: params.account_id,
      ...(params.limit && { limit: params.limit.toString() }),
    });
    const response = await this.request<{ data: Array<{ id: string; name: string; is_primary: boolean }> }>(
      `/api/v1/calendars?${query}`
    );
    return response.data || [];
  }

  /**
   * Get calendar events
   * Endpoint: GET /api/v1/calendars/{calendar_id}/events
   */
  async getCalendarEvents(params: {
    account_id: string;
    calendar_id?: string; // If not provided, will fetch primary calendar first
    start_date?: string; // ISO date
    end_date?: string;
    limit?: number;
  }): Promise<UnipileCalendarEvent[]> {
    // Get calendar ID - use provided or fetch primary
    let calendarId = params.calendar_id;
    if (!calendarId) {
      const calendars = await this.getCalendars({ account_id: params.account_id });
      const primary = calendars.find(c => c.is_primary) || calendars[0];
      if (!primary) {
        console.log('[Unipile] No calendars found for account');
        return [];
      }
      calendarId = primary.id;
    }

    const query = new URLSearchParams({
      account_id: params.account_id,
      ...(params.start_date && { start: params.start_date }),
      ...(params.end_date && { end: params.end_date }),
      ...(params.limit && { limit: params.limit.toString() }),
    });
    
    const response = await this.request<{ data: UnipileCalendarEvent[] }>(
      `/api/v1/calendars/${encodeURIComponent(calendarId)}/events?${query}`
    );
    return response.data || [];
  }

  /**
   * Get a specific calendar event
   */
  async getCalendarEvent(params: {
    account_id: string;
    event_id: string;
  }): Promise<UnipileCalendarEvent> {
    return this.request<UnipileCalendarEvent>(
      `/api/v1/events/${params.event_id}?account_id=${encodeURIComponent(params.account_id)}`
    );
  }

  // ============================================
  // LOCATION IDS
  // ============================================

  /**
   * Get location IDs for a given location name
   * Docs: https://developer.unipile.com/docs/linkedin-search
   */
  async getLocationIds(params: {
    account_id: string;
    location: string;
  }): Promise<string[]> {
    try {
      const response = await this.request<{ items: Array<{ id: string | number; title: string }> }>(
        `/api/v1/linkedin/search/parameters?account_id=${encodeURIComponent(params.account_id)}&type=LOCATION&keywords=${encodeURIComponent(params.location)}&limit=5`
      );
      // API expects string IDs that are numeric
      return (response.items || []).map(item => String(item.id));
    } catch (error) {
      console.error('[Unipile] Failed to get location IDs:', error);
      return [];
    }
  }

  /**
   * Search posts by keywords using LinkedIn Search API
   * Docs: https://developer.unipile.com/docs/linkedin-search
   */
  async searchPosts(params: {
    account_id: string;
    keywords: string;
    limit?: number;
    locations?: string[];
    datePosted?: 'past_day' | 'past_week' | 'past_month';
  }): Promise<UnipilePost[]> {
    // Build search params
    const searchParams: Record<string, unknown> = {
      api: 'classic',
      category: 'posts',
      keywords: params.keywords,
      sort_by: 'date',
      date_posted: params.datePosted || 'past_week', // Default to past week for relevance
      limit: params.limit || 10,
    };
    
    // Get location IDs if locations specified (must be string array of numeric IDs)
    if (params.locations && params.locations.length > 0) {
      const locationIds: string[] = [];
      for (const loc of params.locations) {
        const ids = await this.getLocationIds({ account_id: params.account_id, location: loc });
        locationIds.push(...ids);
      }
      if (locationIds.length > 0) {
        searchParams.location = locationIds;
        console.log(`[Unipile] Using location IDs for posts: ${locationIds.join(', ')}`);
      }
    }
    
    const response = await this.request<{ items: Record<string, unknown>[]; object: string }>(`/api/v1/linkedin/search?account_id=${encodeURIComponent(params.account_id)}`, {
      method: 'POST',
      body: JSON.stringify(searchParams),
    });
    
    // Map the LinkedIn search response to our post format
    return (response.items || []).map(item => this.mapLinkedInSearchPostToPost(item));
  }
  
  /**
   * Map LinkedIn search post result to our UnipilePost format
   */
  private mapLinkedInSearchPostToPost(item: Record<string, unknown>): UnipilePost {
    const author = item.author as Record<string, unknown> || {};
    return {
      id: (item.id as string) || '',
      provider_id: (item.social_id as string) || (item.id as string) || '',
      author: {
        id: (author.public_identifier as string) || '',
        name: (author.name as string) || 'Unknown',
        headline: (author.headline as string) || '',
        profile_url: author.public_identifier ? `https://linkedin.com/in/${author.public_identifier}` : undefined,
      },
      text: (item.text as string) || '',
      url: (item.share_url as string) || '',
      likes_count: (item.reaction_counter as number) || 0,
      comments_count: (item.comment_counter as number) || 0,
      reposts_count: (item.repost_counter as number) || 0,
      created_at: (item.date as string) || (item.parsed_datetime as string) || '',
    };
  }

  // ============================================
  // WEBHOOKS
  // ============================================

  /**
   * Create a webhook to receive real-time events
   * Docs: https://developer.unipile.com/docs/webhooks-overview
   */
  async createWebhook(params: {
    source: 'users' | 'messaging' | 'email' | 'email_tracking' | 'account_status' | 'calendar_event';
    request_url: string;
    name?: string;
    headers?: Array<{ key: string; value: string }>;
  }): Promise<UnipileWebhook> {
    return this.request<UnipileWebhook>('/api/v1/webhooks', {
      method: 'POST',
      body: JSON.stringify({
        source: params.source,
        request_url: params.request_url,
        name: params.name,
        headers: params.headers || [
          { key: 'Content-Type', value: 'application/json' },
        ],
      }),
    });
  }

  /**
   * List all registered webhooks
   */
  async listWebhooks(): Promise<UnipileWebhook[]> {
    const response = await this.request<{ items: UnipileWebhook[] }>('/api/v1/webhooks');
    return response.items || [];
  }

  /**
   * Delete a webhook
   */
  async deleteWebhook(webhookId: string): Promise<void> {
    await this.request<void>(`/api/v1/webhooks/${webhookId}`, {
      method: 'DELETE',
    });
  }
}

// ============================================
// TYPE DEFINITIONS
// ============================================

export interface UnipileAccount {
  id: string;
  provider: string;
  name: string;
  status: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECT_REQUIRED';
  created_at: string;
}

export interface UnipileProfile {
  id: string;
  provider_id: string; // Internal LinkedIn ID (ACoAAA...) - REQUIRED for invitations
  public_identifier?: string; // LinkedIn username (john-doe) - for profile URLs
  name: string;
  first_name?: string;
  last_name?: string;
  headline?: string;
  profile_url?: string;
  profile_picture_url?: string;
  location?: string;
  company?: string;
  connections_count?: number;
  is_connection?: boolean;
  about?: string;
}

export interface UnipileSearchResult {
  items: UnipileProfile[];
  total: number;
  cursor?: string;
}

export interface UnipileInvitation {
  id: string;
  provider_id: string;
  name: string;
  headline?: string;
  status: 'PENDING' | 'ACCEPTED' | 'IGNORED';
  sent_at: string;
}

export interface UnipileInvitationResponse {
  success: boolean;
  invitation_id?: string;
  error?: string;
}

export interface UnipileChat {
  id: string;
  provider_id: string;
  name: string;
  attendees: Array<{
    id: string;
    provider_id: string;
    name: string;
  }>;
  last_message?: {
    text: string;
    timestamp: string;
  };
  unread_count: number;
}

export interface UnipileMessage {
  id: string;
  text: string;
  sender_id: string;
  sender_name: string;
  timestamp: string;
  is_outbound: boolean;
  hidden?: boolean;
  deleted?: boolean;
  seen?: boolean;
  delivered?: boolean;
}

export interface UnipileMessageResponse {
  success: boolean;
  message_id?: string;
  chat_id?: string;
  error?: string;
}

export interface UnipilePost {
  id: string;
  provider_id: string;
  author: {
    id: string;
    name: string;
    headline?: string;
    profile_url?: string;
    profile_picture_url?: string;
  };
  text: string;
  url?: string;
  likes_count: number;
  comments_count: number;
  reposts_count: number;
  created_at: string;
  media?: Array<{
    type: 'image' | 'video' | 'document';
    url: string;
  }>;
}

export interface UnipileCommentResponse {
  success: boolean;
  comment_id?: string;
  error?: string;
}

export interface UnipileReactionResponse {
  success: boolean;
  error?: string;
}

// ============================================
// EMAIL TYPES
// ============================================

export interface UnipileEmail {
  id: string;
  provider_id: string;
  account_id: string;
  subject: string;
  body?: string;
  body_plain?: string;
  from: {
    email: string;
    name?: string;
  };
  to: Array<{
    email: string;
    name?: string;
  }>;
  cc?: Array<{
    email: string;
    name?: string;
  }>;
  date: string;
  folder?: string;
  labels?: string[];
  is_read: boolean;
  has_attachments: boolean;
  attachments?: Array<{
    id: string;
    filename: string;
    content_type: string;
    size: number;
  }>;
  thread_id?: string;
}

export interface UnipileEmailResponse {
  success: boolean;
  email_id?: string;
  thread_id?: string;
  error?: string;
}

export interface UnipileEmailFolder {
  id: string;
  name: string;
  type: 'inbox' | 'sent' | 'drafts' | 'trash' | 'spam' | 'custom';
  unread_count?: number;
  total_count?: number;
}

// ============================================
// CALENDAR TYPES
// ============================================

// Calendar event time can be a string or an object with date_time and time_zone
export type CalendarDateTime = string | { date_time: string; time_zone?: string } | { date: string };

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
export function getEventTitle(event: UnipileCalendarEvent): string {
  return event.title || event.summary || 'Untitled';
}

/**
 * Get start time from a calendar event
 */
export function getEventStartTime(event: UnipileCalendarEvent): Date | null {
  return parseCalendarDateTime(event.start_time || event.start);
}

/**
 * Get end time from a calendar event
 */
export function getEventEndTime(event: UnipileCalendarEvent): Date | null {
  return parseCalendarDateTime(event.end_time || event.end);
}

export interface UnipileCalendarEvent {
  id: string;
  provider_id?: string;
  account_id?: string;
  title?: string;
  summary?: string; // Some APIs use 'summary' instead of 'title'
  description?: string;
  start_time?: CalendarDateTime;
  end_time?: CalendarDateTime;
  start?: CalendarDateTime; // Alternative field name
  end?: CalendarDateTime;   // Alternative field name
  location?: string;
  is_all_day?: boolean;
  organizer?: {
    email: string;
    name?: string;
  };
  attendees?: Array<{
    email: string;
    name?: string;
    status?: 'accepted' | 'declined' | 'tentative' | 'pending';
  }>;
  meeting_url?: string;
  recurrence?: string;
}

// ============================================
// WEBHOOK TYPES
// ============================================

export interface UnipileWebhook {
  id: string;
  source: 'users' | 'messaging' | 'email' | 'email_tracking' | 'account_status' | 'calendar_event';
  request_url: string;
  name?: string;
  created_at?: string;
  status?: string;
}

// ============================================
// SINGLETON INSTANCE
// ============================================

let unipileClient: UnipileClient | null = null;

/**
 * Get or create the Unipile client instance
 */
export function getUnipileClient(): UnipileClient | null {
  if (!env.UNIPILE_ACCESS_TOKEN || !env.UNIPILE_DSN) {
    console.warn('[Unipile] Not configured - using mock mode');
    return null;
  }

  if (!unipileClient) {
    unipileClient = new UnipileClient(env.UNIPILE_ACCESS_TOKEN, env.UNIPILE_DSN);
  }

  return unipileClient;
}

/**
 * Check if Unipile is configured
 */
export function isUnipileConfigured(): boolean {
  return !!(env.UNIPILE_ACCESS_TOKEN && env.UNIPILE_DSN);
}

/**
 * Store for the active LinkedIn account ID
 */
let activeAccountId: string | null = null;

/**
 * Store for the active email account ID (Google/Microsoft)
 */
let activeEmailAccountId: string | null = null;

/**
 * Get or set the active email account ID
 */
export async function getActiveEmailAccountId(): Promise<string | null> {
  if (activeEmailAccountId) return activeEmailAccountId;
  
  const client = getUnipileClient();
  if (!client) return null;

  try {
    const accounts = await client.listAccounts();
    
    // Find email account (Google or Microsoft)
    const emailAccount = accounts.find(a => {
      const accountObj = a as unknown as Record<string, unknown>;
      const accountType = (accountObj.type || a.provider || '').toString().toUpperCase();
      const sources = accountObj.sources as Array<{status: string}> | undefined;
      const hasOkSource = sources?.some(s => s.status === 'OK');
      // Check for Google OAuth, Microsoft, or mail-enabled accounts
      const isEmailAccount = accountType.includes('GOOGLE') || 
                             accountType.includes('MICROSOFT') || 
                             accountType.includes('MAIL');
      return isEmailAccount && hasOkSource;
    });
    
    if (emailAccount) {
      activeEmailAccountId = emailAccount.id;
      console.log(`[Unipile] Using email account: ${emailAccount.name} (${emailAccount.id})`);
    } else {
      console.warn('[Unipile] No connected email account found');
    }
    return activeEmailAccountId;
  } catch (error) {
    console.error('[Unipile] Failed to get email accounts:', error);
    return null;
  }
}

/**
 * Get or set the active LinkedIn account ID
 */
export async function getActiveAccountId(): Promise<string | null> {
  if (activeAccountId) return activeAccountId;
  
  const client = getUnipileClient();
  if (!client) return null;

  try {
    const accounts = await client.listAccounts();
    // Log full account objects to see actual API response structure
    console.log(`[Unipile] Found ${accounts.length} accounts:`);
    accounts.forEach((a, i) => console.log(`  Account ${i + 1}:`, JSON.stringify(a, null, 2)));
    
    // Find LinkedIn account - check 'type' field (actual API uses 'type' not 'provider')
    const linkedinAccount = accounts.find(a => {
      const accountObj = a as unknown as Record<string, unknown>;
      const accountType = (accountObj.type || a.provider || '').toString().toUpperCase();
      // Check sources array for status
      const sources = accountObj.sources as Array<{status: string}> | undefined;
      const hasOkSource = sources?.some(s => s.status === 'OK');
      return accountType === 'LINKEDIN' && hasOkSource;
    });
    
    if (linkedinAccount) {
      activeAccountId = linkedinAccount.id;
      console.log(`[Unipile] Using LinkedIn account: ${linkedinAccount.name} (${linkedinAccount.id})`);
    } else {
      console.warn('[Unipile] No connected LinkedIn account found in accounts list');
      // Fallback: use first account if only one exists
      if (accounts.length === 1) {
        activeAccountId = accounts[0].id;
        console.log(`[Unipile] Fallback: using only account: ${accounts[0].name} (${accounts[0].id})`);
      } else if (accounts.length > 0) {
        // Try to find any account that looks like LinkedIn by name
        const possibleLinkedin = accounts.find(a => 
          !a.name?.includes('@') // Not an email account
        );
        if (possibleLinkedin) {
          activeAccountId = possibleLinkedin.id;
          console.log(`[Unipile] Fallback: using account: ${possibleLinkedin.name} (${possibleLinkedin.id})`);
        }
      }
    }
    return activeAccountId;
  } catch (error) {
    console.error('[Unipile] Failed to get accounts:', error);
    return null;
  }
}

