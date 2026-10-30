import { execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function createWarehouseRefreshManager({
  projectRoot,
  dataDir,
  intervalMinutes = Number(process.env.WAREHOUSE_REFRESH_INTERVAL_MINUTES || 15),
  enabled = process.env.WAREHOUSE_REFRESH_ENABLED !== 'false',
}) {
  const scriptPath = path.join(projectRoot, 'scripts', 'build-warehouse.mjs');
  const warehousePath =
    process.env.GTM_WAREHOUSE_PATH || path.join(dataDir, 'warehouse', 'gtm_warehouse.duckdb');
  let activeRefresh = null;
  let timer = null;
  let status = {
    enabled,
    running: false,
    warehousePath,
    lastReason: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastError: null,
  };

  async function refresh(reason = 'manual') {
    if (activeRefresh) {
      await activeRefresh;
      return refresh(reason);
    }
    if (!enabled) {
      return status;
    }

    status = {
      ...status,
      running: true,
      lastReason: reason,
      lastStartedAt: new Date().toISOString(),
      lastError: null,
    };
    activeRefresh = execFileAsync(process.execPath, [scriptPath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PRICE_MONITOR_DATA_DIR: dataDir,
        GTM_WAREHOUSE_PATH: warehousePath,
        ...(fs.existsSync(path.join(dataDir, 'published-price-draft.sqlite'))
          ? { PRICE_MONITOR_DRAFT_DB_PATH: path.join(dataDir, 'published-price-draft.sqlite') }
          : {}),
      },
      maxBuffer: 2 * 1024 * 1024,
    })
      .then(({ stdout }) => {
        status = {
          ...status,
          running: false,
          lastCompletedAt: new Date().toISOString(),
          lastError: null,
        };
        console.log(`warehouse refreshed (${reason})`);
        if (String(stdout).trim()) {
          console.log(String(stdout).trim());
        }
        return status;
      })
      .catch((error) => {
        status = {
          ...status,
          running: false,
          lastCompletedAt: new Date().toISOString(),
          lastError: error instanceof Error ? error.message : String(error),
        };
        throw error;
      })
      .finally(() => {
        activeRefresh = null;
      });
    return activeRefresh;
  }

  function requestRefresh(reason) {
    refresh(reason).catch((error) => {
      console.error(`warehouse refresh failed (${reason})`, error);
    });
  }

  async function waitForIdle() {
    if (activeRefresh) {
      await activeRefresh;
    }
  }

  function startScheduler() {
    if (!enabled || timer || !Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
      return;
    }
    timer = setInterval(() => requestRefresh('scheduled'), intervalMinutes * 60 * 1000);
    timer.unref?.();
  }

  function getStatus() {
    return {
      ...status,
      intervalMinutes,
    };
  }

  return {
    warehousePath,
    refresh,
    requestRefresh,
    waitForIdle,
    startScheduler,
    getStatus,
  };
}
