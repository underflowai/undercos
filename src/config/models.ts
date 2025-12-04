/**
 * Centralized Model Configuration for LinkedIn AI Bot
 * 
 * Supports:
 * - OpenAI GPT-5.1 with adaptive reasoning
 * - Anthropic Claude for writing tasks (excels at natural, human-like content)
 * 
 * Change model selections here to tune performance, cost, and accuracy.
 */

export type ModelProvider = 'openai' | 'anthropic';

export interface ModelConfig {
  provider: ModelProvider;
  model: string;
  temperature?: number;
  maxTokens: number;
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high'; // OpenAI GPT-5.1 only
  promptCacheRetention?: string;
  effort?: 'low' | 'medium' | 'high'; // Anthropic Claude Opus 4.5 extended thinking
}

type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';
type ClaudeEffort = 'low' | 'medium' | 'high';

interface PresetConfig {
  provider: ModelProvider;
  model: string;
  reasoningEffort?: ReasoningEffort;
  temperature: number;
  maxTokens: number;
  effort?: ClaudeEffort; // Claude Opus 4.5 extended thinking effort
}

// ==========================================================================
// PRESETS
// ==========================================================================
const PRESETS: Record<string, PresetConfig> = {
  // ==========================================================================
  // OPENAI PRESETS
  // ==========================================================================
  
  // Best for most cases - fast with light reasoning
  'gpt51_optimized': {
    provider: 'openai',
    model: 'gpt-5.1',
    reasoningEffort: 'low',
    temperature: 0, // Ignored for GPT-5.1
    maxTokens: 4096,
  },
  
  // For complex queries requiring deeper thinking
  'gpt51_deep_reasoning': {
    provider: 'openai',
    model: 'gpt-5.1',
    reasoningEffort: 'medium',
    temperature: 0,
    maxTokens: 8192,
  },
  
  // Fastest/cheapest - no reasoning
  'gpt51_fast': {
    provider: 'openai',
    model: 'gpt-5.1',
    reasoningEffort: 'none',
    temperature: 0,
    maxTokens: 4096,
  },
  
  // Fallback if no GPT-5.1 access
  'gpt4o_fallback': {
    provider: 'openai',
    model: 'gpt-4o',
    temperature: 0.3,
    maxTokens: 4096,
  },
  
  // Cost-optimized
  'gpt4o_mini': {
    provider: 'openai',
    model: 'gpt-4o-mini',
    temperature: 0.3,
    maxTokens: 4096,
  },
  
  // ==========================================================================
  // ANTHROPIC CLAUDE OPUS 4.5 PRESETS
  // ==========================================================================
  // Claude Opus 4.5 is Anthropic's most advanced model - excels at:
  // - Natural, human-like writing (no "AI slop")
  // - Complex reasoning with extended thinking
  // - Multi-step tasks and deep analysis
  
  // Standard effort - good for most writing tasks
  'claude_opus_standard': {
    provider: 'anthropic',
    model: 'claude-opus-4-5-20251101',
    temperature: 1, // Required for extended thinking
    maxTokens: 8192,
    effort: 'medium',
  },
  
  // High effort - for complex reasoning, important messages
  'claude_opus_high': {
    provider: 'anthropic',
    model: 'claude-opus-4-5-20251101',
    temperature: 1,
    maxTokens: 16384,
    effort: 'high',
  },
  
  // Low effort - for quick, simple drafts
  'claude_opus_fast': {
    provider: 'anthropic',
    model: 'claude-opus-4-5-20251101',
    temperature: 1,
    maxTokens: 4096,
    effort: 'low',
  },
};

/**
 * Model configuration for the LinkedIn AI agent
 */
export const MODEL_CONFIG = {
  // ==========================================================================
  // WEB SEARCH
  // ==========================================================================
  // Enable web_search tool in Responses API for real-time information
  ENABLE_WEB_SEARCH: true,
  
  // ==========================================================================
  // LINKEDIN AGENT (tool orchestration, search, classification)
  // ==========================================================================
  // Recommended: gpt-5.1 with reasoning_effort="low" (balanced)
  AGENT_PROVIDER: 'openai' as ModelProvider,
  AGENT_MODEL: 'gpt-5.1' as string,
  AGENT_REASONING_EFFORT: 'low' as ReasoningEffort,
  AGENT_TEMPERATURE: 0.3,
  AGENT_MAX_TOKENS: 4096,
  
  // ==========================================================================
  // CONTENT WRITING (connection notes, comments, emails)
  // ==========================================================================
  // Claude Opus 4.5 excels at natural, human-like writing - avoids "AI slop"
  // Options: 'claude_opus_standard', 'claude_opus_high', 'claude_opus_fast', 'gpt51_deep_reasoning'
  // Using 'high' for important emails - Brian LaManna principle: "quality over quantity"
  WRITING_PRESET: 'claude_opus_high' as string,
  
  // ==========================================================================
  // PROMPT CACHING
  // ==========================================================================
  ENABLE_PROMPT_CACHING: true,
  PROMPT_CACHE_RETENTION: '24h',
  
  // Presets reference
  PRESETS,
  
  // Active preset for agent (null = use individual settings above)
  ACTIVE_PRESET: 'gpt51_optimized' as string | null,
};

/**
 * Get configuration for content generation (comments, connection notes, emails)
 * Uses Claude Opus 4.5 for more natural, human-like writing
 */
export function getContentGenerationConfig(): ModelConfig {
  const presetName = MODEL_CONFIG.WRITING_PRESET;
  const preset = PRESETS[presetName];
  
  if (preset) {
    return {
      provider: preset.provider,
      model: preset.model,
      temperature: preset.temperature,
      maxTokens: preset.maxTokens,
      effort: preset.effort, // Claude Opus 4.5 extended thinking
      reasoningEffort: preset.reasoningEffort, // OpenAI reasoning
    };
  }
  
  // Default to GPT-5.1 with high reasoning if preset not found
  return {
    provider: 'openai',
    model: 'gpt-5.1',
    maxTokens: 2048,
    reasoningEffort: 'high',
    promptCacheRetention: MODEL_CONFIG.PROMPT_CACHE_RETENTION,
  };
}

/**
 * Get the current agent configuration
 */
export function getAgentConfig(): ModelConfig {
  if (MODEL_CONFIG.ACTIVE_PRESET && PRESETS[MODEL_CONFIG.ACTIVE_PRESET]) {
    const preset = PRESETS[MODEL_CONFIG.ACTIVE_PRESET];
    const config: ModelConfig = {
      provider: preset.provider,
      model: preset.model,
      temperature: preset.temperature,
      maxTokens: preset.maxTokens,
    };
    
    // Add reasoning effort for GPT-5.1 models
    if (preset.model.startsWith('gpt-5') && preset.reasoningEffort) {
      config.reasoningEffort = preset.reasoningEffort;
    }
    
    // Add effort for Claude Opus 4.5 extended thinking
    if (preset.provider === 'anthropic' && preset.effort) {
      config.effort = preset.effort;
    }
    
    // Add prompt caching for GPT-5.1
    if (MODEL_CONFIG.ENABLE_PROMPT_CACHING && preset.model.startsWith('gpt-5')) {
      config.promptCacheRetention = MODEL_CONFIG.PROMPT_CACHE_RETENTION;
    }
    
    return config;
  }
  
  // Use individual settings
  const config: ModelConfig = {
    provider: MODEL_CONFIG.AGENT_PROVIDER,
    model: MODEL_CONFIG.AGENT_MODEL,
    temperature: MODEL_CONFIG.AGENT_TEMPERATURE,
    maxTokens: MODEL_CONFIG.AGENT_MAX_TOKENS,
  };
  
  if (MODEL_CONFIG.AGENT_MODEL.startsWith('gpt-5')) {
    config.reasoningEffort = MODEL_CONFIG.AGENT_REASONING_EFFORT;
    if (MODEL_CONFIG.ENABLE_PROMPT_CACHING) {
      config.promptCacheRetention = MODEL_CONFIG.PROMPT_CACHE_RETENTION;
    }
  }
  
  return config;
}

/**
 * Print current configuration (for debugging)
 */
export function printModelConfig(): void {
  const config = getAgentConfig();
  console.log('\n' + '='.repeat(50));
  console.log('LINKEDIN AI MODEL CONFIGURATION');
  console.log('='.repeat(50));
  
  if (MODEL_CONFIG.ACTIVE_PRESET) {
    console.log(`Using Preset: ${MODEL_CONFIG.ACTIVE_PRESET}`);
  } else {
    console.log('Using Custom Configuration');
  }
  
  console.log(`\nModel: ${config.model}`);
  if (config.reasoningEffort) {
    console.log(`Reasoning Effort: ${config.reasoningEffort}`);
  }
  console.log(`Temperature: ${config.temperature}`);
  console.log(`Max Tokens: ${config.maxTokens}`);
  if (config.promptCacheRetention) {
    console.log(`Prompt Caching: ${config.promptCacheRetention}`);
  }
  console.log('='.repeat(50) + '\n');
}

// ==========================================================================
// MODEL INFORMATION (for reference)
// ==========================================================================

export const MODEL_INFO = {
  // OpenAI Models
  'gpt-5.1': {
    provider: 'openai',
    description: 'Flagship GPT-5.1 with adaptive reasoning',
    contextWindow: '≈400k combined tokens (128k max output)',
    costPer1mInput: '$1.25',
    costPer1mInputCached: '$0.125 (90% discount)',
    costPer1mOutput: '$10.00',
    bestFor: 'Agentic workflows, complex reasoning, tool orchestration',
  },
  'gpt-4o': {
    provider: 'openai',
    description: 'Latest GPT-4 Optimized model',
    contextWindow: '128k tokens',
    costPer1mInput: '$2.50',
    costPer1mOutput: '$10.00',
    bestFor: 'High accuracy if no GPT-5.1 access',
  },
  'gpt-4o-mini': {
    provider: 'openai',
    description: 'Smaller, faster GPT-4 model',
    contextWindow: '128k tokens',
    costPer1mInput: '$0.15',
    costPer1mOutput: '$0.60',
    bestFor: 'Cost-sensitive applications, simple tasks',
  },
  
  // Anthropic Claude Opus 4.5
  'claude-opus-4-5-20251101': {
    provider: 'anthropic',
    description: 'Anthropic\'s most advanced model with hybrid reasoning',
    contextWindow: '200k tokens',
    maxOutput: '64k tokens',
    costPer1mInput: '$15.00',
    costPer1mOutput: '$75.00',
    bestFor: 'Natural writing, complex reasoning, connection notes, emails',
    features: [
      'Extended thinking mode (effort: low/medium/high)',
      'Hybrid reasoning architecture',
      'Best-in-class writing quality',
      'Deep multi-step analysis',
    ],
  },
};

// ==========================================================================
// REASONING EFFORT GUIDE
// ==========================================================================

export const REASONING_EFFORT_GUIDE = {
  none: {
    description: 'Fast, non-reasoning mode (like GPT-4o)',
    useWhen: ['Simple tool calls', 'Straightforward searches', 'High volume'],
  },
  low: {
    description: 'Light reasoning for most tasks',
    useWhen: ['Query expansion', 'Comment drafting', 'Profile analysis'],
  },
  medium: {
    description: 'Moderate reasoning for complex tasks',
    useWhen: ['Multi-step planning', 'Complex engagement strategies'],
  },
  high: {
    description: 'Deep reasoning (use sparingly)',
    useWhen: ['Very complex multi-turn interactions'],
  },
};
