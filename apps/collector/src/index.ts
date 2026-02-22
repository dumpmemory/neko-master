import { config } from 'dotenv';
import path from 'path';
import fs from 'fs';
import { isAgentBackendUrl } from '@neko-master/shared';

// Load .env.local if it exists (takes precedence over .env, but not shell)
const envLocalPath = path.join(process.cwd(), '.env.local');
if (fs.existsSync(envLocalPath)) {
  config({ path: envLocalPath });
}

// Load .env (defaults)
config();

import { StatsDatabase, BackendConfig } from './modules/db/db.js';
import { createCollector, GatewayCollector } from './modules/collector/gateway.collector.js';
import { createSurgeCollector, SurgeCollector } from './modules/collector/surge.collector.js';
import { StatsWebSocketServer } from './modules/websocket/websocket.server.js';
import { realtimeStore } from './modules/realtime/realtime.store.js';
import { SurgePolicySyncService } from './modules/surge/surge-policy-sync.js';

let wsServer: StatsWebSocketServer;

import { APIServer } from './modules/app/app.js';
import { GeoIPService } from './modules/geo/geo.service.js';
import { StatsService } from './modules/stats/index.js';
import {
  ensureClickHouseReady,
  ensureClickHouseSchema,
  formatClickHouseConfigForLog,
  loadClickHouseConfig,
} from './modules/clickhouse/clickhouse.config.js';
import { ClickHouseCompareService } from './modules/clickhouse/clickhouse.compare.js';

const COLLECTOR_WS_PORT = parseInt(process.env.COLLECTOR_WS_PORT || '3002');
const API_PORT = parseInt(process.env.API_PORT || '3001');
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'stats.db');

// Map of backend connections: backendId -> GatewayCollector | SurgeCollector
const collectors = new Map<number, GatewayCollector | SurgeCollector>();
let db: StatsDatabase;

let apiServer: APIServer;
let geoService: GeoIPService;
let policySyncService: SurgePolicySyncService;
let clickHouseCompareService: ClickHouseCompareService;

// Track last known backend configs to detect changes
let lastBackendConfigs: Map<number, BackendConfig> = new Map();

async function main() {
  console.log('[Main] Starting collector service...');

  const clickHouseConfig = loadClickHouseConfig();
  console.info(`[Main] ClickHouse config: ${formatClickHouseConfigForLog(clickHouseConfig)}`);
  await ensureClickHouseReady(clickHouseConfig);
  await ensureClickHouseSchema(clickHouseConfig);

  // Initialize database
  console.log('[Main] Initializing database at:', DB_PATH);
  db = new StatsDatabase(DB_PATH);

  // Connect realtimeStore to database for agent config persistence
  realtimeStore.setDatabase(db);

  clickHouseCompareService = new ClickHouseCompareService(db);
  clickHouseCompareService.start();

  // Initialize GeoIP service
  geoService = new GeoIPService(db);

  // Initialize WebSocket server for real-time updates
  console.log('[Main] Starting WebSocket server on port', COLLECTOR_WS_PORT);
  const statsService = new StatsService(db, realtimeStore);
  wsServer = new StatsWebSocketServer(COLLECTOR_WS_PORT, db, statsService);
  wsServer.start();

  // Initialize policy sync service
  policySyncService = new SurgePolicySyncService(db);

  // Initialize API server
  console.log('[Main] Starting API server on port', API_PORT);
  apiServer = new APIServer(
    API_PORT,
    db,
    realtimeStore,
    policySyncService,
    geoService,
    (backendId: number) => {
      wsServer.broadcastStats(backendId);
    },
    (backendId: number) => {
      const collector = collectors.get(backendId) as
        | (GatewayCollector & { clearRuntimeState?: () => void })
        | (SurgeCollector & { clearRuntimeState?: () => void })
        | undefined;
      collector?.clearRuntimeState?.();
      wsServer.clearBackendCache(backendId);
      wsServer.broadcastStats(backendId, true);
    },
  );
  apiServer.start();

  // Start backend management loop
  console.log('[Main] Starting backend management loop...');
  manageBackends();

  // Check for backend config changes every 5 seconds
  setInterval(manageBackends, 5000);

  // Auto-cleanup: enforce data retention policy
  function runAutoCleanup() {
    try {
      const config = db.getRetentionConfig();
      if (!config.autoCleanup) return;

      const connCutoff = new Date(Date.now() - config.connectionLogsDays * 86400000).toISOString();
      const hourlyCutoff = new Date(Date.now() - config.hourlyStatsDays * 86400000).toISOString();

      const deletedLogs = db.deleteOldMinuteStats(connCutoff);
      const deletedHourly = db.deleteOldHourlyStats(hourlyCutoff);

      if (deletedLogs > 0 || deletedHourly > 0) {
        console.log(`[Cleanup] Deleted ${deletedLogs} connection logs, ${deletedHourly} hourly stats`);
      }
    } catch (err) {
      console.error('[Cleanup] Auto-cleanup failed:', err);
    }
  }

  // First cleanup 30 seconds after startup, then every 6 hours
  setTimeout(runAutoCleanup, 30000);
  setInterval(runAutoCleanup, 6 * 60 * 60 * 1000);

  // Handle graceful shutdown
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Manage backend connections based on database configuration
async function manageBackends() {
  try {
    // Get current backend configs from database
    const backends = db.getAllBackends();
    const currentConfigs = new Map(backends.map(b => [b.id, b]));

    // Find backends that need to be started (listening=true but not connected)
    for (const backend of backends) {
      const existingCollector = collectors.get(backend.id);
      const lastConfig = lastBackendConfigs.get(backend.id);
      const isAgentBackend = isAgentBackendUrl(backend.url);

      // Check if we need to start or restart this backend connection
      const needsStart = backend.listening && backend.enabled && !existingCollector && !isAgentBackend;
      const needsRestart = existingCollector && lastConfig && (
        lastConfig.url !== backend.url ||
        lastConfig.token !== backend.token ||
        lastConfig.type !== backend.type ||
        lastConfig.listening !== backend.listening ||
        lastConfig.enabled !== backend.enabled
      );

      if (needsRestart) {
        console.log(`[Backends] Restarting collector for backend "${backend.name}" (ID: ${backend.id}) due to config change`);
        stopCollector(backend.id);
      }

      if (needsStart || needsRestart) {
        if (backend.listening && backend.enabled && !isAgentBackend) {
          startCollector(backend);
        }
      }

      // Stop collectors for backends that are no longer listening or disabled
      if (existingCollector && (!backend.listening || !backend.enabled)) {
        console.log(`[Backends] Stopping collector for backend "${backend.name}" (ID: ${backend.id}) - listening=${backend.listening}, enabled=${backend.enabled}`);
        stopCollector(backend.id);
      }
    }

    // Stop collectors for deleted backends
    for (const [id, collector] of collectors) {
      if (!currentConfigs.has(id)) {
        console.log(`[Backends] Stopping collector for deleted backend (ID: ${id})`);
        stopCollector(id);
      }
    }

    // Update last known configs
    lastBackendConfigs = currentConfigs;
  } catch (error) {
    console.error('[Backends] Error managing backends:', error);
  }
}

// Start a collector for a specific backend
function startCollector(backend: BackendConfig) {
  if (isAgentBackendUrl(backend.url)) {
    console.log(`[Collector] Backend "${backend.name}" (ID: ${backend.id}) is agent mode, skip direct pulling`);
    return;
  }

  if (collectors.has(backend.id)) {
    console.log(`[Collector] Backend "${backend.name}" (ID: ${backend.id}) already has a collector running`);
    return;
  }

  console.log(`[Collector] Starting ${backend.type || 'clash'} collector for backend "${backend.name}" (ID: ${backend.id}) at ${backend.url}`);

  if (backend.type === 'surge') {
    // Start policy sync service for Surge
    const baseUrl = backend.url.replace(/\/$/, '');
    policySyncService.startSync(backend.id, baseUrl, backend.token || undefined);

    // Create and start Surge collector (REST API polling)
    const collector = createSurgeCollector(
      db,
      backend.url,
      backend.token || undefined,
      geoService,
      () => {
        // Broadcast stats update via WebSocket when new data arrives
        wsServer.broadcastStats(backend.id);
      },
      backend.id // Pass backend ID for data isolation
    );

    collectors.set(backend.id, collector);
    collector.start();
  } else {
    // Create and start Clash collector (WebSocket)
    let wsUrl = backend.url.replace(/^http:\/\//, 'ws://').replace(/^https:\/\//, 'wss://');
    if (!wsUrl.endsWith('/connections')) {
      wsUrl = `${wsUrl}/connections`;
    }

    const collector = createCollector(
      db,
      wsUrl,
      backend.token || undefined,
      geoService,
      () => {
        // Broadcast stats update via WebSocket when new data arrives
        wsServer.broadcastStats(backend.id);
      },
      backend.id // Pass backend ID for data isolation
    );

    collectors.set(backend.id, collector);
    collector.connect();
  }
}

// Stop a collector for a specific backend
function stopCollector(backendId: number) {
  const collector = collectors.get(backendId);
  if (collector) {
    console.log(`[Collector] Stopping collector for backend ID: ${backendId}`);
    if (collector instanceof GatewayCollector) {
      collector.disconnect();
    } else {
      collector.stop();
    }
    collectors.delete(backendId);
  }
  
  // Also stop policy sync for this backend
  policySyncService.stopSync(backendId);
}

// Graceful shutdown
function shutdown() {
  console.log('[Main] Shutting down...');

  // Stop all collectors and policy sync
  for (const [id, collector] of collectors) {
    console.log(`[Main] Disconnecting collector for backend ID: ${id}`);
    if (collector instanceof GatewayCollector) {
      collector.disconnect();
    } else {
      collector.stop();
    }
    policySyncService.stopSync(id);
  }
  collectors.clear();

  // Stop servers
  wsServer?.stop();
  apiServer?.stop();
  clickHouseCompareService?.stop();
  geoService?.destroy();

  // Close database
  db?.close();

  console.log('[Main] Shutdown complete');
  process.exit(0);
}

main().catch(console.error);
