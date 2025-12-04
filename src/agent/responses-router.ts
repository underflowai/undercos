/**
 * Router using OpenAI Responses API with Web Search
 * 
 * This router uses the Responses API which supports:
 * - Built-in web_search tool for real-time information
 * - Function calling for LinkedIn tools
 * - Multi-turn conversations via previous_response_id
 */

import { ResponsesAPIClient, type FunctionTool, type ResponsesResult } from '../llm/responses.js';
import { linkedinSchemas, linkedinHandlers, executeLinkedInAction } from '../tools/linkedin.js';
import { emailSchemas, emailHandlers } from '../tools/email.js';
import { isUnipileConfigured } from '../tools/unipile.js';
import { LINKEDIN_SYSTEM_PROMPT } from './prompts.js';
import type { ToolResult } from '../tools/types.js';

// =============================================================================
// TYPES
// =============================================================================

export interface PendingAction {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  title: string;
  description: string;
  draft?: string;
  context?: string;
}

export interface RouterResult {
  response: string;
  pendingActions: PendingAction[];
  toolsCalled: string[];
  webSearchUsed: boolean;
  citations: Array<{ url: string; title?: string }>;
}

interface ConversationContext {
  threadTs: string;
  channelId: string;
  userId: string;
}

// =============================================================================
// TOOL DEFINITIONS
// =============================================================================

/**
 * Convert Zod schema to JSON Schema for OpenAI function tools
 */
function zodToJsonSchema(schema: { shape: Record<string, unknown> }): Record<string, unknown> {
  const shape = schema.shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const zodType = value as { _def: { typeName: string; description?: string; defaultValue?: () => unknown; innerType?: { _def: { typeName: string } } } };
    const def = zodType._def;
    
    let type = 'string';
    if (def.typeName === 'ZodNumber') type = 'number';
    if (def.typeName === 'ZodBoolean') type = 'boolean';
    if (def.typeName === 'ZodArray') type = 'array';
    if (def.typeName === 'ZodDefault') {
      type = def.innerType?._def.typeName === 'ZodNumber' ? 'number' : 'string';
    }

    properties[key] = {
      type: type === 'array' ? 'array' : type,
      description: def.description,
      ...(type === 'array' ? { items: { type: 'string' } } : {}),
    };

    if (def.typeName !== 'ZodDefault' && def.typeName !== 'ZodOptional') {
      required.push(key);
    }
  }

  return {
    type: 'object',
    properties,
    required: required.length > 0 ? required : undefined,
  };
}

function buildFunctionTools(): FunctionTool[] {
  const mode = isUnipileConfigured() ? '(via Unipile API)' : '(mock mode)';
  
  return [
    // ========================================
    // LINKEDIN TOOLS
    // ========================================
    {
      type: 'function',
      name: 'search_posts_by_keywords',
      description: `Search for LinkedIn posts matching keywords ${mode}. Use this to find relevant content to engage with.`,
      parameters: zodToJsonSchema(linkedinSchemas.searchPosts),
    },
    {
      type: 'function',
      name: 'get_post_details',
      description: `Get full details of a specific LinkedIn post ${mode}.`,
      parameters: zodToJsonSchema(linkedinSchemas.getPostDetails),
    },
    {
      type: 'function',
      name: 'comment_on_post',
      description: `Draft a comment on a LinkedIn post ${mode}. The comment will be shown to the user for approval before posting.`,
      parameters: zodToJsonSchema(linkedinSchemas.commentOnPost),
    },
    {
      type: 'function',
      name: 'like_post',
      description: `React to a LinkedIn post (like, celebrate, support, etc.) ${mode}. Requires user approval.`,
      parameters: zodToJsonSchema(linkedinSchemas.likePost),
    },
    {
      type: 'function',
      name: 'get_profile',
      description: `Get LinkedIn profile details including name, headline, location, and about section ${mode}.`,
      parameters: zodToJsonSchema(linkedinSchemas.getProfile),
    },
    {
      type: 'function',
      name: 'search_profiles',
      description: `Search for LinkedIn profiles by name, title, company, etc. ${mode}.`,
      parameters: zodToJsonSchema(linkedinSchemas.searchProfiles),
    },
    {
      type: 'function',
      name: 'send_connection_request',
      description: `Send a LinkedIn connection request with an optional personalized note ${mode}. Requires user approval.`,
      parameters: zodToJsonSchema(linkedinSchemas.sendConnectionRequest),
    },
    {
      type: 'function',
      name: 'send_dm',
      description: `Send a direct message to a LinkedIn user ${mode}. Requires user approval.`,
      parameters: zodToJsonSchema(linkedinSchemas.sendDM),
    },
    {
      type: 'function',
      name: 'list_chats',
      description: `List recent LinkedIn conversations/chats ${mode}.`,
      parameters: zodToJsonSchema(linkedinSchemas.listChats),
    },
    {
      type: 'function',
      name: 'get_profile_posts',
      description: `Get recent posts from a specific LinkedIn profile ${mode}.`,
      parameters: zodToJsonSchema(linkedinSchemas.getProfilePosts),
    },
    // ========================================
    // EMAIL TOOLS
    // ========================================
    {
      type: 'function',
      name: 'get_meeting_notes',
      description: `Get meeting notes from Gmail ${mode}. Fetches recent emails from the "Meeting Notes" label and parses them.`,
      parameters: zodToJsonSchema(emailSchemas.getMeetingNotes),
    },
    {
      type: 'function',
      name: 'get_email',
      description: `Get a specific email by ID ${mode}.`,
      parameters: zodToJsonSchema(emailSchemas.getEmail),
    },
    {
      type: 'function',
      name: 'search_inbox',
      description: `Search inbox emails by keyword, sender, etc ${mode}. Use this to find relevant context like DocuSign status, NDAs, contracts, or any emails related to a contact.`,
      parameters: zodToJsonSchema(emailSchemas.searchInbox),
    },
    {
      type: 'function',
      name: 'search_sent_emails',
      description: `Search emails you sent ${mode}. Use to check what you've already sent to someone or find your own commitments.`,
      parameters: zodToJsonSchema(emailSchemas.searchSentEmails),
    },
    {
      type: 'function',
      name: 'get_email_history_with_contact',
      description: `Get full email history (sent and received) with a specific contact ${mode}. Returns emails sorted by date with full bodies.`,
      parameters: zodToJsonSchema(emailSchemas.getEmailHistoryWithContact),
    },
    {
      type: 'function',
      name: 'draft_followup_email',
      description: `Draft a follow-up email based on meeting context ${mode}. Requires user approval before sending.`,
      parameters: zodToJsonSchema(emailSchemas.draftFollowupEmail),
    },
    {
      type: 'function',
      name: 'list_email_folders',
      description: `List available email folders/labels ${mode}.`,
      parameters: zodToJsonSchema(emailSchemas.listFolders),
    },
  ];
}

// =============================================================================
// RESPONSES ROUTER
// =============================================================================

/**
 * Tool Router using Responses API with web search support
 */
export class ResponsesRouter {
  private client: ResponsesAPIClient;
  private pendingActions: Map<string, PendingAction> = new Map();
  private tools: FunctionTool[];

  constructor(client: ResponsesAPIClient) {
    this.client = client;
    this.tools = buildFunctionTools();
  }

  /**
   * Process a user message using Responses API
   */
  async process(message: string, context: ConversationContext): Promise<RouterResult> {
    const pendingActions: PendingAction[] = [];
    const toolsCalled: string[] = [];
    const allCitations: Array<{ url: string; title?: string }> = [];
    let webSearchUsed = false;

    // Build initial input with system prompt (Responses API uses type: 'message' with role)
    const input = [
      { type: 'message' as const, role: 'system' as const, content: LINKEDIN_SYSTEM_PROMPT },
      { type: 'message' as const, role: 'user' as const, content: message },
    ];

    let iterations = 0;
    const maxIterations = 10;
    let currentResult = await this.client.createResponse(input, this.tools);

    while (iterations < maxIterations) {
      iterations++;
      console.log(`[ResponsesRouter] Iteration ${iterations}`);

      // Track web search usage
      if (currentResult.webSearchCalls.length > 0) {
        webSearchUsed = true;
        console.log(`[ResponsesRouter] Web search was used (${currentResult.webSearchCalls.length} calls)`);
      }

      // Collect citations
      allCitations.push(...currentResult.citations);

      // If no function calls, we have the final response
      if (currentResult.functionCalls.length === 0) {
        return {
          response: currentResult.outputText || "I couldn't generate a response.",
          pendingActions,
          toolsCalled,
          webSearchUsed,
          citations: allCitations,
        };
      }

      // Process function calls
      const toolOutputs: Array<{ callId: string; output: string }> = [];

      console.log(`[ResponsesRouter] Processing ${currentResult.functionCalls.length} function calls`);

      for (const funcCall of currentResult.functionCalls) {
        const toolName = funcCall.name;
        const args = funcCall.arguments;
        toolsCalled.push(toolName);

        console.log(`[ResponsesRouter] Tool call: ${toolName} (id: ${funcCall.id})`, args);

        // Execute the tool
        const toolResult = await this.executeTool(toolName, args);

        // If tool requires approval, create pending action
        if (toolResult.requiresApproval) {
          const action: PendingAction = {
            id: `action_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            toolName,
            args: args as Record<string, unknown>,
            title: toolResult.approvalTitle || `Execute ${toolName}`,
            description: this.getActionDescription(toolName, args),
            draft: toolResult.draft,
            context: toolResult.context,
          };
          this.pendingActions.set(action.id, action);
          pendingActions.push(action);
        }

        // Collect tool output for submission
        const output = JSON.stringify(toolResult.data || { success: toolResult.success, status: toolResult.requiresApproval ? 'pending_approval' : 'done' });
        console.log(`[ResponsesRouter] Output for ${funcCall.id}: ${output.slice(0, 200)}...`);
        
        toolOutputs.push({
          callId: funcCall.id,
          output,
        });
      }

      // If we have pending actions that need approval, return early
      if (pendingActions.length > 0) {
        return {
          response: currentResult.outputText || 'Actions require approval.',
          pendingActions,
          toolsCalled,
          webSearchUsed,
          citations: allCitations,
        };
      }

      // Log what we're submitting
      console.log(`[ResponsesRouter] Submitting ${toolOutputs.length} tool outputs for response ${currentResult.id}`);

      // Submit tool outputs and continue
      try {
        currentResult = await this.client.submitToolOutputs(
          currentResult.id,
          toolOutputs,
          this.tools
        );
        console.log(`[ResponsesRouter] Got response, ${currentResult.functionCalls.length} more function calls`);
      } catch (error) {
        // If tool output submission fails, log and return what we have
        console.error(`[ResponsesRouter] Failed to submit tool outputs:`, error);
        console.error(`[ResponsesRouter] Tool outputs were:`, toolOutputs.map(o => ({ callId: o.callId, outputLength: o.output.length })));
        
        // Try to return a useful response with the data we gathered
        const gatheredData = toolOutputs
          .map(o => { try { return JSON.parse(o.output); } catch { return null; } })
          .filter(d => d && d.data);
        
        return {
          response: `I gathered context from ${toolsCalled.length} searches. Error processing final response.`,
          pendingActions,
          toolsCalled,
          webSearchUsed,
          citations: allCitations,
        };
      }
    }

    return {
      response: 'I reached the maximum number of steps. Please try a simpler request.',
      pendingActions,
      toolsCalled,
      webSearchUsed,
      citations: allCitations,
    };
  }

  /**
   * Execute a tool by name
   */
  private async executeTool(name: string, args: unknown): Promise<ToolResult> {
    switch (name) {
      // LinkedIn tools
      case 'search_posts_by_keywords':
        return linkedinHandlers.searchPosts(linkedinSchemas.searchPosts.parse(args));
      case 'get_post_details':
        return linkedinHandlers.getPostDetails(linkedinSchemas.getPostDetails.parse(args));
      case 'comment_on_post':
        return linkedinHandlers.commentOnPost(linkedinSchemas.commentOnPost.parse(args));
      case 'like_post':
        return linkedinHandlers.likePost(linkedinSchemas.likePost.parse(args));
      case 'get_profile':
        return linkedinHandlers.getProfile(linkedinSchemas.getProfile.parse(args));
      case 'search_profiles':
        return linkedinHandlers.searchProfiles(linkedinSchemas.searchProfiles.parse(args));
      case 'send_connection_request':
        return linkedinHandlers.sendConnectionRequest(linkedinSchemas.sendConnectionRequest.parse(args));
      case 'send_dm':
        return linkedinHandlers.sendDM(linkedinSchemas.sendDM.parse(args));
      case 'list_chats':
        return linkedinHandlers.listChats(linkedinSchemas.listChats.parse(args));
      case 'get_profile_posts':
        return linkedinHandlers.getProfilePosts(linkedinSchemas.getProfilePosts.parse(args));
      // Email tools
      case 'get_meeting_notes':
        return emailHandlers.getMeetingNotes(emailSchemas.getMeetingNotes.parse(args));
      case 'get_email':
        return emailHandlers.getEmail(emailSchemas.getEmail.parse(args));
      case 'search_inbox':
        return emailHandlers.searchInbox(emailSchemas.searchInbox.parse(args));
      case 'search_sent_emails':
        return emailHandlers.searchSentEmails(emailSchemas.searchSentEmails.parse(args));
      case 'get_email_history_with_contact':
        return emailHandlers.getEmailHistoryWithContact(emailSchemas.getEmailHistoryWithContact.parse(args));
      case 'draft_followup_email':
        return emailHandlers.draftFollowupEmail(emailSchemas.draftFollowupEmail.parse(args));
      case 'list_email_folders':
        return emailHandlers.listFolders(emailSchemas.listFolders.parse(args));
      default:
        return { success: false, error: `Unknown tool: ${name}` };
    }
  }

  /**
   * Generate human-readable description for an action
   */
  private getActionDescription(toolName: string, args: unknown): string {
    const a = args as Record<string, unknown>;
    switch (toolName) {
      case 'comment_on_post':
        return `Comment on post`;
      case 'like_post':
        return `Like this post`;
      case 'send_connection_request':
        return `Send connection request${a.note ? ' with note' : ''}`;
      case 'send_dm':
        return `Send direct message`;
      default:
        return toolName;
    }
  }

  /**
   * Execute an approved action
   */
  async executeAction(actionId: string, editedDraft?: string): Promise<{ success: boolean; message?: string; error?: string }> {
    const action = this.pendingActions.get(actionId);
    if (!action) {
      return { success: false, error: 'Action not found or expired' };
    }

    this.pendingActions.delete(actionId);

    const args = { ...action.args };
    if (editedDraft) {
      if (action.toolName === 'comment_on_post') args.comment = editedDraft;
      if (action.toolName === 'send_connection_request') args.note = editedDraft;
      if (action.toolName === 'send_dm') args.message = editedDraft;
      if (action.toolName === 'draft_followup_email') args.body = editedDraft;
    }

    // Handle email actions
    if (action.toolName === 'draft_followup_email') {
      const result = await emailHandlers.sendEmail({
        to: args.to as string[],
        subject: args.subject as string,
        body: editedDraft || (args.body as string),
      });
      return {
        success: result.success,
        message: result.message,
        error: result.error,
      };
    }

    // Handle LinkedIn actions
    return executeLinkedInAction(action.toolName, args, editedDraft);
  }

  /**
   * Cancel a pending action
   */
  cancelAction(actionId: string): boolean {
    return this.pendingActions.delete(actionId);
  }

  /**
   * Check if web search is enabled
   */
  isWebSearchEnabled(): boolean {
    return this.client.isWebSearchEnabled();
  }
}

/**
 * Create a Responses-based router
 */
export function createResponsesRouter(client: ResponsesAPIClient): ResponsesRouter {
  return new ResponsesRouter(client);
}

