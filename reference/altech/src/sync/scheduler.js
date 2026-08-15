import { config } from '../config.js';
import { fullSync } from './fullSync.js';
import { runExclusiveSync } from './status.js';

export function startSyncScheduler(options = {}) {
  const immediate = options.immediate !== false;
  const enabled = process.env.BI_SYNC_ENABLED !== '0';
  if (!enabled) return null;
  if (!config.vibeApiKey) {
    console.warn('BI sync scheduler skipped: VIBE_API_KEY is not set');
    return null;
  }

  const run = () => {
    runExclusiveSync(() => fullSync()).catch((error) => {
      console.error('BI sync failed:', error.message || error);
    });
  };

  if (immediate) {
    const delayMs = Number(process.env.BI_INITIAL_SYNC_DELAY_MS || 1500);
    const initialTimer = setTimeout(run, delayMs);
    initialTimer.unref?.();
  }

  const timer = setInterval(run, config.syncIntervalMs);
  timer.unref?.();
  return timer;
}
