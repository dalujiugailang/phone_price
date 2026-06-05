import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Database,
  Download,
  LineChart as LineChartIcon,
  RefreshCw,
  Save,
  Table as TableIcon,
  Upload,
} from 'lucide-react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

type WeeklySalesSubView = 'dashboard' | 'import' | 'models' | 'detail';
type DetailType = 'weekly' | 'cumulative' | 'errors';

interface WeeklySalesChart {
  seriesPosition: string;
  title: string;
  xAxis: string[];
  series: Array<{
    name: string;
    data: Array<number | null>;
  }>;
}

interface WeeklySalesModel {
  id: string;
  standardModelName: string;
  brand: string;
  seriesPosition: string;
  priceBand: string;
  launchDate: string;
  isVisible: boolean;
  sortOrder: number;
  remark: string;
}

interface WeeklySalesPoint {
  standardModelName: string;
  brand: string;
  seriesPosition: string;
  priceBand: string;
  launchDate: string;
  weekLabel: string;
  weekIndex: number;
  cumulativeSales: number;
  weeklySales?: number | null;
}

interface WeeklySalesError {
  id: string;
  rawModelName: string;
  weekLabel: string;
  rawValue: string;
  errorType: string;
  errorMessage: string;
  createdAt: string;
}

interface WeeklySalesOverview {
  summary: {
    latestWeek: string;
    modelCount: number;
    latestWeekSales: number;
    wowChange: number;
    newModelCount: number;
    errorCount: number;
    updatedAt: string;
  };
  filters: {
    brands: string[];
    seriesPositions: string[];
    priceBands: string[];
    weeks: string[];
  };
  charts: WeeklySalesChart[];
  models: WeeklySalesModel[];
  cumulativeRows: WeeklySalesPoint[];
  weeklyRows: WeeklySalesPoint[];
  errors: WeeklySalesError[];
}

interface ImportPreview {
  batchPreviewId: string;
  summary: {
    modelCount: number;
    weekCount: number;
    parsedPoints: number;
    newPoints: number;
    updatePoints: number;
    skippedPoints: number;
    unknownModelCount: number;
    errorCount: number;
  };
  unknownModels: Array<{ rawModelName: string }>;
  previewRows: Array<{
    rawModelName: string;
    standardModelName: string;
    weekLabel: string;
    cumulativeSales: number;
    existingSales?: number | null;
    action: string;
    error: string | null;
  }>;
  errors: Array<{
    rawModelName: string;
    weekLabel: string;
    rawValue: string;
    errorType: string;
    errorMessage: string;
  }>;
}

interface UnknownModelMapping {
  rawModelName: string;
  standardModelName: string;
  brand: string;
  seriesPosition: string;
  priceBand: string;
  launchDate: string;
  isVisible: boolean;
}

const LINE_COLORS = ['#ea580c', '#2563eb', '#16a34a', '#dc2626', '#7c3aed', '#0891b2', '#ca8a04', '#db2777', '#475569'];

function formatNumber(value: number | null | undefined, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '--';
  }
  return value.toLocaleString('zh-CN', { maximumFractionDigits: digits });
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '--';
  }
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function chartRows(chart: WeeklySalesChart) {
  return chart.xAxis.map((week, weekIndex) => {
    const row: Record<string, string | number | null> = { week };
    chart.series.forEach((item) => {
      row[item.name] = item.data[weekIndex];
    });
    return row;
  });
}

function fieldValue(filters: URLSearchParams, key: string) {
  return filters.get(key) ?? '';
}

async function fetchOverview(filters: URLSearchParams) {
  const query = filters.toString();
  const response = await fetch(`/api/weekly-sales/overview${query ? `?${query}` : ''}`);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.message || '新品周销数据读取失败');
  }
  return payload as WeeklySalesOverview;
}

async function parseImport(rawText: string) {
  const response = await fetch('/api/weekly-sales/import/parse', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rawText }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.message || '导入解析失败');
  }
  return payload as ImportPreview;
}

async function confirmImport(batchPreviewId: string, mappings: UnknownModelMapping[]) {
  const response = await fetch('/api/weekly-sales/import/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ batchPreviewId, newModelMappings: mappings }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.message || '确认落库失败');
  }
  return payload as { insertedPoints: number; updatedPoints: number; errorPoints: number };
}

async function createModel(payload: Partial<WeeklySalesModel> & { rawModelAlias?: string }) {
  const response = await fetch('/api/weekly-sales/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result?.message || '型号保存失败');
  }
  return result;
}

async function updateModel(id: string, payload: Partial<WeeklySalesModel> & { rawModelAlias?: string }) {
  const response = await fetch(`/api/weekly-sales/models/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result?.message || '型号更新失败');
  }
  return result;
}

function StatCard({
  label,
  value,
  subValue,
  icon,
}: {
  label: string;
  value: string | number;
  subValue?: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-gray-500">{label}</p>
          <p className="mt-2 text-2xl font-bold text-gray-900">{value}</p>
          {subValue ? <p className="mt-1 text-xs font-medium text-gray-500">{subValue}</p> : null}
        </div>
        <div className="rounded-xl bg-orange-50 p-2">{icon}</div>
      </div>
    </div>
  );
}

function EmptyPanel({ message }: { message: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-gray-200 bg-white p-10 text-center text-sm font-medium text-gray-500">
      {message}
    </div>
  );
}

export function WeeklySalesPanel() {
  const [subView, setSubView] = useState<WeeklySalesSubView>('dashboard');
  const [detailType, setDetailType] = useState<DetailType>('weekly');
  const [overview, setOverview] = useState<WeeklySalesOverview | null>(null);
  const [filters, setFilters] = useState(new URLSearchParams({ visibleOnly: 'true', startWeek: '2' }));
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rawText, setRawText] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [unknownMappings, setUnknownMappings] = useState<UnknownModelMapping[]>([]);
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [modelDraft, setModelDraft] = useState({
    standardModelName: '',
    rawModelAlias: '',
    brand: '',
    seriesPosition: '主品牌旗舰',
    priceBand: '5K+',
    launchDate: '',
    isVisible: true,
  });

  const loadOverview = async (nextFilters = filters) => {
    setIsLoading(true);
    setError(null);
    try {
      const nextOverview = await fetchOverview(nextFilters);
      setOverview(nextOverview);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '新品周销数据读取失败');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadOverview();
  }, []);

  const updateFilter = (key: string, value: string) => {
    const nextFilters = new URLSearchParams(filters);
    if (value) {
      nextFilters.set(key, value);
    } else {
      nextFilters.delete(key);
    }
    setFilters(nextFilters);
    loadOverview(nextFilters);
  };

  const handleParse = async () => {
    setMessage(null);
    setError(null);
    try {
      const nextPreview = await parseImport(rawText);
      setPreview(nextPreview);
      setUnknownMappings(
        nextPreview.unknownModels.map((item) => ({
          rawModelName: item.rawModelName,
          standardModelName: item.rawModelName,
          brand: '',
          seriesPosition: '主品牌旗舰',
          priceBand: '5K+',
          launchDate: '',
          isVisible: true,
        })),
      );
      setMessage(`解析完成：新增 ${nextPreview.summary.newPoints} 个数据点，已存在 ${nextPreview.summary.skippedPoints ?? 0} 个，未知型号 ${nextPreview.summary.unknownModelCount} 个`);
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : '导入解析失败');
    }
  };

  const handleConfirm = async () => {
    if (!preview) {
      return;
    }
    setMessage(null);
    setError(null);
    try {
      const result = await confirmImport(preview.batchPreviewId, unknownMappings);
      setMessage(`落库完成：新增 ${result.insertedPoints}，更新 ${result.updatedPoints}，异常 ${result.errorPoints}`);
      setPreview(null);
      setRawText('');
      await loadOverview();
      setSubView('dashboard');
    } catch (confirmError) {
      setError(confirmError instanceof Error ? confirmError.message : '确认落库失败');
    }
  };

  const resetModelDraft = () => {
    setEditingModelId(null);
    setModelDraft({
      standardModelName: '',
      rawModelAlias: '',
      brand: '',
      seriesPosition: '主品牌旗舰',
      priceBand: '5K+',
      launchDate: '',
      isVisible: true,
    });
  };

  const handleSelectModel = (model: WeeklySalesModel) => {
    setEditingModelId(model.id);
    setModelDraft({
      standardModelName: model.standardModelName,
      rawModelAlias: '',
      brand: model.brand,
      seriesPosition: model.seriesPosition || '主品牌旗舰',
      priceBand: model.priceBand || '5K+',
      launchDate: model.launchDate,
      isVisible: model.isVisible,
    });
    setMessage(`正在编辑：${model.standardModelName}`);
    setError(null);
  };

  const handleSaveModel = async () => {
    setMessage(null);
    setError(null);
    try {
      if (editingModelId) {
        await updateModel(editingModelId, modelDraft);
        setMessage('型号维度已更新');
      } else {
        await createModel(modelDraft);
        setMessage('型号已保存');
      }
      resetModelDraft();
      await loadOverview();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '型号保存失败');
    }
  };

  const filteredModels = overview?.models ?? [];
  const latestRows = useMemo(() => {
    if (!overview?.summary.latestWeek) {
      return [];
    }
    return overview.weeklyRows.filter((row) => row.weekLabel === overview.summary.latestWeek).sort((left, right) => (right.weeklySales ?? 0) - (left.weeklySales ?? 0));
  }, [overview]);

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-gray-900">新品周销监控</h2>
          <p className="text-sm font-medium text-gray-500">累计销量导入后自动计算分周销量，按系列定位刷新图表。</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => loadOverview()}
            className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-700 shadow-sm hover:bg-gray-50"
          >
            <RefreshCw size={16} /> 刷新
          </button>
          <a
            href="/api/weekly-sales/export.xlsx"
            className="inline-flex items-center gap-2 rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-gray-800"
          >
            <Download size={16} /> 导出
          </a>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 rounded-2xl border border-gray-100 bg-white p-2 shadow-sm">
        {[
          ['dashboard', '周销量看板', LineChartIcon],
          ['import', '数据导入', Upload],
          ['models', '型号管理', Database],
          ['detail', '数据明细', TableIcon],
        ].map(([key, label, Icon]) => (
          <button
            key={key as string}
            onClick={() => setSubView(key as WeeklySalesSubView)}
            className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold ${
              subView === key ? 'bg-orange-50 text-orange-700 ring-1 ring-orange-100' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-800'
            }`}
          >
            <Icon size={16} /> {label as string}
          </button>
        ))}
      </div>

      {message ? <div className="rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">{message}</div> : null}
      {error ? <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</div> : null}

      {isLoading ? (
        <EmptyPanel message="正在读取新品周销数据..." />
      ) : !overview ? (
        <EmptyPanel message="暂无新品周销数据" />
      ) : subView === 'dashboard' ? (
        <>
          <div className="grid grid-cols-1 gap-3 rounded-2xl border border-gray-100 bg-white p-4 shadow-sm md:grid-cols-5">
            <FilterSelect label="品牌" value={fieldValue(filters, 'brand')} options={overview.filters.brands} onChange={(value) => updateFilter('brand', value)} />
            <FilterSelect label="系列定位" value={fieldValue(filters, 'seriesPosition')} options={overview.filters.seriesPositions} onChange={(value) => updateFilter('seriesPosition', value)} />
            <FilterSelect label="价格带" value={fieldValue(filters, 'priceBand')} options={overview.filters.priceBands} onChange={(value) => updateFilter('priceBand', value)} />
            <FilterSelect label="开始周" value={fieldValue(filters, 'startWeek')} options={overview.filters.weeks.map((week) => week.replace('W', ''))} onChange={(value) => updateFilter('startWeek', value)} />
            <FilterSelect label="结束周" value={fieldValue(filters, 'endWeek')} options={overview.filters.weeks.map((week) => week.replace('W', ''))} onChange={(value) => updateFilter('endWeek', value)} />
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3 lg:grid-cols-5">
            <StatCard label="最新周数" value={overview.summary.latestWeek || '--'} subValue="当前数据窗口" icon={<LineChartIcon className="text-orange-600" />} />
            <StatCard label="监控型号" value={overview.summary.modelCount} subValue="仅统计展示型号" icon={<Database className="text-blue-600" />} />
            <StatCard label="最新周总销量" value={`${formatNumber(overview.summary.latestWeekSales)}万`} subValue="按分周销量求和" icon={<LineChartIcon className="text-emerald-600" />} />
            <StatCard label="环比变化" value={formatPercent(overview.summary.wowChange)} subValue="最新周对比上一周" icon={<RefreshCw className="text-purple-600" />} />
            <StatCard label="异常数据" value={overview.summary.errorCount} subValue="导入校验留痕" icon={<AlertTriangle className="text-red-600" />} />
          </div>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            {overview.charts.map((chart) => (
              <div key={chart.seriesPosition} className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <h3 className="font-bold text-gray-900">{chart.title}</h3>
                    <p className="text-xs font-medium text-gray-500">单位：万</p>
                  </div>
                  <span className="rounded-full bg-orange-50 px-3 py-1 text-xs font-bold text-orange-700">{chart.series.length} 个型号</span>
                </div>
                {chart.series.length === 0 ? (
                  <EmptyPanel message="当前筛选下没有可展示型号" />
                ) : (
                  <div className="h-[340px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={chartRows(chart)} margin={{ top: 8, right: 18, bottom: 0, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                        <XAxis dataKey="week" tick={{ fontSize: 12 }} />
                        <YAxis tick={{ fontSize: 12 }} width={44} />
                        <Tooltip
                          formatter={(value, name) => [`${formatNumber(Number(value))}万`, String(name)]}
                          labelFormatter={(label) => `${label} 分周销量`}
                        />
                        <Legend wrapperStyle={{ fontSize: 12 }} />
                        {chart.series.map((item, index) => (
                          <Line
                            key={item.name}
                            type="monotone"
                            dataKey={item.name}
                            stroke={LINE_COLORS[index % LINE_COLORS.length]}
                            strokeWidth={2}
                            dot={false}
                            connectNulls={false}
                          />
                        ))}
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
            <h3 className="font-bold text-gray-900">{overview.summary.latestWeek || '最新周'} 型号销量排行</h3>
            <div className="mt-4 overflow-x-auto">
              <table className="min-w-full border-collapse text-left text-sm">
                <thead className="bg-gray-50 text-xs font-bold uppercase text-gray-500">
                  <tr>
                    <th className="px-4 py-3">型号/系列</th>
                    <th className="px-4 py-3">品牌</th>
                    <th className="px-4 py-3">系列定位</th>
                    <th className="px-4 py-3 text-right">分周销量</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {latestRows.slice(0, 12).map((row) => (
                    <tr key={`${row.standardModelName}-${row.weekLabel}`}>
                      <td className="px-4 py-3 font-semibold text-gray-900">{row.standardModelName}</td>
                      <td className="px-4 py-3 text-gray-600">{row.brand}</td>
                      <td className="px-4 py-3 text-gray-600">{row.seriesPosition}</td>
                      <td className="px-4 py-3 text-right font-bold text-gray-900">{formatNumber(row.weeklySales)}万</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : subView === 'import' ? (
        <div className="space-y-6">
          <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h3 className="font-bold text-gray-900">粘贴累计销量底表</h3>
                <p className="text-sm font-medium text-gray-500">格式：第一列“型号/系列”，后续列为 W1、W2、W3。</p>
              </div>
              <button
                onClick={handleParse}
                disabled={!rawText.trim()}
                className="inline-flex items-center gap-2 rounded-xl bg-orange-600 px-4 py-2 text-sm font-semibold text-white shadow-sm disabled:cursor-not-allowed disabled:bg-gray-300"
              >
                <Upload size={16} /> 解析数据
              </button>
            </div>
            <textarea
              value={rawText}
              onChange={(event) => setRawText(event.target.value)}
              className="h-64 w-full rounded-xl border border-gray-200 bg-gray-50 p-4 font-mono text-sm focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-100"
              placeholder={'型号/系列\tW1\tW2\tW3\n华为 Mate 80系列\t179.8\t205.7\t229.3'}
            />
          </div>

          {preview ? (
            <div className="space-y-4 rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="font-bold text-gray-900">解析预览</h3>
                  <p className="text-sm font-medium text-gray-500">
                    型号 {preview.summary.modelCount} 个，周字段 {preview.summary.weekCount} 个，新增 {preview.summary.newPoints} 个，已存在 {preview.summary.skippedPoints ?? 0} 个，异常 {preview.summary.errorCount} 个
                  </p>
                </div>
                <button
                  onClick={handleConfirm}
                  className="inline-flex items-center gap-2 rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-gray-800"
                >
                  <Save size={16} /> 确认落库
                </button>
              </div>

              {unknownMappings.length > 0 ? (
                <div className="rounded-xl border border-orange-100 bg-orange-50 p-4">
                  <h4 className="font-bold text-orange-800">待补型号</h4>
                  <div className="mt-3 grid gap-3">
                    {unknownMappings.map((mapping, index) => (
                      <div key={mapping.rawModelName} className="grid grid-cols-1 gap-2 md:grid-cols-6">
                        <Input label="原始型号" value={mapping.rawModelName} readOnly />
                        <Input label="标准型号" value={mapping.standardModelName} onChange={(value) => updateUnknownMapping(index, 'standardModelName', value, setUnknownMappings)} />
                        <Input label="品牌" value={mapping.brand} onChange={(value) => updateUnknownMapping(index, 'brand', value, setUnknownMappings)} />
                        <Select label="系列定位" value={mapping.seriesPosition} options={overview.filters.seriesPositions} onChange={(value) => updateUnknownMapping(index, 'seriesPosition', value, setUnknownMappings)} />
                        <Input label="价格带" value={mapping.priceBand} onChange={(value) => updateUnknownMapping(index, 'priceBand', value, setUnknownMappings)} />
                        <Input label="上市日期" value={mapping.launchDate} onChange={(value) => updateUnknownMapping(index, 'launchDate', value, setUnknownMappings)} />
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <PreviewTable preview={preview} />
            </div>
          ) : null}
        </div>
      ) : subView === 'models' ? (
        <div className="space-y-6">
          <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-bold text-gray-900">{editingModelId ? '编辑型号维度' : '新增型号'}</h3>
                <p className="mt-1 text-sm font-medium text-gray-500">点击下方型号列表中的任意一行，可编辑该型号的品牌、系列定位、价格带、上市日期和展示状态。</p>
              </div>
              {editingModelId ? (
                <button
                  onClick={resetModelDraft}
                  className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-600 shadow-sm hover:bg-gray-50"
                >
                  取消编辑
                </button>
              ) : null}
            </div>
            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-4">
              <Input label="标准型号/系列" value={modelDraft.standardModelName} onChange={(value) => setModelDraft((draft) => ({ ...draft, standardModelName: value }))} />
              <Input label="原始型号别名" value={modelDraft.rawModelAlias} onChange={(value) => setModelDraft((draft) => ({ ...draft, rawModelAlias: value }))} />
              <Input label="品牌" value={modelDraft.brand} onChange={(value) => setModelDraft((draft) => ({ ...draft, brand: value }))} />
              <Select label="系列定位" value={modelDraft.seriesPosition} options={overview.filters.seriesPositions} onChange={(value) => setModelDraft((draft) => ({ ...draft, seriesPosition: value }))} />
              <Input label="价格带" value={modelDraft.priceBand} onChange={(value) => setModelDraft((draft) => ({ ...draft, priceBand: value }))} />
              <Input label="上市日期" value={modelDraft.launchDate} onChange={(value) => setModelDraft((draft) => ({ ...draft, launchDate: value }))} />
              <label className="flex items-end gap-2 pb-2 text-sm font-semibold text-gray-700">
                <input
                  type="checkbox"
                  checked={modelDraft.isVisible}
                  onChange={(event) => setModelDraft((draft) => ({ ...draft, isVisible: event.target.checked }))}
                />
                进入看板
              </label>
              <button
                onClick={handleSaveModel}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-orange-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-orange-700"
              >
                <Save size={16} /> {editingModelId ? '保存修改' : '保存型号'}
              </button>
            </div>
          </div>

          <ModelTable models={filteredModels} selectedModelId={editingModelId} onSelectModel={handleSelectModel} />
        </div>
      ) : (
        <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {[
              ['weekly', '分周销量明细'],
              ['cumulative', '累计销量明细'],
              ['errors', '异常数据明细'],
            ].map(([key, label]) => (
              <button
                key={key}
                onClick={() => setDetailType(key as DetailType)}
                className={`rounded-xl px-4 py-2 text-sm font-semibold ${detailType === key ? 'bg-orange-50 text-orange-700' : 'text-gray-500 hover:bg-gray-50'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <DetailTable overview={overview} detailType={detailType} />
        </div>
      )}
    </section>
  );
}

export default WeeklySalesPanel;

function FilterSelect({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return (
    <label className="space-y-1">
      <span className="text-xs font-bold text-gray-500">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-700 focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-100">
        <option value="">全部</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {label.includes('周') && /^\d+$/.test(option) ? `W${option}` : option}
          </option>
        ))}
      </select>
    </label>
  );
}

function Input({ label, value, readOnly, onChange }: { label: string; value: string; readOnly?: boolean; onChange?: (value: string) => void }) {
  return (
    <label className="space-y-1">
      <span className="text-xs font-bold text-gray-500">{label}</span>
      <input
        value={value}
        readOnly={readOnly}
        onChange={(event) => onChange?.(event.target.value)}
        className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-semibold text-gray-700 focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-100 read-only:bg-gray-100"
      />
    </label>
  );
}

function Select({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return (
    <label className="space-y-1">
      <span className="text-xs font-bold text-gray-500">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-semibold text-gray-700 focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-100">
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function updateUnknownMapping(
  index: number,
  key: keyof UnknownModelMapping,
  value: string,
  setUnknownMappings: React.Dispatch<React.SetStateAction<UnknownModelMapping[]>>,
) {
  setUnknownMappings((items) => items.map((item, itemIndex) => (itemIndex === index ? { ...item, [key]: value } : item)));
}

function PreviewTable({ preview }: { preview: ImportPreview }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full border-collapse text-left text-sm">
        <thead className="bg-gray-50 text-xs font-bold uppercase text-gray-500">
          <tr>
            <th className="px-4 py-3">型号</th>
            <th className="px-4 py-3">周数</th>
            <th className="px-4 py-3 text-right">累计销量</th>
            <th className="px-4 py-3">状态</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {preview.previewRows.slice(0, 80).map((row, index) => (
            <tr key={`${row.rawModelName}-${row.weekLabel}-${index}`}>
              <td className="px-4 py-3 font-semibold text-gray-900">{row.standardModelName || row.rawModelName}</td>
              <td className="px-4 py-3 text-gray-600">{row.weekLabel}</td>
              <td className="px-4 py-3 text-right font-bold text-gray-900">{formatNumber(row.cumulativeSales)}</td>
              <td className="px-4 py-3 text-gray-600">{row.error || (row.action === 'insert' ? '新增' : row.action === 'skip_existing' ? '已存在，不导入' : '待补型号')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ModelTable({
  models,
  selectedModelId,
  onSelectModel,
}: {
  models: WeeklySalesModel[];
  selectedModelId: string | null;
  onSelectModel: (model: WeeklySalesModel) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-gray-100 bg-white shadow-sm">
      <table className="min-w-full border-collapse text-left text-sm">
        <thead className="bg-gray-50 text-xs font-bold uppercase text-gray-500">
          <tr>
            <th className="px-4 py-3">型号/系列</th>
            <th className="px-4 py-3">品牌</th>
            <th className="px-4 py-3">系列定位</th>
            <th className="px-4 py-3">价格带</th>
            <th className="px-4 py-3">上市日期</th>
            <th className="px-4 py-3">展示</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {models.map((model) => (
            <tr
              key={model.id}
              onClick={() => onSelectModel(model)}
              className={`cursor-pointer transition-colors ${selectedModelId === model.id ? 'bg-orange-50' : 'hover:bg-gray-50'}`}
            >
              <td className="px-4 py-3 font-semibold text-gray-900">
                <button type="button" className="text-left font-semibold text-gray-900">
                  {model.standardModelName}
                </button>
              </td>
              <td className="px-4 py-3 text-gray-600">{model.brand || '--'}</td>
              <td className="px-4 py-3 text-gray-600">{model.seriesPosition || '未维护'}</td>
              <td className="px-4 py-3 text-gray-600">{model.priceBand || '--'}</td>
              <td className="px-4 py-3 text-gray-600">{model.launchDate || '--'}</td>
              <td className="px-4 py-3">
                <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${model.isVisible ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
                  {model.isVisible ? '是' : '否'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DetailTable({ overview, detailType }: { overview: WeeklySalesOverview; detailType: DetailType }) {
  if (detailType === 'errors') {
    return (
      <div className="overflow-x-auto">
        <table className="min-w-full border-collapse text-left text-sm">
          <thead className="bg-gray-50 text-xs font-bold uppercase text-gray-500">
            <tr>
              <th className="px-4 py-3">型号</th>
              <th className="px-4 py-3">周数</th>
              <th className="px-4 py-3">原始值</th>
              <th className="px-4 py-3">异常类型</th>
              <th className="px-4 py-3">说明</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {overview.errors.map((row) => (
              <tr key={row.id}>
                <td className="px-4 py-3 font-semibold text-gray-900">{row.rawModelName}</td>
                <td className="px-4 py-3 text-gray-600">{row.weekLabel}</td>
                <td className="px-4 py-3 text-gray-600">{row.rawValue}</td>
                <td className="px-4 py-3 text-gray-600">{row.errorType}</td>
                <td className="px-4 py-3 text-gray-600">{row.errorMessage}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const rows = detailType === 'weekly' ? overview.weeklyRows : overview.cumulativeRows;
  const weeks = Array.from(new Set(rows.map((row) => row.weekLabel))).sort((left, right) => Number(left.replace('W', '')) - Number(right.replace('W', '')));
  const modelRows = overview.models
    .map((model) => {
      const modelPoints = rows.filter((row) => row.standardModelName === model.standardModelName);
      if (modelPoints.length === 0) {
        return null;
      }

      return {
        model,
        values: weeks.map((week) => {
          const point = modelPoints.find((row) => row.weekLabel === week);
          return detailType === 'weekly' ? point?.weeklySales : point?.cumulativeSales;
        }),
      };
    })
    .filter((row): row is { model: WeeklySalesModel; values: Array<number | null | undefined> } => row !== null);

  return (
    <div className="max-h-[620px] overflow-auto">
      <table className="min-w-max border-separate border-spacing-0 text-left text-sm">
        <thead className="sticky top-0 bg-gray-50 text-xs font-bold uppercase text-gray-500">
          <tr>
            <th className="sticky left-0 z-20 min-w-[220px] border-b border-r border-gray-100 bg-gray-50 px-4 py-3">型号/系列</th>
            <th className="min-w-[90px] border-b border-gray-100 px-4 py-3">品牌</th>
            <th className="min-w-[120px] border-b border-gray-100 px-4 py-3">系列定位</th>
            <th className="min-w-[90px] border-b border-gray-100 px-4 py-3">价格带</th>
            {weeks.map((week) => (
              <th key={week} className="min-w-[86px] border-b border-gray-100 px-4 py-3 text-right">
                {week}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {modelRows.map(({ model, values }) => (
            <tr key={model.standardModelName} className="bg-white">
              <td className="sticky left-0 z-10 border-r border-gray-100 bg-white px-4 py-3 font-semibold text-gray-900">{model.standardModelName}</td>
              <td className="px-4 py-3 text-gray-600">{model.brand || '--'}</td>
              <td className="px-4 py-3 text-gray-600">{model.seriesPosition || '--'}</td>
              <td className="px-4 py-3 text-gray-600">{model.priceBand || '--'}</td>
              {values.map((value, index) => (
                <td key={`${model.standardModelName}-${weeks[index]}`} className="px-4 py-3 text-right font-semibold text-gray-900">
                  {value === null || value === undefined ? '--' : formatNumber(value)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
