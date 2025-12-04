// OpenAI Responses API client
export { ResponsesAPIClient, createResponsesClient, type ResponsesResult, type FunctionTool } from './responses.js';

// Anthropic Claude Opus 4.5 client
export { ClaudeClient, getClaudeClient, initClaudeClient, type ClaudeResponse, type ClaudeMessage, type ClaudeEffort } from './anthropic.js';

// Unified content generator (routes to best provider for the task)
export {
  generateContent,
  generateConnectionNote,
  generateComment,
  generateEmailDraft,
  classifyContent,
  type ContentGenerationResult,
  type GenerateContentOptions,
} from './content-generator.js';

