import { useEffect, useRef, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Legend, Tooltip, XAxis, YAxis } from 'recharts';
import type { VolatilitySKU } from './skuVolatility';
import './sku-volatility.css';

const money = (value?: number) => value === undefined ? '--' : `¥${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;

export function HistoryLineChart({ row }: { row: Pick<VolatilitySKU, 'model' | 'storage' | 'launchPrice' | 'snapshots'> }) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | undefined>();
  useEffect(() => {
    const parent = container.current?.closest('.sku-race-table-wrap, .cs-detail-scroll');
    if (!parent) return;
    const resize = () => setWidth(Math.max(200, parent.clientWidth - 36));
    resize();
    const observer = new ResizeObserver(resize); observer.observe(parent);
    return () => observer.disconnect();
  }, []);
  const points = [
    ...(row.launchPrice && row.launchPrice > 0 ? [{date:'发布',listPrice:row.launchPrice,finalPrice:null,coupon:null}] : []),
    ...row.snapshots.map(point => ({date:point.date,coupon:point.couponKnown !== false && Number.isFinite(point.coupon) && point.coupon >= 0 ? point.coupon : null,listPrice:point.listPrice > 0 ? point.listPrice : null,finalPrice:point.finalPrice > 0 ? point.finalPrice : null})),
  ];
  return <div ref={container} style={{width:width ?? '100%'}} className="sku-race-history-chart" role="img" aria-label={`${row.model} ${row.storage} 挂牌价、到手价与优惠券，发布到最新`}>
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={points} margin={{ top: 16, right: 28, bottom: 8, left: 12 }} accessibilityLayer>
        <CartesianGrid stroke="#f0f0f0" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#9ca3af' }} minTickGap={36} interval="preserveStartEnd" />
        <YAxis domain={['auto', 'auto']} axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#9ca3af' }} tickFormatter={value => money(Number(value))} width={80} />
        <Legend iconType="line" wrapperStyle={{fontSize:12}} />
        <Tooltip formatter={(value,name) => [money(Number(value)), name]} labelFormatter={label => `${label}`} contentStyle={{ borderRadius: 10, borderColor: '#e5e7eb', fontSize: 12 }} />
        <Line type="linear" name="挂牌价（物品价）" dataKey="listPrice" stroke="#2563eb" strokeWidth={2} dot={false} activeDot={{r:4}} isAnimationActive={false} />
        <Line type="linear" name="优惠券" dataKey="coupon" stroke="#059669" strokeDasharray="5 3" strokeWidth={2} dot={false} activeDot={{r:4}} isAnimationActive={false} />
        <Line type="linear" name="到手价（国补后）" dataKey="finalPrice" stroke="#ea580c" strokeWidth={2} dot={points.length === 1} activeDot={{ r: 4 }} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  </div>;
}
