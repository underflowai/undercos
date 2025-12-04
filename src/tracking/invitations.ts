/**
 * Invitation Tracking
 * 
 * Tracks sent connection invitations for real-time acceptance detection.
 * When a connection request with a note is accepted, LinkedIn creates a new chat
 * with the note as the first message. We can detect this in real-time by matching
 * the message content to tracked invitations.
 */

export interface TrackedInvitation {
  providerId: string;
  publicId?: string;
  name?: string;
  note?: string;
  sentAt: Date;
  notified: boolean; // Set to true when we've notified about acceptance
}

// In-memory store for tracked invitations
// In production, this should be persisted to a database
const trackedInvitations = new Map<string, TrackedInvitation>();

// Clean up old invitations periodically (older than 30 days)
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Track a sent invitation
 */
export function trackSentInvitation(params: {
  providerId: string;
  publicId?: string;
  name?: string;
  note?: string;
}): void {
  trackedInvitations.set(params.providerId, {
    providerId: params.providerId,
    publicId: params.publicId,
    name: params.name,
    note: params.note,
    sentAt: new Date(),
    notified: false,
  });
  
  console.log(`[Tracking] Tracked invitation to ${params.name || params.providerId}`);
  
  // Clean up old invitations
  cleanupOldInvitations();
}

/**
 * Get a tracked invitation by provider ID
 */
export function getSentInvitation(providerId: string): TrackedInvitation | undefined {
  return trackedInvitations.get(providerId);
}

/**
 * Remove a tracked invitation (after acceptance or rejection)
 */
export function removeSentInvitation(providerId: string): void {
  const invitation = trackedInvitations.get(providerId);
  if (invitation) {
    console.log(`[Tracking] Removed invitation to ${invitation.name || providerId}`);
    trackedInvitations.delete(providerId);
  }
}

/**
 * Get all tracked invitations
 */
export function getAllTrackedInvitations(): TrackedInvitation[] {
  return Array.from(trackedInvitations.values());
}

/**
 * Get count of tracked invitations
 */
export function getTrackedInvitationsCount(): number {
  return trackedInvitations.size;
}

/**
 * Clean up invitations older than MAX_AGE_MS
 */
function cleanupOldInvitations(): void {
  const now = Date.now();
  let removed = 0;
  
  for (const [providerId, invitation] of trackedInvitations.entries()) {
    if (now - invitation.sentAt.getTime() > MAX_AGE_MS) {
      trackedInvitations.delete(providerId);
      removed++;
    }
  }
  
  if (removed > 0) {
    console.log(`[Tracking] Cleaned up ${removed} old invitations`);
  }
}

/**
 * Mark an invitation as notified (to prevent duplicate notifications)
 */
export function markInvitationNotified(providerId: string): void {
  const invitation = trackedInvitations.get(providerId);
  if (invitation) {
    invitation.notified = true;
  }
}

