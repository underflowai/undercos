import { z } from 'zod';

/**
 * Tool definition for the LLM
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: z.ZodObject<z.ZodRawShape>;
}

/**
 * Result from executing a tool
 */
export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  message?: string;
  /** If true, this action needs user approval before executing */
  requiresApproval?: boolean;
  /** Human-readable title for the approval UI */
  approvalTitle?: string;
  /** Draft content that the user can edit */
  draft?: string;
  /** Additional context (URL, etc.) */
  context?: string;
}

/**
 * Tool handler function type
 */
export type ToolHandler<T extends z.ZodObject<z.ZodRawShape>> = (
  args: z.infer<T>
) => Promise<ToolResult>;

/**
 * Registered tool with handler
 */
export interface Tool extends ToolDefinition {
  handler: ToolHandler<z.ZodObject<z.ZodRawShape>>;
}

