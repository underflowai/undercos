/**
 * Email History Module
 * 
 * Functions for checking email history with contacts.
 */

import { isUnipileConfigured, getEmails } from '../../tools/unipile-sdk.js';
import type { EmailHistoryContext, UnipileEmail } from './types.js';
import { RECENT_EMAIL_DAYS } from './types.js';

/**
 * Check if we've emailed this person AFTER a specific date
 * Used to avoid duplicate follow-ups for meetings
 * @param sinceDate - Only count emails sent after this date (e.g., meeting end time)
 */
export async function hasRecentlyEmailedRecipient(
  recipientEmail: string,
  sinceDate?: Date
): Promise<{ hasEmailed: boolean; lastEmailDate?: string; lastSubject?: string }> {
  if (!isUnipileConfigured()) {
    return { hasEmailed: false };
  }

  try {
    // Use provided date or default to RECENT_EMAIL_DAYS ago
    const cutoffDate = sinceDate || new Date(Date.now() - RECENT_EMAIL_DAYS * 24 * 60 * 60 * 1000);

    // Fetch sent emails to recipient
    const sentEmails = await getEmails({
      to: recipientEmail,
      folder: 'SENT',
      limit: 20,
    }) as UnipileEmail[];

    // Filter by date ourselves since the API doesn't do it correctly
    const emailsAfterCutoff = sentEmails.filter((email: UnipileEmail) => {
      const emailDate = new Date(email.date || 0);
      return emailDate > cutoffDate;
    });

    if (emailsAfterCutoff.length > 0) {
      const mostRecent = emailsAfterCutoff[0];
      console.log(`[EmailHistory] Found email to ${recipientEmail} on ${mostRecent.date}: "${mostRecent.subject}"`);
      return {
        hasEmailed: true,
        lastEmailDate: mostRecent.date,
        lastSubject: mostRecent.subject,
      };
    }

    console.log(`[EmailHistory] No emails to ${recipientEmail} after ${cutoffDate.toISOString()}`);
    return { hasEmailed: false };
  } catch (error) {
    console.error('[EmailHistory] Failed to check recent emails:', error);
    return { hasEmailed: false };
  }
}

/**
 * Get email history context with a person for better draft generation
 * Includes FULL email bodies for richer context
 */
export async function getEmailHistoryContext(
  contactEmail: string
): Promise<EmailHistoryContext> {
  if (!isUnipileConfigured()) {
    return { recentEmails: [], hasRecentContact: false };
  }

  try {
    // Fetch emails from and to the contact
    const [received, sent] = await Promise.all([
      getEmails({ from: contactEmail, limit: 10 }),
      getEmails({ to: contactEmail, limit: 10 }),
    ]);
    
    const allEmails = [...(received as UnipileEmail[]), ...(sent as UnipileEmail[])]
      .sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime())
      .slice(0, 15);
    
    const recentEmails = allEmails.map((email: UnipileEmail) => ({
      subject: email.subject || '',
      date: email.date || '',
      fromMe: email.from?.email?.toLowerCase() !== contactEmail.toLowerCase(),
      snippet: (email.body || '').slice(0, 200),
      body: email.body || '',
    }));

    const lastContactDate = allEmails[0]?.date;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - RECENT_EMAIL_DAYS);
    const hasRecentContact = lastContactDate 
      ? new Date(lastContactDate) > cutoffDate 
      : false;

    console.log(`[EmailHistory] Found ${allEmails.length} emails with ${contactEmail}`);

    return {
      recentEmails,
      lastContactDate,
      hasRecentContact,
    };
  } catch (error) {
    console.error('[EmailHistory] Failed to get email history:', error);
    return { recentEmails: [], hasRecentContact: false };
  }
}

