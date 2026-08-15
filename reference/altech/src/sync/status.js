import { store } from '../storage/jsonStore.js';

let syncInFlight = null;

export function isSyncRunning() {
  return Boolean(syncInFlight);
}

export async function getSyncStatus() {
  const snapshot = await store.getSnapshot();
  return {
    ...snapshot.sync,
    dealsCount: snapshot.deals.length,
    stageEventsCount: snapshot.stageEvents.length,
    managersCount: snapshot.managers.length,
    sourcesCount: snapshot.sources.length,
    sourceField: snapshot.sourceField,
    historySync: snapshot.historySync,
    cacheUpdatedAt: snapshot.updatedAt
  };
}

export async function runExclusiveSync(syncFn) {
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async () => {
    await store.updateSync({
      status: 'running',
      lastStartedAt: new Date().toISOString(),
      lastError: null
    });
    try {
      const result = await syncFn();
      await store.updateSync({
        status: 'idle',
        lastSuccessAt: new Date().toISOString(),
        lastError: null,
        warnings: result?.warnings || []
      });
      return result;
    } catch (error) {
      await store.updateSync({
        status: 'error',
        lastError: error.message || 'Sync failed'
      });
      throw error;
    } finally {
      syncInFlight = null;
    }
  })();
  return syncInFlight;
}
