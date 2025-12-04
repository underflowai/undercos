/**
 * OpenAI Responses API Client
 * 
 * This client uses the Responses API which supports hosted tools like web_search.
 * Unlike Chat Completions, Responses API has a different format:
 * - Uses `input` instead of `messages`
 * - Returns `output` items instead of `choices`
 * - Supports `web_search` as a built-in tool
 * 
 * @see https://platform.openai.com/docs/api-reference/responses
 */

import OpenAI from 'openai';
import { getAgentConfig, type ModelConfig } from '../config/models.js';

// =============================================================================
// TYPES
// =============================================================================

export interface FunctionTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface WebSearchTool {
  type: 'web_search';
  user_location?: {
    type: 'approximate';
    country?: string;
    city?: string;
    region?: string;
  };
}

export type Tool = FunctionTool | WebSearchTool;

export interface FunctionToolCall {
  type: 'function_call';
  id: string;
  name: string;
  arguments: unknown;
}

export interface WebSearchCall {
  type: 'web_search_call';
  id: string;
  status: string;
}

export interface Message {
  type: 'message';
  role: string;
  content: Array<{
    type: string;
    text?: string;
    annotations?: Array<{
      type: string;
      url?: string;
      title?: string;
      start_index?: number;
      end_index?: number;
    }>;
  }>;
}

export type OutputItem = FunctionToolCall | WebSearchCall | Message;

export interface ResponsesResult {
  id: string;
  outputText: string | null;
  outputItems: OutputItem[];
  functionCalls: FunctionToolCall[];
  webSearchCalls: WebSearchCall[];
  citations: Array<{ url: string; title?: string; startIndex?: number; endIndex?: number }>;
}

// =============================================================================
// INPUT ITEM TYPES
// Responses API uses 'message' type with 'role' field
// =============================================================================

interface MessageInput {
  type: 'message';
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface FunctionCallInput {
  type: 'function_call';
  id: string;
  name: string;
  arguments: string;
}

interface FunctionCallOutputInput {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

type InputItem = MessageInput | FunctionCallInput | FunctionCallOutputInput;

// =============================================================================
// RESPONSES API CLIENT
// =============================================================================

/**
 * OpenAI Responses API client with web search support
 */
export class ResponsesAPIClient {
  private client: OpenAI;
  private config: ModelConfig;
  private enableWebSearch: boolean;

  constructor(apiKey: string, options?: { configOverride?: Partial<ModelConfig>; enableWebSearch?: boolean }) {
    this.client = new OpenAI({ apiKey });
    this.config = { ...getAgentConfig(), ...options?.configOverride };
    this.enableWebSearch = options?.enableWebSearch ?? true;
    
    console.log(`[ResponsesAPI] Using model: ${this.config.model}`);
    console.log(`[ResponsesAPI] Web search: ${this.enableWebSearch ? 'enabled' : 'disabled'}`);
    if (this.config.reasoningEffort) {
      console.log(`[ResponsesAPI] Reasoning effort: ${this.config.reasoningEffort}`);
    }
  }

  /**
   * Create a response using the Responses API
   * 
   * @param input - The input text or array of input items
   * @param tools - Array of tools (functions + optional web_search)
   * @param options - Optional config overrides or previous response ID
   */
  async createResponse(
    input: string | InputItem[],
    tools?: FunctionTool[],
    options?: string | { 
      previousResponseId?: string; 
      reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
      useWebSearch?: boolean;  // Override web search setting for this call
    }
  ): Promise<ResponsesResult> {
    // Handle backward compatibility: options can be string (previousResponseId) or object
    const previousResponseId = typeof options === 'string' ? options : options?.previousResponseId;
    const reasoningOverride = typeof options === 'object' ? options?.reasoningEffort : undefined;
    const webSearchOverride = typeof options === 'object' ? options?.useWebSearch : undefined;
    
    // Build tools array - add web_search if enabled (check override first, then instance setting)
    const allTools: Array<Record<string, unknown>> = [];
    const shouldUseWebSearch = webSearchOverride !== undefined ? webSearchOverride : this.enableWebSearch;
    
    if (shouldUseWebSearch) {
      allTools.push({ type: 'web_search' });
    }
    
    // Add function tools
    if (tools && tools.length > 0) {
      for (const tool of tools) {
        allTools.push({
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        });
      }
    }

    // Build request body
    const requestBody: Record<string, unknown> = {
      model: this.config.model,
      input,
      max_output_tokens: this.config.maxTokens,
    };

    // Add tools if any
    if (allTools.length > 0) {
      requestBody.tools = allTools;
      requestBody.tool_choice = 'auto';
    }

    // Add reasoning effort for GPT-5.1 (use override if provided)
    const effectiveReasoning = reasoningOverride || this.config.reasoningEffort;
    if (this.config.model.startsWith('gpt-5') && effectiveReasoning) {
      requestBody.reasoning = { effort: effectiveReasoning };
      if (reasoningOverride) {
        console.log(`[ResponsesAPI] Using reasoning effort override: ${reasoningOverride}`);
      }
    }

    // Add previous response ID for multi-turn
    if (previousResponseId) {
      requestBody.previous_response_id = previousResponseId;
    }

    // Make the API call using fetch since responses isn't in the SDK types yet
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.client.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Responses API error (${response.status}): ${JSON.stringify(error)}`);
    }

    const data = await response.json() as {
      id: string;
      output_text?: string;
      output?: Array<Record<string, unknown>>;
    };

    // Debug: log the raw response structure
    console.log(`[ResponsesAPI] Raw response keys: ${Object.keys(data).join(', ')}`);
    if (data.output) {
      console.log(`[ResponsesAPI] Output items: ${data.output.length}, types: ${data.output.map(o => o.type).join(', ')}`);
    }

    // Process output items
    const result: ResponsesResult = {
      id: data.id,
      outputText: null, // Will be extracted from output messages
      outputItems: [],
      functionCalls: [],
      webSearchCalls: [],
      citations: [],
    };

    // Process output array
    if (data.output && Array.isArray(data.output)) {
      for (const item of data.output) {
        if (item.type === 'function_call') {
          const funcCall: FunctionToolCall = {
            type: 'function_call',
            id: item.id as string,
            name: item.name as string,
            arguments: typeof item.arguments === 'string' 
              ? JSON.parse(item.arguments) 
              : item.arguments,
          };
          result.functionCalls.push(funcCall);
          result.outputItems.push(funcCall);
        } else if (item.type === 'web_search_call') {
          const webCall: WebSearchCall = {
            type: 'web_search_call',
            id: item.id as string,
            status: (item.status as string) || 'completed',
          };
          result.webSearchCalls.push(webCall);
          result.outputItems.push(webCall);
        } else if (item.type === 'message') {
          const msg = item as unknown as Message;
          result.outputItems.push(msg);
          
          // Extract text and citations from message content
          if (msg.content) {
            for (const content of msg.content) {
              // Extract text
              if (content.type === 'output_text' || content.type === 'text') {
                if (content.text) {
                  result.outputText = (result.outputText || '') + content.text;
                }
              }
              
              // Extract citations
              if (content.annotations) {
                for (const annotation of content.annotations) {
                  if (annotation.type === 'url_citation' && annotation.url) {
                    result.citations.push({
                      url: annotation.url,
                      title: annotation.title,
                      startIndex: annotation.start_index,
                      endIndex: annotation.end_index,
                    });
                  }
                }
              }
            }
          }
        }
      }
    }

    // Fallback to top-level output_text if no text found in messages
    if (!result.outputText && data.output_text) {
      result.outputText = data.output_text;
    }

    console.log(`[ResponsesAPI] Extracted text: "${result.outputText?.slice(0, 100) || '(none)'}..."`);

    return result;
  }

  /**
   * Submit function call results and get next response
   * Used in tool-calling loop
   */
  async submitToolOutputs(
    previousResponseId: string,
    toolOutputs: Array<{ callId: string; output: string }>,
    tools?: FunctionTool[]
  ): Promise<ResponsesResult> {
    // Build input with function call outputs
    const input: FunctionCallOutputInput[] = toolOutputs.map(output => ({
      type: 'function_call_output' as const,
      call_id: output.callId,
      output: output.output,
    }));

    return this.createResponse(input, tools, previousResponseId);
  }

  /**
   * Simple web search query (no function tools)
   * Returns just the text response with citations
   */
  async webSearch(query: string): Promise<{ text: string; citations: Array<{ url: string; title?: string }> }> {
    const result = await this.createResponse(query, undefined);
    
    return {
      text: result.outputText || '',
      citations: result.citations,
    };
  }

  /**
   * Convert chat-style messages to Responses API input format
   */
  static convertMessagesToInput(messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    tool_call_id?: string;
    tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  }>): InputItem[] {
    const input: InputItem[] = [];
    
    for (const msg of messages) {
      if (msg.role === 'system' || msg.role === 'user' || msg.role === 'assistant') {
        // Responses API uses type: 'message' with role field
        if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
          // Add function calls first
          for (const tc of msg.tool_calls) {
            input.push({
              type: 'function_call',
              id: tc.id,
              name: tc.function.name,
              arguments: tc.function.arguments,
            });
          }
        }
        if (msg.content) {
          input.push({ type: 'message', role: msg.role, content: msg.content });
        }
      } else if (msg.role === 'tool' && msg.tool_call_id) {
        input.push({
          type: 'function_call_output',
          call_id: msg.tool_call_id,
          output: msg.content || '',
        });
      }
    }
    
    return input;
  }

  /**
   * Get the current model being used
   */
  getModel(): string {
    return this.config.model;
  }

  /**
   * Check if web search is enabled
   */
  isWebSearchEnabled(): boolean {
    return this.enableWebSearch;
  }
}

/**
 * Create a Responses API client
 */
export function createResponsesClient(
  apiKey: string, 
  options?: { configOverride?: Partial<ModelConfig>; enableWebSearch?: boolean }
): ResponsesAPIClient {
  return new ResponsesAPIClient(apiKey, options);
}

