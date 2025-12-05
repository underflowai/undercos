import { z } from 'zod';
import type { ToolResult } from './types.js';
import { 
  isUnipileConfigured,
  getActiveLinkedinAccountId,
  // SDK functions
  searchLinkedIn,
  getLocationIds,
  getPost,
  getProfile,
  getPosts,
  listChats,
  sendInvitation,
  commentOnPost as sdkCommentOnPost,
  reactToPost as sdkReactToPost,
  startNewChat,
} from './unipile-sdk.js';
import {
  canPerformAction,
  recordActivity,
  type ActivityType,
} from '../discovery/activity-tracker.js';
import { trackSentInvitation } from '../tracking/invitations.js';

// Type definitions for LinkedIn data
interface UnipilePost {
  id: string;
  provider_id?: string;
  author: { id?: string; name: string; headline?: string; profile_url?: string };
  text?: string;
  url?: string;
  likes_count?: number;
  comments_count?: number;
  reposts_count?: number;
  created_at?: string;
}

interface UnipileProfile {
  id: string;
  provider_id?: string;
  name: string;
  first_name?: string;
  last_name?: string;
  headline?: string;
  profile_url?: string;
  location?: string;
  company?: string;
  connections_count?: number;
  is_connection?: boolean;
  about?: string;
}

/**
 * LinkedIn tool parameter schemas
 */
export const linkedinSchemas = {
  searchPosts: z.object({
    keywords: z.array(z.string()).describe('Keywords to search for. Must be an array like ["term1", "term2"]'),
    limit: z.number().min(1).max(20).default(5).describe('Max number of posts to return'),
    locations: z.array(z.string()).optional().describe('MUST be an array like ["United States", "Canada"]. NOT a string!'),
    datePosted: z.enum(['past_day', 'past_week', 'past_month']).optional().describe('ONLY valid values: "past_day" (24h), "past_week", "past_month". Default: past_week'),
  }),

  getPostDetails: z.object({
    postUrl: z.string().describe('LinkedIn post URL or post ID'),
  }),

  commentOnPost: z.object({
    postUrl: z.string().describe('LinkedIn post URL or post ID'),
    comment: z.string().max(3000).describe('The comment text'),
  }),

  likePost: z.object({
    postUrl: z.string().describe('LinkedIn post URL or post ID'),
    reactionType: z.enum(['LIKE', 'CELEBRATE', 'SUPPORT', 'LOVE', 'INSIGHTFUL', 'FUNNY']).default('LIKE').describe('Type of reaction'),
  }),

  getProfile: z.object({
    profileUrl: z.string().describe('LinkedIn profile URL or user ID'),
  }),

  searchProfiles: z.object({
    query: z.string().describe('Search query (name, title, company, etc.)'),
    limit: z.number().min(1).max(25).default(10).describe('Max profiles to return'),
    locations: z.array(z.string()).optional().describe('Filter by locations (e.g., ["United States"])'),
  }),

  sendConnectionRequest: z.object({
    profileUrl: z.string().describe('LinkedIn profile URL or user ID'),
    note: z.string().max(300).optional().describe('Optional connection note'),
  }),

  sendDM: z.object({
    profileUrl: z.string().describe('LinkedIn profile URL or user ID'),
    message: z.string().max(8000).describe('The message to send'),
  }),

  listChats: z.object({
    limit: z.number().min(1).max(50).default(20).describe('Max chats to return'),
  }),

  getProfilePosts: z.object({
    profileUrl: z.string().describe('LinkedIn profile URL or user ID'),
    limit: z.number().min(1).max(20).default(5).describe('Max posts to return'),
  }),
};

// ============================================
// MOCK DATA (used when Unipile not configured)
// ============================================

const mockPosts: UnipilePost[] = [
  {
    id: 'mock-post-1',
    provider_id: 'li-post-1',
    author: {
      id: 'user-1',
      name: 'Sarah Chen',
      headline: 'VP of Underwriting at Specialty Risk',
      profile_url: 'https://linkedin.com/in/sarah-chen',
    },
    text: 'The E&S market hit $100B in premium this year. As traditional carriers pull back from complex risks, MGAs are stepping up. Who else is seeing this shift? #insurance #E&S',
    url: 'https://linkedin.com/posts/sarah-chen_e-s-market',
    likes_count: 234,
    comments_count: 45,
    reposts_count: 12,
    created_at: '2 hours ago',
  },
  {
    id: 'mock-post-2',
    provider_id: 'li-post-2',
    author: {
      id: 'user-2',
      name: 'Mike Rodriguez',
      headline: 'CEO at QuickBind MGA',
      profile_url: 'https://linkedin.com/in/mike-rodriguez',
    },
    text: 'We just cut our submission processing time by 60% using AI. The bottleneck was always data entry - now our underwriters focus on actual underwriting. Happy to share what worked.',
    url: 'https://linkedin.com/posts/mike-rodriguez_ai-automation',
    likes_count: 189,
    comments_count: 67,
    reposts_count: 23,
    created_at: '5 hours ago',
  },
  {
    id: 'mock-post-3',
    provider_id: 'li-post-3',
    author: {
      id: 'user-3',
      name: 'Jennifer Walsh',
      headline: 'Partner at InsureTech Ventures',
      profile_url: 'https://linkedin.com/in/jennifer-walsh',
    },
    text: 'Invested in my 5th MGA this year. The common thread? They all treat technology as core to their underwriting edge, not just operations. The best MGAs are becoming tech companies.',
    url: 'https://linkedin.com/posts/jennifer-walsh_insurtech',
    likes_count: 412,
    comments_count: 89,
    reposts_count: 45,
    created_at: '1 day ago',
  },
];

const mockProfiles: UnipileProfile[] = [
  {
    id: 'user-1',
    provider_id: 'sarah-chen-123',
    name: 'Sarah Chen',
    first_name: 'Sarah',
    last_name: 'Chen',
    headline: 'VP of Underwriting at Specialty Risk',
    profile_url: 'https://linkedin.com/in/sarah-chen',
    location: 'New York, NY',
    company: 'Specialty Risk',
    connections_count: 500,
    is_connection: false,
    about: 'Building the future of specialty insurance. 15 years in E&S.',
  },
];

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Extract post ID from URL or return as-is if already an ID
 */
function extractPostId(urlOrId: string): string {
  // If it looks like a URL, try to extract the post ID
  if (urlOrId.includes('linkedin.com')) {
    const match = urlOrId.match(/activity-(\d+)|posts\/([^/]+)/);
    if (match) return match[1] || match[2];
  }
  return urlOrId;
}

/**
 * Extract profile identifier from URL or return as-is
 */
function extractProfileId(urlOrId: string): string {
  if (urlOrId.includes('linkedin.com/in/')) {
    const match = urlOrId.match(/linkedin\.com\/in\/([^/?]+)/);
    if (match) return match[1];
  }
  return urlOrId;
}

// ============================================
// TOOL HANDLERS
// ============================================

export const linkedinHandlers = {
  /**
   * Search for posts by keywords
   */
  async searchPosts(args: z.infer<typeof linkedinSchemas.searchPosts>): Promise<ToolResult> {
    // Check search limits
    const searchCheck = canPerformAction('search');
    if (!searchCheck.allowed) {
      return { success: false, error: `⚠️ ${searchCheck.reason}. Try again later.` };
    }
    
    if (isUnipileConfigured()) {
      try {
        const dateFilter = args.datePosted || 'past_week';
        console.log(`[SDK] Searching posts: ${args.keywords.join(', ')} (date: ${dateFilter}${args.locations?.length ? `, locations: ${args.locations.join(', ')}` : ''})`);
        
        // Resolve location IDs if needed
        let locationIds: string[] | undefined;
        if (args.locations?.length) {
          const allIds = await Promise.all(args.locations.map(loc => getLocationIds(loc)));
          locationIds = allIds.flat();
        }
        
        recordActivity('search');
        const result = await searchLinkedIn({
          category: 'posts',
          keywords: args.keywords.join(' '),
          limit: args.limit,
          location: locationIds,
          date_posted: dateFilter,
        });
        
        console.log(`[SDK] Found ${result.items.length} posts`);
        
        return {
          success: true,
          data: {
            posts: result.items.map(formatPost),
            count: result.items.length,
            keywords: args.keywords,
            source: 'unipile',
          },
        };
      } catch (error) {
        console.error('[SDK] Search failed, falling back to mock:', error);
      }
    }
    
    // Mock mode - clearly indicate this is fake data
    console.log(`[Mock] Searching posts: ${args.keywords.join(', ')} (returning sample data)`);
    return {
      success: true,
      data: {
        posts: mockPosts.slice(0, args.limit).map(formatPost),
        count: Math.min(mockPosts.length, args.limit),
        keywords: args.keywords,
        source: 'mock',
        note: '⚠️ These are sample posts. Real LinkedIn search via Unipile may not be available.',
      },
    };
  },

  /**
   * Get post details
   */
  async getPostDetails(args: z.infer<typeof linkedinSchemas.getPostDetails>): Promise<ToolResult> {
    const postId = extractPostId(args.postUrl);
    
    if (isUnipileConfigured()) {
      try {
        console.log(`[SDK] Getting post: ${postId}`);
        
        const post = await getPost(postId);
        if (post) {
          return {
            success: true,
            data: formatPost(post as UnipilePost),
          };
        }
      } catch (error) {
        console.error('[SDK] Get post failed:', error);
      }
    }
    
    // Mock mode
    const mockPost = mockPosts.find(p => p.url?.includes(postId)) || mockPosts[0];
    return {
      success: true,
      data: formatPost(mockPost),
    };
  },

  /**
   * Comment on a post (requires approval)
   */
  async commentOnPost(args: z.infer<typeof linkedinSchemas.commentOnPost>): Promise<ToolResult> {
    const postId = extractPostId(args.postUrl);
    console.log(`[LinkedIn] Draft comment on: ${postId}`);
    
    return {
      success: true,
      requiresApproval: true,
      approvalTitle: '💬 Comment on LinkedIn Post',
      draft: args.comment,
      context: `Post: ${args.postUrl}`,
      data: {
        postId,
        postUrl: args.postUrl,
        comment: args.comment,
        status: 'pending_approval',
        hasUnipile: isUnipileConfigured(),
      },
    };
  },

  /**
   * Like/react to a post (requires approval)
   */
  async likePost(args: z.infer<typeof linkedinSchemas.likePost>): Promise<ToolResult> {
    const postId = extractPostId(args.postUrl);
    console.log(`[LinkedIn] Draft ${args.reactionType} on: ${postId}`);
    
    return {
      success: true,
      requiresApproval: true,
      approvalTitle: `👍 ${args.reactionType} LinkedIn Post`,
      context: `Post: ${args.postUrl}`,
      data: {
        postId,
        postUrl: args.postUrl,
        reactionType: args.reactionType,
        status: 'pending_approval',
        hasUnipile: isUnipileConfigured(),
      },
    };
  },

  /**
   * Get profile details
   */
  async getProfile(args: z.infer<typeof linkedinSchemas.getProfile>): Promise<ToolResult> {
    const profileId = extractProfileId(args.profileUrl);
    
    if (isUnipileConfigured()) {
      try {
        console.log(`[SDK] Getting profile: ${profileId}`);
        
        const profile = await getProfile(args.profileUrl);
        if (profile) {
          return {
            success: true,
            data: formatProfile(profile as unknown as UnipileProfile),
          };
        }
      } catch (error) {
        console.error('[SDK] Get profile failed:', error);
      }
    }
    
    // Mock mode
    const mockProfile = mockProfiles.find(p => p.profile_url?.includes(profileId)) || {
      ...mockProfiles[0],
      profile_url: args.profileUrl,
    };
    return {
      success: true,
      data: formatProfile(mockProfile),
    };
  },

  /**
   * Search for profiles
   */
  async searchProfiles(args: z.infer<typeof linkedinSchemas.searchProfiles>): Promise<ToolResult> {
    // Check search limits
    const searchCheck = canPerformAction('search');
    if (!searchCheck.allowed) {
      return { success: false, error: `⚠️ ${searchCheck.reason}. Try again later.` };
    }
    
    if (isUnipileConfigured()) {
      try {
        console.log(`[SDK] Searching profiles: ${args.query}${args.locations?.length ? ` (locations: ${args.locations.join(', ')})` : ''}`);
        
        // Resolve location IDs if needed
        let locationIds: string[] | undefined;
        if (args.locations?.length) {
          const allIds = await Promise.all(args.locations.map(loc => getLocationIds(loc)));
          locationIds = allIds.flat();
        }
        
        recordActivity('search');
        const result = await searchLinkedIn({
          category: 'people',
          keywords: args.query,
          limit: args.limit,
          location: locationIds,
        });
        
        return {
          success: true,
          data: {
            profiles: result.items.map((item: any) => formatProfile(item as UnipileProfile)),
            count: result.items.length,
            total: result.total,
            source: 'unipile',
          },
        };
      } catch (error) {
        console.error('[SDK] Search profiles failed:', error);
      }
    }
    
    // Mock mode
    return {
      success: true,
      data: {
        profiles: mockProfiles.map(formatProfile),
        count: mockProfiles.length,
        total: mockProfiles.length,
        source: 'mock',
      },
    };
  },

  /**
   * Send connection request (requires approval)
   */
  async sendConnectionRequest(args: z.infer<typeof linkedinSchemas.sendConnectionRequest>): Promise<ToolResult> {
    const profileId = extractProfileId(args.profileUrl);
    console.log(`[LinkedIn] Draft connection request: ${profileId}`);
    
    return {
      success: true,
      requiresApproval: true,
      approvalTitle: '🤝 Send Connection Request',
      draft: args.note,
      context: `Profile: ${args.profileUrl}`,
      data: {
        profileId,
        profileUrl: args.profileUrl,
        note: args.note,
        status: 'pending_approval',
        hasUnipile: isUnipileConfigured(),
      },
    };
  },

  /**
   * Send DM (requires approval)
   */
  async sendDM(args: z.infer<typeof linkedinSchemas.sendDM>): Promise<ToolResult> {
    const profileId = extractProfileId(args.profileUrl);
    console.log(`[LinkedIn] Draft DM: ${profileId}`);
    
    return {
      success: true,
      requiresApproval: true,
      approvalTitle: '✉️ Send LinkedIn DM',
      draft: args.message,
      context: `To: ${args.profileUrl}`,
      data: {
        profileId,
        profileUrl: args.profileUrl,
        message: args.message,
        status: 'pending_approval',
        hasUnipile: isUnipileConfigured(),
      },
    };
  },

  /**
   * List recent chats
   */
  async listChats(args: z.infer<typeof linkedinSchemas.listChats>): Promise<ToolResult> {
    if (isUnipileConfigured()) {
      try {
        console.log(`[SDK] Listing chats`);
        
        const chats = await listChats(args.limit);
        
        return {
          success: true,
          data: {
            chats: chats.map((chat: any) => ({
              id: chat.id,
              name: chat.name,
              attendees: (chat.attendees || []).map((a: any) => a.name).join(', '),
              lastMessage: chat.last_message?.text,
              unreadCount: chat.unread_count,
            })),
            count: chats.length,
            source: 'unipile',
          },
        };
      } catch (error) {
        console.error('[SDK] List chats failed:', error);
      }
    }
    
    // Mock mode
    return {
      success: true,
      data: {
        chats: [],
        count: 0,
        source: 'mock',
        note: 'Chat list requires Unipile connection',
      },
    };
  },

  /**
   * Get posts from a specific profile
   */
  async getProfilePosts(args: z.infer<typeof linkedinSchemas.getProfilePosts>): Promise<ToolResult> {
    if (isUnipileConfigured()) {
      try {
        console.log(`[SDK] Getting posts from: ${args.profileUrl}`);
        
        const posts = await getPosts(args.profileUrl, args.limit);
        
        return {
          success: true,
          data: {
            posts: posts.map((p: any) => formatPost(p as UnipilePost)),
            count: posts.length,
            source: 'unipile',
          },
        };
      } catch (error) {
        console.error('[SDK] Get profile posts failed:', error);
      }
    }
    
    // Mock mode - filter by author
    return {
      success: true,
      data: {
        posts: mockPosts.slice(0, args.limit).map(formatPost),
        count: Math.min(mockPosts.length, args.limit),
        source: 'mock',
      },
    };
  },
};

// ============================================
// FORMAT HELPERS
// ============================================

function formatPost(post: UnipilePost) {
  return {
    id: post.id,
    url: post.url,
    author: {
      name: post.author.name,
      headline: post.author.headline,
      profileUrl: post.author.profile_url,
    },
    content: post.text,
    engagement: {
      likes: post.likes_count,
      comments: post.comments_count,
      reposts: post.reposts_count,
    },
    postedAt: post.created_at,
  };
}

function formatProfile(profile: UnipileProfile) {
  return {
    id: profile.id,
    name: profile.name,
    headline: profile.headline,
    location: profile.location,
    company: profile.company,
    profileUrl: profile.profile_url,
    connections: profile.connections_count,
    isConnection: profile.is_connection,
    about: profile.about,
  };
}

// ============================================
// ACTION EXECUTION (after approval)
// ============================================

/**
 * Execute a LinkedIn action after user approval
 */
// Map action names to activity types for tracking
const ACTION_TO_ACTIVITY: Record<string, ActivityType> = {
  'comment_on_post': 'comment',
  'like_post': 'like',
  'send_connection_request': 'invitation',
  'send_dm': 'message',
};

export async function executeLinkedInAction(
  action: string,
  args: Record<string, unknown>,
  editedDraft?: string
): Promise<{ success: boolean; message?: string; error?: string }> {
  console.log(`[LinkedIn] Executing: ${action}`);
  
  // Check activity limits before executing
  const activityType = ACTION_TO_ACTIVITY[action];
  if (activityType) {
    const check = canPerformAction(activityType);
    if (!check.allowed) {
      console.log(`[LinkedIn] Action blocked: ${check.reason}`);
      return { 
        success: false, 
        error: `⚠️ ${check.reason}. Try again tomorrow to stay within LinkedIn's best practices.` 
      };
    }
    console.log(`[LinkedIn] Activity check passed: ${activityType} (${check.dailyCount}/${check.dailyLimit} today)`);
  }
  
  switch (action) {
    case 'comment_on_post': {
      const comment = editedDraft || (args.comment as string);
      const postId = args.postId as string;
      
      if (isUnipileConfigured()) {
        try {
          const response = await sdkCommentOnPost(postId, comment);
          
          if (response.success) {
            recordActivity('comment');
            return { success: true, message: '✅ Comment posted via Unipile!' };
          } else {
            return { success: false, error: response.error || 'Failed to post comment' };
          }
        } catch (error) {
          return { 
            success: false, 
            error: `Unipile error: ${error instanceof Error ? error.message : 'Unknown error'}` 
          };
        }
      }
      
      recordActivity('comment');
      console.log(`[Mock] Posted comment on ${postId}: ${comment}`);
      return { success: true, message: '[Mock] Comment posted!' };
    }
    
    case 'like_post': {
      const postId = args.postId as string;
      const reactionType = ((args.reactionType as string) || 'LIKE').toLowerCase() as 'like' | 'celebrate' | 'support' | 'love' | 'insightful' | 'funny';
      
      if (isUnipileConfigured()) {
        try {
          const response = await sdkReactToPost(postId, reactionType);
          
          if (response.success) {
            recordActivity('like');
            return { success: true, message: '✅ Reaction added via Unipile!' };
          } else {
            return { success: false, error: response.error || 'Failed to react' };
          }
        } catch (error) {
          return { 
            success: false, 
            error: `Unipile error: ${error instanceof Error ? error.message : 'Unknown error'}` 
          };
        }
      }
      
      recordActivity('like');
      console.log(`[Mock] Reacted ${reactionType} to ${postId}`);
      return { success: true, message: '[Mock] Reaction added!' };
    }
    
    case 'send_connection_request': {
      let profileId = args.profileId as string | undefined;
      const profileUrl = args.profileUrl as string | undefined;
      const profileName = args.profileName as string | undefined;
      const note = editedDraft || (args.note as string | undefined);
      
      // Basic validation
      if (!profileId && !profileUrl) {
        return { success: false, error: 'No profile identifier provided' };
      }
      // Derive identifier from URL if needed
      if (!profileId && profileUrl) {
        profileId = profileUrl.replace('https://linkedin.com/in/', '');
      }
      
      if (isUnipileConfigured()) {
        try {
          // LinkedIn invitations require the internal provider_id (format: ACoAAA...)
          const isProviderId = profileId?.startsWith('ACoAAA') || profileId?.startsWith('ACwAAA') || profileId?.startsWith('AEMAA');
          
          if (!isProviderId) {
            console.log(`[LinkedIn] profileId "${profileId}" is not a provider_id, fetching profile first...`);
            
            // Try to get the profile to retrieve the real provider_id
            const identifier = profileId || profileUrl?.replace('https://linkedin.com/in/', '');
            if (identifier) {
              try {
                const profile = await getProfile(identifier);
                
                if (profile && (profile as any).provider_id) {
                  console.log(`[LinkedIn] Resolved provider_id: ${(profile as any).provider_id}`);
                  profileId = (profile as any).provider_id;
                } else {
                  console.error('[LinkedIn] Profile fetch did not return provider_id');
                  return { success: false, error: 'Could not resolve LinkedIn provider ID. Try again.' };
                }
              } catch (profileError) {
                console.error('[LinkedIn] Failed to fetch profile:', profileError);
                return { 
                  success: false, 
                  error: 'Could not resolve LinkedIn provider ID. The profile may not be accessible.' 
                };
              }
            } else {
              return { success: false, error: 'No valid profile identifier provided' };
            }
          }
          
          if (!profileId) {
            return { success: false, error: 'Unable to resolve profile ID' };
          }
          
          console.log(`[LinkedIn] Sending invitation to provider_id: ${profileId}`);
          
          const response = await sendInvitation(profileId, note);
          
          if (response.success) {
            recordActivity('invitation');
            
            // Track the invitation for real-time acceptance detection
            if (note) {
              trackSentInvitation({
                providerId: profileId,
                publicId: profileUrl?.replace('https://linkedin.com/in/', ''),
                name: profileName,
                note,
              });
            }
            
            return { success: true, message: '✅ Connection request sent via Unipile!' };
          } else {
            return { success: false, error: response.error || 'Failed to send connection' };
          }
        } catch (error) {
          return { 
            success: false, 
            error: `Unipile error: ${error instanceof Error ? error.message : 'Unknown error'}` 
          };
        }
      }
      
      recordActivity('invitation');
      console.log(`[Mock] Sent connection to ${profileId}${note ? ` with note: ${note}` : ''}`);
      return { success: true, message: '[Mock] Connection request sent!' };
    }
    
    case 'send_dm': {
      const profileId = args.profileId as string;
      const message = editedDraft || (args.message as string);
      
      if (isUnipileConfigured()) {
        try {
          const response = await startNewChat(profileId, message);
          
          if (response.success) {
            recordActivity('message');
            return { success: true, message: '✅ Message sent via Unipile!' };
          } else {
            return { success: false, error: response.error || 'Failed to send message' };
          }
        } catch (error) {
          return { 
            success: false, 
            error: `Unipile error: ${error instanceof Error ? error.message : 'Unknown error'}` 
          };
        }
      }
      
      recordActivity('message');
      console.log(`[Mock] Sent DM to ${profileId}: ${message}`);
      return { success: true, message: '[Mock] Message sent!' };
    }
    
    default:
      return { success: false, error: `Unknown action: ${action}` };
  }
}
