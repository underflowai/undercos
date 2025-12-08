/**
 * Shared data directory configuration
 * Uses DATA_DIR env var for persistence (e.g., Railway volume mount)
 */

import path from 'path';
import fs from 'fs';

// Use env var directly to avoid circular dependency with env.ts
const DATA_DIR = process.env.DATA_DIR || './data';

// Resolve to absolute path
const resolvedDataDir = path.isAbsolute(DATA_DIR) 
  ? DATA_DIR 
  : path.join(process.cwd(), DATA_DIR);

// Ensure directory exists
if (!fs.existsSync(resolvedDataDir)) {
  fs.mkdirSync(resolvedDataDir, { recursive: true });
  console.log(`[DB] Created data directory: ${resolvedDataDir}`);
}

export function getDataDir(): string {
  return resolvedDataDir;
}

export function getDbPath(filename: string): string {
  return path.join(resolvedDataDir, filename);
}

