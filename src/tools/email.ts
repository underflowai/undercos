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
  getUnipileClient,
  getActiveEmailAccountId,
  type UnipileEmail,
} from './unipile.js';

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
    title: email.subject,
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
    const client = getUnipileClient();
    const accountId = await getActiveEmailAccountId();

    if (!client || !accountId) {
      return {
        success: false,
        error: 'Email account not configured',
      };
    }

    try {
      // Fetch emails from "Meeting Notes" label or INBOX
      const emails = await client.getEmails({
        account_id: accountId,
        limit: args.limit,
        folder: 'Meeting Notes', // Try custom label first
        unread_only: args.unread_only,
      }).catch(() => 
        // Fallback to INBOX if label doesn't exist
        client.getEmails({
          account_id: accountId,
          limit: args.limit,
          folder: 'INBOX',
          unread_only: args.unread_only,
        })
      );

      const parsedNotes = emails.map(email => ({
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
    const client = getUnipileClient();
    const accountId = await getActiveEmailAccountId();

    if (!client || !accountId) {
      return {
        success: false,
        error: 'Email account not configured',
      };
    }

    try {
      const email = await client.getEmail({
        account_id: accountId,
        email_id: args.emailId,
      });

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
    const client = getUnipileClient();
    const accountId = await getActiveEmailAccountId();

    if (!client || !accountId) {
      return {
        success: false,
        error: 'Email account not configured',
      };
    }

    try {
      const result = await client.sendEmail({
        account_id: accountId,
        to: args.to,
        subject: args.subject,
        body: args.body,
        reply_to_email_id: args.replyToEmailId,
      });

      if (result.success) {
        return {
          success: true,
          data: { emailId: result.email_id, threadId: result.thread_id },
          message: 'Email sent successfully',
          emailId: result.email_id,
          threadId: result.thread_id,
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
   */
  async createDraft(args: z.infer<typeof emailSchemas.createDraft>): Promise<ToolResult & { emailId?: string }> {
    const client = getUnipileClient();
    const accountId = await getActiveEmailAccountId();

    if (!client || !accountId) {
      return {
        success: false,
        error: 'Email account not configured',
      };
    }

    try {
      const result = await client.createEmailDraft({
        account_id: accountId,
        to: args.to,
        subject: args.subject,
        body: args.body,
      });

      if (result.success) {
        return {
          success: true,
          data: { emailId: result.email_id },
          message: 'Draft created in your inbox',
          emailId: result.email_id,
        };
      } else {
        return {
          success: false,
          error: result.error || 'Failed to create draft',
        };
      }
    } catch (error) {
      return {
        success: false,
        error: `Failed to create draft: ${error instanceof Error ? error.message : 'Unknown'}`,
      };
    }
  },

  /**
   * Search inbox by keyword, sender, etc.
   * This is a flexible search tool the agent can use to find relevant context.
   */
  async searchInbox(args: z.infer<typeof emailSchemas.searchInbox>): Promise<ToolResult> {
    const client = getUnipileClient();
    const accountId = await getActiveEmailAccountId();

    if (!client || !accountId) {
      return { success: false, error: 'Email account not configured' };
    }

    try {
      let emails: UnipileEmail[] = [];

      if (args.sender) {
        // Search by sender
        emails = await client.searchEmailsBySender({
          account_id: accountId,
          sender: args.sender,
          limit: args.limit,
        });
      } else {
        // Get recent inbox emails
        emails = await client.getEmails({
          account_id: accountId,
          limit: args.limit,
          folder: 'INBOX',
        });
      }

      // Filter by query if provided
      if (args.query) {
        const query = args.query.toLowerCase();
        emails = emails.filter(e => 
          (e.subject || '').toLowerCase().includes(query) ||
          (e.body_plain || '').toLowerCase().includes(query)
        );
      }

      return {
        success: true,
        data: {
          emails: emails.map(e => ({
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
    const client = getUnipileClient();
    const accountId = await getActiveEmailAccountId();

    if (!client || !accountId) {
      return { success: false, error: 'Email account not configured' };
    }

    try {
      let emails: UnipileEmail[] = [];

      if (args.recipient) {
        emails = await client.searchEmailsToRecipient({
          account_id: accountId,
          recipient: args.recipient,
          folder: 'SENT',
          limit: args.limit,
        });
      } else {
        emails = await client.getEmails({
          account_id: accountId,
          limit: args.limit,
          folder: 'SENT',
        });
      }

      // Filter by query if provided
      if (args.query) {
        const query = args.query.toLowerCase();
        emails = emails.filter(e => 
          (e.subject || '').toLowerCase().includes(query) ||
          (e.body_plain || '').toLowerCase().includes(query)
        );
      }

      return {
        success: true,
        data: {
          emails: emails.map(e => ({
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
    const client = getUnipileClient();
    const accountId = await getActiveEmailAccountId();

    if (!client || !accountId) {
      return { success: false, error: 'Email account not configured' };
    }

    try {
      const emails = await client.getEmailHistoryWithContact({
        account_id: accountId,
        contactEmail: args.contactEmail,
        limit: args.limit,
      });

      return {
        success: true,
        data: {
          emails: emails.map(e => ({
            id: e.id,
            subject: e.subject,
            from: e.from,
            to: e.to,
            date: e.date,
            direction: (e.from?.email || '').includes('underflow') ? 'sent' : 'received',
            body: e.body_plain || '',
          })),
          count: emails.length,
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
    const client = getUnipileClient();
    const accountId = await getActiveEmailAccountId();

    if (!client || !accountId) {
      return {
        success: false,
        error: 'Email account not configured',
      };
    }

    try {
      const folders = await client.getEmailFolders(accountId);
      
      return {
        success: true,
        data: {
          folders: folders.map(f => ({
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

