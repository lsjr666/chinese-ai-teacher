import { useCallback, useEffect, useState } from 'react';
import {
  ClipboardCheck,
  Clock,
  FileQuestion,
  LoaderCircle,
  RefreshCw,
  ScanLine,
} from 'lucide-react';
import { ResultPanel } from './result-view.jsx';
import { exportWord, printPage } from './export.mjs';

const KINDS = [
  { id: '', label: '全部' },
  { id: 'solve', label: '搜题' },
  { id: 'generate', label: '出题' },
  { id: 'grade', label: '批改' },
];

const KIND_META = {
  solve: { label: '搜题', icon: ScanLine },
  generate: { label: '出题', icon: FileQuestion },
  grade: { label: '批改', icon: ClipboardCheck },
};

function formatTime(value) {
  if (!value) return '';
  const text = String(value).replace('T', ' ');
  return text.slice(5, 16);
}

function formatDuration(ms) {
  if (!ms) return '';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} 秒`;
  return `${(ms / 60000).toFixed(1)} 分钟`;
}

export function HistoryPanel({ apiRequest, onToast }) {
  const [kind, setKind] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ items: [], total: 0 });
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiRequest(`/api/history?kind=${encodeURIComponent(kind)}&page=${page}&pageSize=20`);
      setData({ items: result.items ?? [], total: result.total ?? 0 });
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [apiRequest, kind, page]);

  useEffect(() => {
    load();
  }, [load]);

  const openRecord = async (record) => {
    if (!record.hasResult) {
      setDetail({ id: record.id, kind: record.kind, result: null, meta: record });
      return;
    }
    setDetailLoading(true);
    try {
      const payload = await apiRequest(`/api/history/${record.id}`);
      setDetail({ id: record.id, kind: record.kind, result: payload.result, meta: record });
    } catch (err) {
      onToast?.(err.message);
      setDetail({ id: record.id, kind: record.kind, result: null, meta: record });
    } finally {
      setDetailLoading(false);
    }
  };

  const exportDetail = (includeAnswer) => {
    if (!detail?.result) return;
    exportWord({
      title: detail.meta?.questionText?.slice(0, 40) || '历史记录',
      subtitle: [detail.meta?.stage, detail.meta?.subject, KIND_META[detail.kind]?.label].filter(Boolean).join(' '),
      filename: `历史记录-${detail.id}`,
      results: detail.result.batch ? detail.result.questions : [detail.result],
      includeAnswer,
    });
    onToast?.('已导出 Word 文档');
  };

  const totalPages = Math.max(1, Math.ceil((data.total || 0) / 20));

  return (
    <>
      <section className="task-panel">
        <div className="panel-head">
          <div>
            <span className="panel-kicker">STEP 01</span>
            <h2>搜过、出过、改过的题</h2>
          </div>
          <span className="panel-icon"><Clock size={18} /></span>
        </div>
        <div className="form-stack">
          <div className="chip-row">
            {KINDS.map((item) => (
              <button
                key={item.id || 'all'}
                type="button"
                className={`chip ${kind === item.id ? 'is-active' : ''}`}
                onClick={() => {
                  setKind(item.id);
                  setPage(1);
                }}
              >
                {item.label}
              </button>
            ))}
            <button type="button" className="chip chip-icon" onClick={load} title="刷新">
              <RefreshCw size={14} />
            </button>
          </div>
          <div className="history-list">
            {loading && !data.items.length && (
              <div className="muted-line"><LoaderCircle className="spin" size={15} /> 正在读取记录…</div>
            )}
            {!loading && !data.items.length && <div className="muted-line">这一页还没有记录。去搜一题或出一题就有了。</div>}
            {data.items.map((record) => {
              const meta = KIND_META[record.kind] ?? KIND_META.solve;
              const Icon = meta.icon;
              return (
                <button
                  type="button"
                  key={record.id}
                  className={`history-row ${detail?.id === record.id ? 'is-active' : ''}`}
                  onClick={() => openRecord(record)}
                >
                  <span className="history-kind"><Icon size={14} />{meta.label}</span>
                  <span className="history-text">{record.questionText || '(无题目文本)'}</span>
                  <span className="history-meta">
                    {formatTime(record.time)}
                    {record.subject ? ` · ${record.subject}` : ''}
                    {record.durationMs ? ` · ${formatDuration(record.durationMs)}` : ''}
                    {record.hasResult ? '' : ' · 无快照'}
                  </span>
                </button>
              );
            })}
          </div>
          {error && <div className="notice error">{error}</div>}
          {totalPages > 1 && (
            <div className="pager">
              <button type="button" className="ghost-button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>
                上一页
              </button>
              <span>
                第 {page} / {totalPages} 页 · 共 {data.total} 条
              </span>
              <button
                type="button"
                className="ghost-button"
                disabled={page >= totalPages}
                onClick={() => setPage((value) => value + 1)}
              >
                下一页
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="result-panel">
        <div className="panel-head">
          <div>
            <span className="panel-kicker">STEP 02</span>
            <h2>回看结果</h2>
          </div>
        </div>
        {detailLoading ? (
          <div className="result-empty is-loading">
            <LoaderCircle className="spin" size={27} />
            <strong>正在读取这条记录</strong>
          </div>
        ) : detail && !detail.result ? (
          <div className="result-empty">
            <div className="empty-orbit"><Clock size={25} /></div>
            <strong>这条记录没有结果快照</strong>
            <span>它产生于本次升级之前，只留下了题目文本和时间。</span>
          </div>
        ) : (
          <ResultPanel
            mode={detail?.kind ?? 'solve'}
            result={detail?.result ?? null}
            busy={false}
            onExportWord={detail?.result ? exportDetail : null}
            onPrint={detail?.result ? printPage : null}
          />
        )}
      </section>
    </>
  );
}
