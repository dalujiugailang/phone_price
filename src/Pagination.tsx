import { useCallback, useMemo, useRef, useState } from 'react';

export function usePagedRows<T>(rows: T[], pageSize = 50, resetKey = '') {
  const [state, setState] = useState({ page: 0, key: resetKey });
  if (state.key !== resetKey) setState({ page: 0, key: resetKey });
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.max(0, Math.min(state.key === resetKey ? state.page : 0, pageCount - 1));
  const setPage = useCallback((page: number) => setState({ page, key: resetKey }), [resetKey]);
  const visibleRows = useMemo(() => rows.slice(page * pageSize, (page + 1) * pageSize), [rows, page, pageSize]);
  return { rows: visibleRows, page, pageCount, pageSize, total: rows.length, setPage };
}

type PageControl = { page: number; pageCount: number; pageSize: number; total: number; setPage: (page: number) => void };
export function Pagination({ control, label }: { control: PageControl; label: string }) {
  const { page, pageCount, pageSize, total, setPage } = control;
  const navigation = useRef<HTMLElement>(null);
  const go = (next: number) => {
    setPage(next);
    requestAnimationFrame(() => {
      const container = navigation.current?.parentElement;
      const dialog = container?.closest('dialog');
      if (dialog) dialog.querySelector('.sku-race-table-wrap')?.scrollTo({ top: 0 });
      else {
        const heading = container?.querySelector('h2');
        if (heading) window.scrollBy(0, heading.getBoundingClientRect().top - 100);
      }
    });
  };
  return <nav ref={navigation} className="data-pagination" aria-label={`${label}分页`}>
    <span>共 {total} 条{total > 0 ? ` · ${page * pageSize + 1}–${Math.min((page + 1) * pageSize, total)} 条` : ''}</span>
    {pageCount > 1 && <div>
      <button type="button" disabled={page === 0} onClick={() => go(page - 1)}>上一页</button>
      <label>第 <select aria-label={`${label}页码`} value={page} onChange={event => go(Number(event.target.value))}>{Array.from({ length: pageCount }, (_, index) => <option key={index} value={index}>{index + 1}</option>)}</select> / {pageCount} 页</label>
      <button type="button" disabled={page >= pageCount - 1} onClick={() => go(page + 1)}>下一页</button>
    </div>}
  </nav>;
}
