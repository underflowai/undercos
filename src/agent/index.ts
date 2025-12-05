// Export only Responses API router (Chat Completions router is deprecated)
export { ResponsesRouter, createResponsesRouter, type PendingAction, type RouterResult } from './responses-router.js';
export * from '../prompts/index.js';

