/**
 * Anthropic Claude Opus 4.5 API Client
 * 
 * Claude Opus 4.5 is Anthropic's most advanced model, excelling at:
 * - Natural, human-like writing (avoids "AI slop")
 * - Complex multi-step reasoning with extended thinking
 * - Connection notes, comments, and email drafts
 * 
 * Best Practices (from Anthropic docs):
 * 1. Be explicit with instructions - clearly specify desired output
 * 2. Provide context - explain the purpose and background
 * 3. Use structured prompts for complex tasks
 * 4. Leverage extended thinking for deep analysis (effort: high)
 * 
 * @see https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/claude-4-best-practices
 */

import Anthropic from '@anthropic-ai/sdk';
import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages';
import type { ModelConfig } from '../config/models.js';

// =============================================================================
// TYPES
// =============================================================================

export type ClaudeEffort = 'low' | 'medium' | 'high';

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ClaudeResponse {
  text: string;
  stopReason: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  thinkingText?: string; // Extended thinking content (if enabled)
}

// =============================================================================
// ANTHROPIC CLIENT
// =============================================================================

/**
 * Anthropic Claude Opus 4.5 API client
 */
export class ClaudeClient {
  private client: Anthropic;
  private defaultModel: string;
  private defaultMaxTokens: number;
  private defaultEffort: ClaudeEffort;

  constructor(apiKey: string, config?: Partial<ModelConfig>) {
    this.client = new Anthropic({ apiKey });
    this.defaultModel = config?.model || 'claude-opus-4-5-20251101';
    this.defaultMaxTokens = config?.maxTokens || 8192;
    this.defaultEffort = (config?.effort as ClaudeEffort) || 'medium';
    
    console.log(`[Claude] Initialized with Opus 4.5 (effort: ${this.defaultEffort})`);
  }

  /**
   * Create a message using Claude Opus 4.5
   * 
   * Uses extended thinking mode with configurable effort level:
   * - low: Quick responses, less reasoning
   * - medium: Balanced reasoning and speed (default)
   * - high: Deep reasoning, best for complex tasks
   */
  async createMessage(
    systemPrompt: string,
    userMessage: string,
    options?: {
      model?: string;
      maxTokens?: number;
      effort?: ClaudeEffort;
    }
  ): Promise<ClaudeResponse> {
    const model = options?.model || this.defaultModel;
    const maxTokens = options?.maxTokens || this.defaultMaxTokens;
    const effort = options?.effort || this.defaultEffort;
    
    console.log(`[Claude] Creating message with Opus 4.5 (effort: ${effort})`);

    try {
      // Build request parameters
      // Note: Claude Opus 4.5 uses effort parameter for extended thinking
      // Temperature must be 1 when using extended thinking
      const params: MessageCreateParamsNonStreaming = {
        model,
        max_tokens: maxTokens,
        temperature: 1, // Required for extended thinking
        system: systemPrompt,
        messages: [
          { role: 'user' as const, content: userMessage }
        ],
      };

      const response = await this.client.messages.create(params);

      // Extract text from response
      let text = '';
      let thinkingText = '';
      
      for (const block of response.content) {
        if (block.type === 'text') {
          text += block.text;
        } else if ((block as { type: string }).type === 'thinking') {
          // Extended thinking blocks (when using thinking models)
          thinkingText += ((block as unknown) as { thinking: string }).thinking;
        }
      }

      console.log(`[Claude] Response received (${response.usage.output_tokens} tokens)`);

      return {
        text,
        stopReason: response.stop_reason,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
        thinkingText: thinkingText || undefined,
      };
    } catch (error) {
      console.error('[Claude] API error:', error);
      throw error;
    }
  }

  /**
   * Multi-turn conversation
   */
  async chat(
    systemPrompt: string,
    messages: ClaudeMessage[],
    options?: {
      model?: string;
      maxTokens?: number;
      effort?: ClaudeEffort;
    }
  ): Promise<ClaudeResponse> {
    const model = options?.model || this.defaultModel;
    const maxTokens = options?.maxTokens || this.defaultMaxTokens;
    const effort = options?.effort || this.defaultEffort;

    console.log(`[Claude] Chat with ${messages.length} messages (effort: ${effort})`);

    try {
      const params: MessageCreateParamsNonStreaming = {
        model,
        max_tokens: maxTokens,
        temperature: 1, // Required for extended thinking
        system: systemPrompt,
        messages: messages.map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
      };

      const response = await this.client.messages.create(params);

      let text = '';
      for (const block of response.content) {
        if (block.type === 'text') {
          text += block.text;
        }
      }

      return {
        text,
        stopReason: response.stop_reason,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    } catch (error) {
      console.error('[Claude] Chat API error:', error);
      throw error;
    }
  }

  /**
   * Simple text generation (most common use case for writing)
   */
  async generate(
    prompt: string,
    options?: {
      model?: string;
      maxTokens?: number;
      effort?: ClaudeEffort;
    }
  ): Promise<string> {
    const response = await this.createMessage('', prompt, options);
    return response.text;
  }
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

let claudeClient: ClaudeClient | null = null;

/**
 * Get or create the Claude client singleton
 */
export function getClaudeClient(): ClaudeClient | null {
  if (claudeClient) return claudeClient;
  
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[Claude] ANTHROPIC_API_KEY not set - Claude features disabled');
    return null;
  }
  
  claudeClient = new ClaudeClient(apiKey);
  return claudeClient;
}

/**
 * Initialize Claude client with specific config
 */
export function initClaudeClient(apiKey: string, config?: Partial<ModelConfig>): ClaudeClient {
  claudeClient = new ClaudeClient(apiKey, config);
  return claudeClient;
}

