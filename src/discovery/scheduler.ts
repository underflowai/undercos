type ScheduledTask = {
  id: string;
  name: string;
  intervalMs: number;
  lastRun: Date | null;
  nextRun: Date;
  handler: () => Promise<void>;
  timer: NodeJS.Timeout | null;
};

const tasks: Map<string, ScheduledTask> = new Map();

/**
 * Schedule a recurring task
 */
export function scheduleTask(
  id: string,
  name: string,
  intervalMinutes: number,
  handler: () => Promise<void>
): void {
  // Clear existing task if any
  const existing = tasks.get(id);
  if (existing?.timer) {
    clearInterval(existing.timer);
  }

  const intervalMs = intervalMinutes * 60 * 1000;
  
  const task: ScheduledTask = {
    id,
    name,
    intervalMs,
    lastRun: null,
    nextRun: new Date(Date.now() + intervalMs),
    handler,
    timer: null,
  };

  // Create the interval (no active hours check - slash command triggered)
  task.timer = setInterval(async () => {
    console.log(`[Scheduler] Running: ${name}`);
    task.lastRun = new Date();
    task.nextRun = new Date(Date.now() + intervalMs);

    try {
      await handler();
    } catch (error) {
      console.error(`[Scheduler] Error in ${name}:`, error);
    }
  }, intervalMs);

  tasks.set(id, task);
  console.log(`[Scheduler] Scheduled: ${name} (every ${intervalMinutes} min)`);
}

/**
 * Run a task immediately (for testing or manual trigger)
 */
export async function runTaskNow(id: string): Promise<boolean> {
  const task = tasks.get(id);
  if (!task) return false;

  console.log(`[Scheduler] Manual run: ${task.name}`);
  task.lastRun = new Date();
  
  try {
    await task.handler();
    return true;
  } catch (error) {
    console.error(`[Scheduler] Error in ${task.name}:`, error);
    return false;
  }
}

/**
 * Cancel a scheduled task
 */
export function cancelTask(id: string): boolean {
  const task = tasks.get(id);
  if (!task) return false;

  if (task.timer) {
    clearInterval(task.timer);
  }
  tasks.delete(id);
  console.log(`[Scheduler] Cancelled: ${task.name}`);
  return true;
}

/**
 * Get status of all scheduled tasks
 */
export function getSchedulerStatus(): Array<{
  id: string;
  name: string;
  intervalMinutes: number;
  lastRun: string | null;
  nextRun: string;
}> {
  return Array.from(tasks.values()).map(task => ({
    id: task.id,
    name: task.name,
    intervalMinutes: task.intervalMs / 60000,
    lastRun: task.lastRun?.toISOString() || null,
    nextRun: task.nextRun.toISOString(),
  }));
}

/**
 * Stop all scheduled tasks
 */
export function stopAllTasks(): void {
  for (const task of tasks.values()) {
    if (task.timer) {
      clearInterval(task.timer);
    }
  }
  tasks.clear();
  console.log('[Scheduler] All tasks stopped');
}

