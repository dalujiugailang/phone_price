import 'dotenv/config';
import os from 'node:os';
import { createBrowserUseCliClient } from '../server/lib/weibo-rd-automation.mjs';

const serverUrl = String(process.env.GTM_SERVER_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const workerToken = String(process.env.WEEKLY_SALES_WORKER_TOKEN ?? '').trim();
const workerId = String(process.env.GTM_WORKER_ID ?? `${os.hostname()}-weibo`).trim();
const pollMs = Math.max(5000, Number(process.env.GTM_WORKER_POLL_MS ?? 15000));
const runOnce = ['1', 'true', 'yes'].includes(String(process.env.GTM_WORKER_ONCE ?? '').toLowerCase());
const browserUseClient = createBrowserUseCliClient({ mode: 'local' });

if (!workerToken) {
  throw new Error('本机 Worker 缺少 WEEKLY_SALES_WORKER_TOKEN');
}

async function api(path, body) {
  const response = await fetch(`${serverUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${workerToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.message || `云端接口返回 HTTP ${response.status}`);
  }
  return payload;
}

async function runJob(job) {
  console.log(`[${new Date().toISOString()}] 开始任务 ${job.id}，使用本机 Chrome 抓取微博`);
  const heartbeat = setInterval(() => {
    api('/api/weekly-sales/automation/jobs/heartbeat', { workerId }).catch((error) => {
      console.error(`Worker 心跳失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }, 30_000);
  heartbeat.unref?.();
  try {
    const result = await browserUseClient.collectPosts({
      onStatus: ({ phase }) => console.log(`[${job.id}] phase=${phase}`),
    });
    const completed = await api(`/api/weekly-sales/automation/jobs/${job.id}/complete`, {
      workerId,
      posts: result.posts,
    });
    console.log(
      `[${new Date().toISOString()}] 任务 ${job.id} 完成：${completed.postCount} 条微博，新增 ${completed.insertedPoints} 个数据点`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${new Date().toISOString()}] 任务 ${job.id} 失败：${message}`);
    await api(`/api/weekly-sales/automation/jobs/${job.id}/fail`, { workerId, message }).catch((reportError) => {
      console.error(`失败状态回传失败：${reportError instanceof Error ? reportError.message : String(reportError)}`);
    });
  } finally {
    clearInterval(heartbeat);
  }
}

async function poll() {
  const payload = await api('/api/weekly-sales/automation/jobs/claim', { workerId });
  if (payload.job) {
    await runJob(payload.job);
  }
  return Boolean(payload.job);
}

console.log(`微博本机 Worker 已启动：${workerId} → ${serverUrl}`);
do {
  try {
    await poll();
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Worker 轮询失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!runOnce) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
} while (!runOnce);
