import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createWeeklySalesService, getWeeklySalesScheduleSlot } from '../server/lib/weekly-sales.mjs';
import { buildSalesWideTables, parseRdWeiboPosts } from '../server/lib/weibo-rd-automation.mjs';

process.env.NODE_ENV = 'test';

const brandLines = [
  '1. 华为 19.0%',
  '2. OPPO 18.0%',
  '3. vivo 17.0%',
  '4. 苹果 16.0%',
  '5. 小米 15.0%',
  '6. 荣耀 10.0%',
].join('\n');

function post(id, content) {
  return {
    id,
    published_at: `2026-07-${id.padStart(2, '0')} 10:00:00`,
    content,
    post_url: `https://weibo.com/7928198622/${id}`,
  };
}

const fixturePosts = [
  post('01', `2026 W26 新品累计销量\nOPPO Reno 16系列 约70万台\n华为 Pura 80系列 约90万台`),
  post('02', `2026 W27 新品累计销量\nOPPO Reno 16系列 约78万台\n华为 Pura 80系列 约101万台`),
  post('03', `2026 W28 新品累计销量\nOPPO Reno 16系列 约84.64万台\n华为 Pura 80系列 约112万台`),
  post('04', `国内手机市场份额 (Sell out) 2026 W26\n本周大盘持平\n${brandLines}`),
  post('05', `国内手机市场份额 (Sell out) 2026 W27\n本周大盘略微下降\n${brandLines}`),
  post('06', `国内手机市场份额 (Sell out) 2026 W28\n本周大盘下降约10%\n${brandLines}`),
];

test('确定性解析新品周销和品牌份额口径', () => {
  const parsed = parseRdWeiboPosts(fixturePosts);
  assert.equal(parsed.posts.length, 6);
  assert.equal(parsed.salesRecords.length, 6);
  assert.equal(
    parsed.salesRecords.find((record) => record.rawModelName === 'OPPO Reno 16系列' && record.weekIndex === 28)?.cumulativeSales,
    84.64,
  );
  assert.deepEqual(
    parsed.marketWeeks.map((record) => [record.weekLabel, record.totalIndex]),
    [
      ['W26', 90.4],
      ['W27', 85.9],
      ['W28', 77.3],
    ],
  );
  assert.equal(parsed.marketWeeks[0].brandShares.Others, 5);

  const tables = buildSalesWideTables(parsed.salesRecords);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].year, 2026);
  assert.deepEqual(tables[0].weeks, ['W26', 'W27', 'W28']);
  assert.match(tables[0].rawText, /OPPO Reno 16系列\t70\t78\t84\.64/);
});

test('自动任务仅在上海时区周一或周五 10 点后生成日程槽位', () => {
  assert.equal(getWeeklySalesScheduleSlot(new Date('2026-07-20T01:59:59Z')), null);
  assert.equal(getWeeklySalesScheduleSlot(new Date('2026-07-20T02:00:00Z')), '2026-07-20@10:00');
  assert.equal(getWeeklySalesScheduleSlot(new Date('2026-07-24T08:00:00Z')), '2026-07-24@10:00');
  assert.equal(getWeeklySalesScheduleSlot(new Date('2026-07-21T08:00:00Z')), null);
});

test('自动入库幂等且允许跨年同周次共存', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gtm-weibo-rd-'));
  const service = createWeeklySalesService({
    dataDir,
    applyMarketWeeks: async (weeks) => ({ insertedWeeks: weeks.length, skippedWeeks: 0 }),
  });

  const first = await service.runAutomationFromPosts(fixturePosts);
  assert.equal(first.status, 'success');
  assert.equal(first.insertedPoints, 6);
  assert.equal(first.newModelCount, 2);

  const second = await service.runAutomationFromPosts(fixturePosts);
  assert.equal(second.status, 'success');
  assert.equal(second.insertedPoints, 0);
  assert.equal(second.skippedPoints, 6);

  const crossYear = await service.runAutomationFromPosts([
    {
      ...post('07', '2027 W1 新品累计销量\nOPPO Reno 16系列 约91万台'),
      published_at: '2027-01-08 10:00:00',
    },
  ]);
  assert.equal(crossYear.status, 'success');
  assert.equal(crossYear.insertedPoints, 1);

  const database = new DatabaseSync(path.join(dataDir, 'weekly-sales.sqlite'), { readOnly: true });
  const rows = database
    .prepare("SELECT year, week_index, cumulative_sales FROM weekly_cumulative_sales WHERE standard_model_name = 'OPPO Reno 16系列' ORDER BY year, week_index")
    .all();
  assert.deepEqual(
    rows.map((row) => [row.year, row.week_index, row.cumulative_sales]),
    [
      [2026, 26, 70],
      [2026, 27, 78],
      [2026, 28, 84.64],
      [2027, 1, 91],
    ],
  );
  database.close();
});

test('定时任务同一日程槽位只触发一次且手动运行口令受保护', async () => {
  const previousSchedule = process.env.WEEKLY_SALES_SCHEDULE_ENABLED;
  const previousToken = process.env.WEEKLY_SALES_AUTOMATION_TOKEN;
  const previousWorkerToken = process.env.WEEKLY_SALES_WORKER_TOKEN;
  process.env.WEEKLY_SALES_SCHEDULE_ENABLED = 'true';
  process.env.WEEKLY_SALES_AUTOMATION_TOKEN = 'test-automation-token';
  process.env.WEEKLY_SALES_WORKER_TOKEN = 'test-worker-token';
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gtm-weibo-schedule-'));
  const service = createWeeklySalesService({
    dataDir,
    applyMarketWeeks: async (weeks) => ({ insertedWeeks: weeks.length, skippedWeeks: 0 }),
  });
  if (previousSchedule === undefined) delete process.env.WEEKLY_SALES_SCHEDULE_ENABLED;
  else process.env.WEEKLY_SALES_SCHEDULE_ENABLED = previousSchedule;
  if (previousToken === undefined) delete process.env.WEEKLY_SALES_AUTOMATION_TOKEN;
  else process.env.WEEKLY_SALES_AUTOMATION_TOKEN = previousToken;
  if (previousWorkerToken === undefined) delete process.env.WEEKLY_SALES_WORKER_TOKEN;
  else process.env.WEEKLY_SALES_WORKER_TOKEN = previousWorkerToken;

  assert.equal(service.authorizeManualAutomation('wrong-token'), false);
  assert.equal(service.authorizeManualAutomation('test-automation-token'), true);
  const first = await service.runScheduledAutomationIfDue(new Date('2026-07-20T02:00:00Z'));
  const duplicate = await service.runScheduledAutomationIfDue(new Date('2026-07-20T08:00:00Z'));
  assert.equal(first?.alreadyRunning, false);
  assert.equal(first?.run.status, 'queued');
  assert.equal(duplicate, null);
  assert.equal(service.getAutomationStatus().scheduler.lastAttemptSlot, '2026-07-20@10:00');
  assert.equal(service.authorizeWorker('test-worker-token'), true);
  const job = await service.claimAutomationRun('test-mac');
  assert.equal(job.status, 'running');
  assert.equal(job.workerId, 'test-mac');
  const completed = await service.completeAutomationRun(job.id, 'test-mac', fixturePosts);
  assert.equal(completed.status, 'success');
  assert.equal(completed.insertedPoints, 6);
});
