import fs from 'fs';
import path from 'path';
import { getDataDir } from '../db/data-dir.js';

export function clearDataDir(): void {
  if (!process.env.CLEAR_DATA_ON_START) return;

  const dataDir = getDataDir();
  if (!fs.existsSync(dataDir)) return;

  const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.db'));
  for (const file of files) {
    try {
      fs.unlinkSync(path.join(dataDir, file));
      console.log(`[Init] Deleted ${file} (CLEAR_DATA_ON_START set)`);
    } catch (err) {
      console.error(`[Init] Failed to delete ${file}:`, err);
    }
  }
}

