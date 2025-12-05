import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');

export function clearDataDir(): void {
  if (!process.env.CLEAR_DATA_ON_START) return;

  if (!fs.existsSync(DATA_DIR)) return;

  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.db'));
  for (const file of files) {
    try {
      fs.unlinkSync(path.join(DATA_DIR, file));
      console.log(`[Init] Deleted ${file} (CLEAR_DATA_ON_START set)`);
    } catch (err) {
      console.error(`[Init] Failed to delete ${file}:`, err);
    }
  }
}

