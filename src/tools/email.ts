/**
 * Email Tools for LinkedIn AI Bot
 * 
 * Provides tools for:
 * - Reading meeting notes from Gmail
 * - Drafting follow-up emails
 * - Sending approved emails
 */

import { z } from 'zod';
import type { ToolResult } from './types.js';
import {
  isUnipileConfigured,
  getActiveEmailAccountId,
  getEmails,
  getEmail as getEmailSdk,
  sendEmail as sendEmailSdk,
  getEmailFolders as getEmailFoldersSdk,
  createEmailDraft,
} from './unipile-sdk.js';
import { logAction, updateActionStatus } from '../db/actions-log.js';

// Type definition for email data
interface UnipileEmail {
  id: string;
  subject?: string;
  from: { name?: string; email: string };
  to: Array<{ name?: string; email: string }>;
  cc?: Array<{ name?: string; email: string }>;
  date?: string;
  body?: string;
  body_plain?: string;
  has_attachments?: boolean;
  is_read?: boolean;
}

// =============================================================================
// SCHEMAS
// =============================================================================

export const emailSchemas = {
  getMeetingNotes: z.object({
    limit: z.number().min(1).max(50).default(10).describe('Max emails to fetch'),
    unread_only: z.boolean().default(false).describe('Only fetch unread emails'),
  }),

  getEmail: z.object({
    emailId: z.string().describe('The email ID to fetch'),
  }),

  // New: Search inbox by keyword/sender
  searchInbox: z.object({
    query: z.string().optional().describe('Search query (searches subject and body)'),
    sender: z.string().optional().describe('Filter by sender email or name (e.g. "docusign" or "john@company.com")'),
    limit: z.number().min(1).max(30).default(10).describe('Max emails to return'),
  }),

  // New: Search sent emails
  searchSentEmails: z.object({
    recipient: z.string().optional().describe('Filter by recipient email'),
    query: z.string().optional().describe('Search query'),
    limit: z.number().min(1).max(30).default(10).describe('Max emails to return'),
  }),

  // New: Get full email history with a contact
  getEmailHistoryWithContact: z.object({
    contactEmail: z.string().email().describe('Email address of the contact'),
    limit: z.number().min(1).max(30).default(15).describe('Max emails to return'),
  }),

  draftFollowupEmail: z.object({
    recipient: z.string().email().describe('Email address of the recipient'),
    recipientName: z.string().describe('Name of the recipient'),
    meetingContext: z.string().describe('Context about the meeting (from meeting notes)'),
    keyPoints: z.array(z.string()).optional().describe('Key points to mention'),
  }),

  sendEmail: z.object({
    to: z.array(z.string().email()).describe('Recipients'),
    subject: z.string().describe('Email subject'),
    body: z.string().describe('Email body (HTML supported)'),
    replyToEmailId: z.string().optional().describe('Email ID to reply to (for threading)'),
  }),

  createDraft: z.object({
    to: z.array(z.string().email()).describe('Recipients'),
    subject: z.string().describe('Email subject'),
    body: z.string().describe('Email body (HTML supported)'),
  }),

  listFolders: z.object({}),
};

// =============================================================================
// MEETING NOTES PARSER
// =============================================================================

interface ParsedMeetingNotes {
  title: string;
  date?: string;
  attendees: string[];
  keyPoints: string[];
  actionItems: string[];
  followUps: Array<{
    person: string;
    email?: string;
    task: string;
  }>;
  rawText: string;
}

/**
 * Parse meeting notes from email content
 */
function parseMeetingNotes(email: UnipileEmail): ParsedMeetingNotes {
  const text = email.body_plain || email.body || '';
  
  // Extract attendees from email recipients
  const attendees = [
    email.from.name || email.from.email,
    ...email.to.map(t => t.name || t.email),
    ...(email.cc?.map(c => c.name || c.email) || []),
  ];

  // Simple parsing - look for common patterns
  const keyPoints: string[] = [];
  const actionItems: string[] = [];
  const followUps: Array<{ person: string; email?: string; task: string }> = [];

  const lines = text.split('\n');
  let currentSection = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Detect sections
    if (/^(key\s*points?|highlights?|summary|discussion)/i.test(trimmed)) {
      currentSection = 'key_points';
      continue;
    }
    if (/^(action\s*items?|todos?|tasks?|next\s*steps?)/i.test(trimmed)) {
      currentSection = 'action_items';
      continue;
    }
    if (/^(follow[\s-]*ups?|follow[\s-]*up\s*needed)/i.test(trimmed)) {
      currentSection = 'follow_ups';
      continue;
    }

    // Add to appropriate section
    if (trimmed.startsWith('-') || trimmed.startsWith('•') || /^\d+\./.test(trimmed)) {
      const item = trimmed.replace(/^[-•\d.]+\s*/, '');
      if (currentSection === 'key_points') {
        keyPoints.push(item);
      } else if (currentSection === 'action_items') {
        actionItems.push(item);
      } else if (currentSection === 'follow_ups') {
        // Try to extract person and task
        const match = item.match(/^(.+?):\s*(.+)$/);
        if (match) {
          followUps.push({ person: match[1], task: match[2] });
        } else {
          followUps.push({ person: 'Unknown', task: item });
        }
      }
    }
  }

  return {
    title: email.subject || 'Untitled',
    date: email.date,
    attendees,
    keyPoints,
    actionItems,
    followUps,
    rawText: text,
  };
}

// =============================================================================
// HANDLERS
// =============================================================================

export const emailHandlers = {
  /**
   * Get meeting notes from a specific Gmail label
   */
  async getMeetingNotes(args: z.infer<typeof emailSchemas.getMeetingNotes>): Promise<ToolResult> {
    if (!isUnipileConfigured()) {
      return {
        success: false,
        error: 'Email account not configured',
      };
    }

    try {
      // Fetch emails from "Meeting Notes" label or INBOX
      let emails: UnipileEmail[];
      try {
        emails = await getEmails({
          folder: 'Meeting Notes',
          limit: args.limit,
        }) as UnipileEmail[];
      } catch {
        // Fallback to INBOX if label doesn't exist
        emails = await getEmails({
          folder: 'INBOX',
          limit: args.limit,
        }) as UnipileEmail[];
      }

      const parsedNotes = emails.map((email: UnipileEmail) => ({
        id: email.id,
        ...parseMeetingNotes(email),
      }));

      return {
        success: true,
        data: {
          notes: parsedNotes,
          count: parsedNotes.length,
        },
      };
    } catch (error) {
      console.error('[Email] Failed to fetch meeting notes:', error);
      return {
        success: false,
        error: `Failed to fetch meeting notes: ${error instanceof Error ? error.message : 'Unknown'}`,
      };
    }
  },

  /**
   * Get a specific email
   */
  async getEmail(args: z.infer<typeof emailSchemas.getEmail>): Promise<ToolResult> {
    if (!isUnipileConfigured()) {
      return {
        success: false,
        error: 'Email account not configured',
      };
    }

    try {
      const email = await getEmailSdk(args.emailId) as UnipileEmail | null;
      
      if (!email) {
        return {
          success: false,
          error: 'Email not found',
        };
      }

      return {
        success: true,
        data: {
          email: {
            id: email.id,
            subject: email.subject,
            from: email.from,
            to: email.to,
            date: email.date,
            body: email.body_plain || email.body,
            hasAttachments: email.has_attachments,
          },
          parsedNotes: parseMeetingNotes(email),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to fetch email: ${error instanceof Error ? error.message : 'Unknown'}`,
      };
    }
  },

  /**
   * Draft a follow-up email (requires approval)
   */
  async draftFollowupEmail(args: z.infer<typeof emailSchemas.draftFollowupEmail>): Promise<ToolResult> {
    const keyPointsList = args.keyPoints?.length 
      ? `<ul>${args.keyPoints.map(p => `<li>${p}</li>`).join('')}</ul>`
      : '';

    const draftBody = `
<p>Hi ${args.recipientName},</p>

<p>Great connecting with you! Following up on our recent conversation.</p>

${args.meetingContext ? `<p>${args.meetingContext}</p>` : ''}

${keyPointsList ? `<p><strong>Key points discussed:</strong></p>${keyPointsList}` : ''}

<p>Let me know if you have any questions or would like to discuss further.</p>

<p>Best,<br/>
Ola<br/>
Underflow</p>
`.trim();

    return {
      success: true,
      requiresApproval: true,
      approvalTitle: '✉️ Send Follow-up Email',
      draft: draftBody,
      context: `To: ${args.recipient}`,
      data: {
        to: [args.recipient],
        subject: `Following up - ${args.recipientName}`,
        body: draftBody,
        status: 'pending_approval',
      },
    };
  },

  /**
   * Send an email (should be called after approval)
   */
  async sendEmail(args: z.infer<typeof emailSchemas.sendEmail>): Promise<ToolResult & { emailId?: string; threadId?: string }> {
    if (!isUnipileConfigured()) {
      return {
        success: false,
        error: 'Email account not configured',
      };
    }

    try {
      const result = await sendEmailSdk({
        to: args.to,
        subject: args.subject,
        body: args.body,
        replyTo: args.replyToEmailId,
      });

      if (result.success && result.data) {
        const data = result.data as any;
        return {
          success: true,
          data: { emailId: data.id, threadId: data.thread_id },
          message: 'Email sent successfully',
          emailId: data.id,
          threadId: data.thread_id,
        };
      } else {
        return {
          success: false,
          error: result.error || 'Failed to send email',
        };
      }
    } catch (error) {
      return {
        success: false,
        error: `Failed to send email: ${error instanceof Error ? error.message : 'Unknown'}`,
      };
    }
  },

  /**
   * Create an email draft (instead of sending directly)
   * Note: The SDK doesn't have a dedicated draft method, so we'll note this limitation
   */
  async createDraft(args: z.infer<typeof emailSchemas.createDraft>): Promise<ToolResult & { emailId?: string }> {
    if (!isUnipileConfigured()) {
      return {
        success: false,
        error: 'Email account not configured',
      };
    }

    const entityId = `${args.to.join(',')}|${args.subject}`;
    const actionId = logAction({
      actionType: 'create_draft',
      entityType: 'email_draft',
      entityId,
      status: 'pending',
      data: { to: args.to, subject: args.subject },
    });

    try {
      const result = await createEmailDraft({
        to: args.to,
        subject: args.subject,
        body: args.body,
      });

      if (result.success) {
        updateActionStatus(actionId, 'succeeded', { data: result.data });
        return {
          success: true,
          emailId: (result.data as any)?.id,
          data: result.data,
          message: 'Draft created',
        };
      }

      updateActionStatus(actionId, 'failed', { errorMessage: result.error || 'Failed to create draft' });
      return {
        success: false,
        error: result.error || 'Failed to create draft',
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      updateActionStatus(actionId, 'failed', { errorMessage: msg });
      return {
        success: false,
        error: `Failed to create draft: ${msg}`,
      };
    }
  },

  /**
   * Search inbox by keyword, sender, etc.
   * This is a flexible search tool the agent can use to find relevant context.
   */
  async searchInbox(args: z.infer<typeof emailSchemas.searchInbox>): Promise<ToolResult> {
    if (!isUnipileConfigured()) {
      return { success: false, error: 'Email account not configured' };
    }

    try {
      // Get emails with optional sender filter
      let emails = await getEmails({
        folder: 'INBOX',
        from: args.sender,
        limit: args.limit,
      }) as UnipileEmail[];

      // Filter by query if provided
      if (args.query) {
        const query = args.query.toLowerCase();
        emails = emails.filter((e: UnipileEmail) => 
          (e.subject || '').toLowerCase().includes(query) ||
          (e.body_plain || '').toLowerCase().includes(query)
        );
      }

      return {
        success: true,
        data: {
          emails: emails.map((e: UnipileEmail) => ({
            id: e.id,
            subject: e.subject,
            from: e.from,
            to: e.to,
            date: e.date,
            preview: (e.body_plain || '').slice(0, 500),
            isRead: e.is_read,
          })),
          count: emails.length,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to search inbox: ${error instanceof Error ? error.message : 'Unknown'}`,
      };
    }
  },

  /**
   * Search sent emails
   */
  async searchSentEmails(args: z.infer<typeof emailSchemas.searchSentEmails>): Promise<ToolResult> {
    if (!isUnipileConfigured()) {
      return { success: false, error: 'Email account not configured' };
    }

    try {
      let emails = await getEmails({
        folder: 'SENT',
        to: args.recipient,
        limit: args.limit,
      }) as UnipileEmail[];

      // Filter by query if provided
      if (args.query) {
        const query = args.query.toLowerCase();
        emails = emails.filter((e: UnipileEmail) => 
          (e.subject || '').toLowerCase().includes(query) ||
          (e.body_plain || '').toLowerCase().includes(query)
        );
      }

      return {
        success: true,
        data: {
          emails: emails.map((e: UnipileEmail) => ({
            id: e.id,
            subject: e.subject,
            to: e.to,
            date: e.date,
            preview: (e.body_plain || '').slice(0, 500),
          })),
          count: emails.length,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to search sent emails: ${error instanceof Error ? error.message : 'Unknown'}`,
      };
    }
  },

  /**
   * Get full email history with a specific contact (both sent and received)
   */
  async getEmailHistoryWithContact(args: z.infer<typeof emailSchemas.getEmailHistoryWithContact>): Promise<ToolResult> {
    if (!isUnipileConfigured()) {
      return { success: false, error: 'Email account not configured' };
    }

    try {
      // Fetch emails from and to the contact
      const [received, sent] = await Promise.all([
        getEmails({
          from: args.contactEmail,
          limit: args.limit,
        }),
        getEmails({
          to: args.contactEmail,
          limit: args.limit,
        }),
      ]);

      // Combine and sort by date
      const allEmails = [...(received as UnipileEmail[]), ...(sent as UnipileEmail[])]
        .sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime())
        .slice(0, args.limit);

      return {
        success: true,
        data: {
          emails: allEmails.map((e: UnipileEmail) => ({
            id: e.id,
            subject: e.subject,
            from: e.from,
            to: e.to,
            date: e.date,
            direction: (e.from?.email || '').includes('underflow') ? 'sent' : 'received',
            body: e.body_plain || '',
          })),
          count: allEmails.length,
          contactEmail: args.contactEmail,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to get email history: ${error instanceof Error ? error.message : 'Unknown'}`,
      };
    }
  },

  /**
   * List email folders
   */
  async listFolders(_args: z.infer<typeof emailSchemas.listFolders>): Promise<ToolResult> {
    if (!isUnipileConfigured()) {
      return {
        success: false,
        error: 'Email account not configured',
      };
    }

    try {
      const folders = await getEmailFoldersSdk();
      
      return {
        success: true,
        data: {
          folders: folders.map((f: any) => ({
            id: f.id,
            name: f.name,
            type: f.type,
            unreadCount: f.unread_count,
          })),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to list folders: ${error instanceof Error ? error.message : 'Unknown'}`,
      };
    }
  },
};

// =============================================================================
// EXPORTS
// =============================================================================

export { parseMeetingNotes, type ParsedMeetingNotes };

