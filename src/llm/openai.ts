import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool, ChatCompletionToolMessageParam, ChatCompletionAssistantMessageParam } from 'openai/resources/chat/completions';
import { getAgentConfig, type ModelConfig } from '../config/models.js';

/**
 * Tool call from OpenAI response
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

/**
 * Response from OpenAI chat
 */
export interface ChatResponse {
  content: string | null;
  toolCalls?: ToolCall[];
}

/**
 * OpenAI client wrapper with GPT-5.1 support
 */
export class OpenAIClient {
  private client: OpenAI;
  private config: ModelConfig;

  constructor(apiKey: string, configOverride?: Partial<ModelConfig>) {
    this.client = new OpenAI({ apiKey });
    this.config = { ...getAgentConfig(), ...configOverride };
    
    console.log(`[OpenAI] Using model: ${this.config.model}`);
    if (this.config.reasoningEffort) {
      console.log(`[OpenAI] Reasoning effort: ${this.config.reasoningEffort}`);
    }
  }

  /**
   * Send a chat request with optional tools
   */
  async chat(
    messages: Array<{
      role: 'system' | 'user' | 'assistant' | 'tool';
      content: string | null;
      tool_call_id?: string;
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    }>,
    tools?: Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }>
  ): Promise<ChatResponse> {
    // Convert messages to OpenAI format
    const openaiMessages: ChatCompletionMessageParam[] = messages.map((msg) => {
      if (msg.role === 'tool') {
        return {
          role: 'tool',
          content: msg.content || '',
          tool_call_id: msg.tool_call_id || '',
        } as ChatCompletionToolMessageParam;
      }
      if (msg.role === 'assistant' && msg.tool_calls) {
        return {
          role: 'assistant',
          content: msg.content,
          tool_calls: msg.tool_calls,
        } as ChatCompletionAssistantMessageParam;
      }
      return {
        role: msg.role as 'system' | 'user' | 'assistant',
        content: msg.content || '',
      };
    });

    // Convert tools to OpenAI format
    const openaiTools: ChatCompletionTool[] | undefined = tools?.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters as Record<string, unknown>,
      },
    }));

    // Build base request parameters
    const baseParams = {
      model: this.config.model,
      messages: openaiMessages,
      max_completion_tokens: this.config.maxTokens,
      ...(openaiTools && openaiTools.length > 0 ? { tools: openaiTools, tool_choice: 'auto' as const } : {}),
    };

    // GPT-5.1 uses different parameters
    let response;
    if (this.config.model.startsWith('gpt-5')) {
      // GPT-5.1 specific call - temperature is forced to default
      // Note: reasoning parameter may need to be added via API extension
      response = await this.client.chat.completions.create(baseParams);
    } else {
      // Non-GPT-5.1 models
      response = await this.client.chat.completions.create({
        ...baseParams,
        ...(this.config.temperature !== undefined ? { temperature: this.config.temperature } : {}),
      });
    }

    const choice = response.choices[0];
    const message = choice.message;

    // Check for tool calls
    if (message.tool_calls && message.tool_calls.length > 0) {
      const toolCalls: ToolCall[] = message.tool_calls.map((tc: OpenAI.Chat.Completions.ChatCompletionMessageToolCall) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments),
      }));

      return {
        content: message.content,
        toolCalls,
      };
    }

    return {
      content: message.content,
    };
  }

  /**
   * Get the current model being used
   */
  getModel(): string {
    return this.config.model;
  }

  /**
   * Get the full configuration
   */
  getConfig(): ModelConfig {
    return this.config;
  }
}

/**
 * Create an OpenAI client with model config
 */
export function createOpenAIClient(apiKey: string, configOverride?: Partial<ModelConfig>): OpenAIClient {
  return new OpenAIClient(apiKey, configOverride);
}
