import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  Brain,
  Camera,
  CheckCircle2,
  CircleAlert,
  ClipboardCheck,
  Clock,
  FileQuestion,
  GraduationCap,
  Layers,
  Lightbulb,
  LoaderCircle,
  Moon,
  RefreshCw,
  ScanLine,
  Send,
  Settings2,
  Sun,
  Type,
  Upload,
  Wifi,
} from 'lucide-react';
import { getRestoredTaskView } from './task-state.mjs';
import { ResultPanel } from './result-view.jsx';
import { HistoryPanel } from './history-panel.jsx';
import { exportWord, printPage } from './export.mjs';
import { SCALES, THEMES, initTheme, readScale, readTheme, saveScale, saveTheme, watchSystemTheme } from './theme.mjs';

const modes = [
  { id: 'solve', label: '拍照搜题', short: '解题', icon: ScanLine, description: '看懂题目，拆解思路' },
  { id: 'generate', label: '知识点命题', short: '命题', icon: FileQuestion, description: '按要求生成练习题' },
  { id: 'grade', label: '拍照批改', short: '批改', icon: ClipboardCheck, description: '识别过程，给出反馈' },
  { id: 'history', label: '历史记录', short: '记录', icon: Clock, description: '回看搜过、出过、改过的题' },
];

const stages = ['小学', '初中', '高中'];
const stageSubjects = {
  小学: ['语文', '数学', '英语'],
  初中: ['语文', '数学', '英语', '物理', '化学', '生物', '地理'],
  高中: ['语文', '数学', '英语', '物理', '化学', '生物', '地理'],
};
const difficulties = ['基础', '进阶', '挑战'];
const MAX_POINTS_PER_QUESTION = 3;

function getApiBase() {
  return localStorage.getItem('ai-teacher-server') || '';
}

const taskStorageKey = 'ai-teacher-active-task';

async function apiRequest(path, options = {}) {
  const base = getApiBase();
  const response = await fetch(`${base}${path}`, {
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

function readSavedTask() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(taskStorageKey) || 'null');
    return saved?.taskId && saved?.mode ? saved : null;
  } catch {
    return null;
  }
}

function saveTask(task) {
  sessionStorage.setItem(taskStorageKey, JSON.stringify(task));
}

function clearSavedTask() {
  sessionStorage.removeItem(taskStorageKey);
}

function getInitialTaskState() {
  const task = readSavedTask();
  return { task, ...getRestoredTaskView(task) };
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取图片失败，请重试。'));
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const maxSide = 1800;
        const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.84));
      };
      image.onerror = () => reject(new Error('图片解析失败，请换一张照片。'));
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// 题型必须同时适用于所有选中的知识点；没有交集时退化成并集（与服务端同一套规则）。
function intersectTypes(points) {
  const lists = points.map((point) => (point?.questionTypes?.length ? point.questionTypes : ['解答题']));
  if (!lists.length) return ['解答题'];
  if (lists.length === 1) return [...lists[0]];
  const shared = lists[0].filter((type) => lists.slice(1).every((list) => list.includes(type)));
  if (shared.length) return shared;
  const merged = [];
  for (const list of lists) for (const type of list) if (!merged.includes(type)) merged.push(type);
  return merged;
}

// 「一次出一张卷子」的配额：把总题数按 5:3:2 分给前三个可用题型，
// 剩下的零头补给最后一个，保证配额之和正好等于总题数。
function buildQuota(types, total) {
  const active = types.slice(0, 3);
  const quota = {};
  if (!active.length || total <= 0) return quota;
  const weights = [0.5, 0.3, 0.2].slice(0, active.length);
  const sum = weights.reduce((acc, value) => acc + value, 0);
  let assigned = 0;
  active.forEach((type, index) => {
    const value =
      index === active.length - 1
        ? Math.max(0, total - assigned)
        : Math.max(1, Math.round((total * weights[index]) / sum));
    quota[type] = value;
    assigned += value;
  });
  return quota;
}

function StatusPill({ connected }) {
  return (
    <div className={`status-pill ${connected ? 'is-online' : 'is-offline'}`}>
      <span className="status-dot" />
      <span>{connected ? '电脑已连接' : '等待电脑连接'}</span>
    </div>
  );
}

function ImageDropzone({ mode, image, onImage, busy }) {
  const inputId = `${mode}-image-input`;
  const handleFile = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      onImage({ dataUrl: await compressImage(file), name: file.name });
    } catch (error) {
      onImage({ error: error.message });
    }
  };

  return (
    <div className={`image-dropzone ${image?.dataUrl ? 'has-image' : ''}`}>
      {image?.dataUrl ? (
        <>
          <img src={image.dataUrl} alt="已选择的题目或作答照片" />
          <label className="image-replace" htmlFor={inputId}>
            <RefreshCw size={15} /> 更换照片
          </label>
        </>
      ) : (
        <label className="image-prompt" htmlFor={inputId}>
          <span className="upload-icon"><Camera size={25} /></span>
          <strong>{busy ? '正在处理照片…' : '拍一张清晰照片'}</strong>
          <span>支持题目、作答过程和整页作业</span>
          <span className="camera-hint"><Upload size={14} /> 点击上传或调用相机</span>
        </label>
      )}
      <input
        id={inputId}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleFile}
        disabled={busy}
      />
    </div>
  );
}

function App() {
  const [initialTask] = useState(getInitialTaskState);
  const [mode, setMode] = useState(initialTask.mode);
  const [health, setHealth] = useState(null);
  const [points, setPoints] = useState([]);
  const [image, setImage] = useState(initialTask.image);
  const [result, setResult] = useState(null);
  const [paper, setPaper] = useState([]);
  const [progress, setProgress] = useState(null);
  const [busy, setBusy] = useState(initialTask.busy);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [stage, setStage] = useState('小学');
  const [subject, setSubject] = useState('数学');
  const [pointIds, setPointIds] = useState(['primary-math-fractions']);
  const [questionType, setQuestionType] = useState('解答题');
  const [difficulty, setDifficulty] = useState('基础');
  const [deepThink, setDeepThink] = useState(() => Boolean(initialTask.task?.deepThink));
  const [activeTask, setActiveTask] = useState(initialTask.task);
  const [batchMode, setBatchMode] = useState(false);
  const [quota, setQuota] = useState({});
  const [themePref, setThemePref] = useState(() => readTheme());
  const [scale, setScale] = useState(() => readScale());

  const filteredPoints = useMemo(
    () => points.filter((point) => point.stage === stage && point.subject === subject),
    [points, stage, subject],
  );

  const selectedPoints = useMemo(
    () => pointIds.map((id) => filteredPoints.find((point) => point.id === id)).filter(Boolean),
    [pointIds, filteredPoints],
  );
  const availableQuestionTypes = useMemo(() => intersectTypes(selectedPoints), [selectedPoints]);
  const availableSubjects = stageSubjects[stage] ?? ['语文', '数学', '英语'];
  const quotaTotal = useMemo(
    () => Object.values(quota).reduce((acc, value) => acc + (Number(value) || 0), 0),
    [quota],
  );
  const engines = [
    { key: 'vision', role: '视觉识别', name: 'Qwen3-VL', available: Boolean(health?.model?.available) },
    { key: 'math', role: '数学专用', name: 'Qwen2.5-Math', available: Boolean(health?.mathModel?.available) },
    { key: 'science', role: '深度科学', name: 'S1-mini', available: Boolean(health?.scienceModel?.available) },
  ];

  const showToast = useCallback((message) => {
    setToast(message);
    setTimeout(() => setToast(''), 2400);
  }, []);

  const checkHealth = async () => {
    try {
      const data = await apiRequest('/api/health');
      setHealth(data);
      setError('');
    } catch (err) {
      setHealth(null);
      setError(`无法连接电脑端：${err.message}`);
    }
  };

  useEffect(() => {
    initTheme();
    return watchSystemTheme(() => setThemePref('system'));
  }, []);

  useEffect(() => {
    Promise.all([checkHealth(), apiRequest('/api/knowledge-points').then((data) => setPoints(data.items)).catch(() => {})]);
    const timer = setInterval(checkHealth, 10000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!activeTask?.taskId) return undefined;
    if (activeTask.image?.dataUrl) setImage(activeTask.image);
    let stopped = false;
    const poll = async () => {
      try {
        const data = await apiRequest(`/api/tasks/${activeTask.taskId}`);
        if (stopped || data.status === 'running') return;
        if (data.status === 'complete') setResult(data.result);
        else setError(data.error || '模型推理失败。');
        setBusy(false);
        clearSavedTask();
        setActiveTask(null);
      } catch (err) {
        if (!stopped) {
          setError(err.message);
          if (err.message.includes('任务不存在')) {
            setBusy(false);
            clearSavedTask();
            setActiveTask(null);
          }
        }
      }
    };
    setBusy(true);
    poll();
    const timer = setInterval(poll, 2500);
    return () => { stopped = true; clearInterval(timer); };
  }, [activeTask]);

  useEffect(() => {
    if (!filteredPoints.length) return;
    setPointIds((current) => {
      const kept = current.filter((id) => filteredPoints.some((point) => point.id === id));
      return kept.length ? kept : [filteredPoints[0].id];
    });
  }, [filteredPoints]);

  useEffect(() => {
    const list = stageSubjects[stage] ?? [];
    if (list.length && !list.includes(subject)) setSubject(list[0]);
  }, [stage, subject]);

  useEffect(() => {
    const list = availableQuestionTypes;
    if (!list.length) return;
    setQuestionType((current) => (list.includes(current) ? current : list[0]));
    setQuota((current) => {
      const next = {};
      for (const type of list) next[type] = Number(current[type]) || 0;
      return next;
    });
  }, [availableQuestionTypes]);

  useEffect(() => {
    if (activeTask?.mode === mode || mode === 'history') return;
    setImage(null);
    setResult(null);
    setPaper([]);
    setProgress(null);
    setError('');
    if (activeTask) {
      setActiveTask(null);
      clearSavedTask();
    }
  }, [mode]);

  const currentMode = modes.find((item) => item.id === mode);

  const togglePoint = (id) => {
    setPointIds((current) => {
      if (current.includes(id)) {
        return current.length > 1 ? current.filter((item) => item !== id) : current;
      }
      if (current.length >= MAX_POINTS_PER_QUESTION) {
        showToast(`一道题最多同时考查 ${MAX_POINTS_PER_QUESTION} 个知识点`);
        return current;
      }
      return [...current, id];
    });
  };

  const submitImageTask = async () => {
    if (!image?.dataUrl) {
      setError('请先拍照或上传一张图片。');
      return;
    }
    setBusy(true);
    setError('');
    setPaper([]);
    setProgress(null);
    try {
      const data = await apiRequest(`/api/${mode}`, {
        method: 'POST',
        body: JSON.stringify({ imageDataUrl: image.dataUrl, deepThink }),
      });
      if (!data.taskId) throw new Error('电脑端没有返回任务编号，请重试。');
      const saved = { taskId: data.taskId, mode, image, deepThink };
      saveTask(saved);
      setActiveTask(saved);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const generate = async () => {
    setBusy(true);
    setError('');
    setPaper([]);
    setProgress(null);
    try {
      const data = await apiRequest('/api/generate', {
        method: 'POST',
        body: JSON.stringify({
          stage,
          subject,
          knowledgePointIds: pointIds,
          questionType,
          difficulty,
        }),
      });
      setResult(data.result);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // 批量出题走 NDJSON 流式：一道题一出结果，边生成边显示。
  const generateBatch = async () => {
    const selections = Object.entries(quota)
      .filter(([, count]) => Number(count) > 0)
      .map(([type, count]) => ({ knowledgePointIds: pointIds, questionType: type, difficulty, count: Number(count) }));
    if (!selections.length) {
      setError('请至少给一种题型设置出题数量。');
      return;
    }
    setBusy(true);
    setError('');
    setResult(null);
    setPaper([]);
    setProgress({ done: 0, total: selections.reduce((acc, item) => acc + item.count, 0) });
    try {
      const response = await fetch(`${getApiBase()}/api/generate/batch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stage, subject, selections }),
      });
      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `请求失败（${response.status}）`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let done = 0;
      for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let chunk;
          try {
            chunk = JSON.parse(line);
          } catch {
            continue;
          }
          if (chunk.type === 'plan') {
            setProgress({ done: 0, total: chunk.total });
            if (chunk.errors?.length) showToast(chunk.errors[0]);
          } else if (chunk.type === 'question') {
            done += 1;
            setPaper((current) => [...current, { ...chunk.result, order: chunk.index, questionType: chunk.questionType, difficulty: chunk.difficulty, knowledgePointNames: chunk.knowledgePointNames }]);
            setProgress({ done, total: chunk.total });
          } else if (chunk.type === 'failed') {
            done += 1;
            setProgress({ done, total: chunk.total });
            setError(`第 ${chunk.index} 道题生成失败：${chunk.message}`);
          } else if (chunk.type === 'done') {
            setProgress({ done: chunk.succeeded, total: chunk.total });
            showToast(`已生成 ${chunk.succeeded} 道题${chunk.failed ? `，${chunk.failed} 道失败` : ''}`);
          }
        }
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      setTimeout(() => setProgress(null), 1200);
    }
  };

  const copyResult = async (value) => {
    // 复制出去的内容不包含「由哪个模型作答」的字段：走回退时用户不应察觉。
    const visible = { ...(value ?? {}) };
    delete visible.mode;
    await navigator.clipboard?.writeText(JSON.stringify(visible, null, 2));
    showToast('结果已复制');
  };

  const exportCurrent = (includeAnswer) => {
    const items = paper.length ? paper : result ? [result] : [];
    if (!items.length) return;
    exportWord({
      title: paper.length ? `${stage}${subject}练习卷` : `${stage}${subject} · ${questionType}`,
      subtitle: [stage, subject, ...pointIds.map((id) => filteredPoints.find((point) => point.id === id)?.name).filter(Boolean)].join(' '),
      filename: paper.length ? `${stage}${subject}练习卷` : `${stage}${subject}${questionType}`,
      results: items,
      includeAnswer,
    });
    showToast('已导出 Word 文档，可直接打开编辑或打印');
  };

  const handleImage = (value) => {
    setImage(value);
    setError(value.error || '');
  };

  const changeTheme = (value) => {
    setThemePref(value);
    saveTheme(value);
  };

  const changeScale = (value) => {
    setScale(value);
    saveScale(value);
  };

  const setQuotaValue = (type, value) => {
    setQuota((current) => ({ ...current, [type]: Math.max(0, Math.min(20, Math.floor(Number(value) || 0))) }));
  };

  return (
    <div className="app-shell">
      <header className="topbar no-print">
        <div className="brand"><div className="brand-mark"><GraduationCap size={21} /></div><div><strong>中国人能教</strong></div></div>
        <div className="topbar-actions">
          <label className="mini-field" title="主题">
            {themePref === 'dark' ? <Moon size={15} /> : themePref === 'system' ? <Settings2 size={15} /> : <Sun size={15} />}
            <select value={themePref} onChange={(event) => changeTheme(event.target.value)}>
              {THEMES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
          <label className="mini-field" title="字号">
            <Type size={15} />
            <select value={scale} onChange={(event) => changeScale(event.target.value)}>
              {SCALES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
          <StatusPill connected={Boolean(health?.ok)} />
          <button className="icon-button" title="刷新连接状态" onClick={checkHealth}><RefreshCw size={17} /></button>
        </div>
      </header>

      <main className="workspace">
        <aside className="side-rail no-print">
          <div className="rail-heading"><span>学习工作台</span><span className="rail-line" /></div>
          <nav className="mode-nav">
            {modes.map((item) => {
              const Icon = item.icon;
              return <button key={item.id} className={mode === item.id ? 'active' : ''} onClick={() => setMode(item.id)}><Icon size={18} /><span><strong>{item.label}</strong><small>{item.description}</small></span>{mode === item.id && <ArrowRight size={15} />}</button>;
            })}
          </nav>
          <div className="engine-status">
            <div className="rail-heading"><span>本地模型</span><span className="rail-line" /></div>
            {engines.map((engine) => (
              <div className={`engine-status-row ${engine.available ? 'is-ready' : ''}`} key={engine.key}>
                <span className="engine-dot" />
                <div><strong>{engine.role}</strong><span>{engine.name}</span></div>
              </div>
            ))}
          </div>
          <div className="rail-note"><Wifi size={17} /><div><strong>热点局域网</strong><span>{health?.connection?.urls?.[0] || '等待电脑地址'}</span></div></div>
        </aside>

        <section className="content">
          <div className="page-heading">
            <div><h1>{currentMode.label}</h1><p>{currentMode.description}</p></div>
          </div>

          {mode === 'history' ? (
            <div className="work-grid">
              <HistoryPanel apiRequest={apiRequest} onToast={showToast} />
            </div>
          ) : (
            <div className={`work-grid ${mode === 'generate' ? 'generate-grid' : ''}`}>
              <section className="task-panel">
                <div className="panel-head">
                  <div><span className="panel-kicker">STEP 01</span><h2>{mode === 'generate' ? '设置出题要求' : '上传照片'}</h2></div>
                  <span className="panel-icon">{mode === 'generate' ? <BookOpen size={18} /> : <Camera size={18} />}</span>
                </div>
                {mode === 'generate' ? (
                  <div className="form-stack">
                    <div className="form-row two">
                      <label>学段<select value={stage} onChange={(event) => setStage(event.target.value)}>{stages.map((item) => <option key={item}>{item}</option>)}</select></label>
                      <label>学科<select value={subject} onChange={(event) => setSubject(event.target.value)}>{availableSubjects.map((item) => <option key={item}>{item}</option>)}</select></label>
                    </div>
                    <div className="field-block">
                      <label>
                        知识点
                        <span className="field-hint">可多选，最多 {MAX_POINTS_PER_QUESTION} 个（复合知识点会融合在同一道题里）</span>
                      </label>
                      <div className="chip-row">
                        {filteredPoints.map((point) => (
                          <button
                            type="button"
                            key={point.id}
                            className={`chip ${pointIds.includes(point.id) ? 'is-active' : ''}`}
                            onClick={() => togglePoint(point.id)}
                          >
                            {point.name}
                          </button>
                        ))}
                      </div>
                      {selectedPoints.length > 0 && (
                        <div className="point-preview">
                          <BookOpen size={16} />
                          <div>
                            <strong>{selectedPoints.map((point) => point.name).join(' + ')}</strong>
                            <span>{selectedPoints.map((point) => point.description).join('；')}</span>
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="field-block">
                      <label>
                        题型
                        <span className="field-hint">只列出该知识点真正适合的题型</span>
                      </label>
                      <div className="chip-row">
                        {availableQuestionTypes.map((type) => (
                          <button
                            type="button"
                            key={type}
                            className={`chip ${questionType === type && !batchMode ? 'is-active' : ''} ${batchMode ? 'is-muted' : ''}`}
                            onClick={() => setQuestionType(type)}
                            disabled={batchMode}
                          >
                            {type}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="form-row two">
                      <label>难度<select value={difficulty} onChange={(event) => setDifficulty(event.target.value)}>{difficulties.map((item) => <option key={item}>{item}</option>)}</select></label>
                      <label>
                        出题方式
                        <select value={batchMode ? 'batch' : 'single'} onChange={(event) => setBatchMode(event.target.value === 'batch')}>
                          <option value="single">单道出题</option>
                          <option value="batch">批量 / 一份卷子</option>
                        </select>
                      </label>
                    </div>

                    {batchMode && (
                      <div className="batch-box">
                        <div className="batch-head">
                          <strong><Layers size={15} /> 题型配额</strong>
                          <span>共 {quotaTotal} 道题</span>
                        </div>
                        <div className="quota-list">
                          {availableQuestionTypes.map((type) => (
                            <label className="quota-row" key={type}>
                              <span>{type}</span>
                              <input
                                type="number"
                                min="0"
                                max="20"
                                value={quota[type] ?? 0}
                                onChange={(event) => setQuotaValue(type, event.target.value)}
                              />
                            </label>
                          ))}
                        </div>
                        <div className="chip-row">
                          <button type="button" className="chip" onClick={() => setQuota(buildQuota(availableQuestionTypes, 6))}>6 道小练习</button>
                          <button type="button" className="chip" onClick={() => setQuota(buildQuota(availableQuestionTypes, 12))}>12 道单元卷</button>
                          <button type="button" className="chip" onClick={() => setQuota(buildQuota(availableQuestionTypes, 8))}>8 道巩固卷</button>
                          <button type="button" className="chip" onClick={() => setQuota({})}>清空</button>
                        </div>
                        <div className="task-tip"><Lightbulb size={16} /><span>每完成一道题就会立刻显示在右侧。批量出题会逐题生成，题越多越慢，建议一次不超过 12 道。</span></div>
                      </div>
                    )}

                    {batchMode ? (
                      <button className="primary-button" onClick={generateBatch} disabled={busy || !health?.ok || quotaTotal === 0}>
                        <Layers size={17} />{busy ? '正在生成…' : `生成 ${quotaTotal} 道题`}<ArrowRight size={17} />
                      </button>
                    ) : (
                      <button className="primary-button" onClick={generate} disabled={busy || !health?.ok}>
                        <FileQuestion size={17} />{busy ? '电脑端生成中…' : '生成一道练习题'}<ArrowRight size={17} />
                      </button>
                    )}
                    <div className="export-row">
                      <button type="button" className="ghost-button" onClick={() => exportCurrent(true)} disabled={!paper.length && !result}>
                        导出 Word（含答案）
                      </button>
                      <button type="button" className="ghost-button" onClick={() => exportCurrent(false)} disabled={!paper.length && !result}>
                        仅题目
                      </button>
                      <button type="button" className="ghost-button" onClick={printPage} disabled={!paper.length && !result}>
                        打印
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="form-stack">
                    <ImageDropzone mode={mode} image={image} onImage={handleImage} busy={busy} />
                    <label className="deep-think-option">
                      <input type="checkbox" checked={deepThink} onChange={(event) => setDeepThink(event.target.checked)} disabled={busy} />
                      <span className="checkbox-mark" aria-hidden="true"><CheckCircle2 size={14} /></span>
                      <span>深度思考（可能消耗较长时间）</span>
                    </label>
                    <div className="task-tip"><Lightbulb size={16} /><span>{mode === 'grade' ? '尽量拍全题目、完整作答过程和最终答案，批改会更准确。' : '保持文字清晰、光线均匀，数学公式尽量正对镜头；一页有多道题也可以一起拍。'}</span></div>
                    <button className="primary-button" onClick={submitImageTask} disabled={busy || !health?.ok}><Send size={17} />{busy ? '模型推理中…' : mode === 'grade' ? '开始批改' : '开始解题'}<ArrowRight size={17} /></button>
                    <div className="export-row">
                      <button type="button" className="ghost-button" onClick={() => exportCurrent(true)} disabled={!result}>
                        导出 Word
                      </button>
                      <button type="button" className="ghost-button" onClick={printPage} disabled={!result}>
                        打印
                      </button>
                    </div>
                  </div>
                )}
                {error && <div className="notice error"><CircleAlert size={16} />{error}</div>}
                {!health?.ok && <div className="connection-help"><Wifi size={16} /><span>请让手机和电脑连接同一个手机热点，并确认电脑端服务已启动。</span></div>}
              </section>

              <section className="result-panel">
                <div className="panel-head">
                  <div><span className="panel-kicker">STEP 02</span><h2>{mode === 'generate' ? '生成的题目' : '教师反馈'}</h2></div>
                  {busy && progress && <span className="panel-icon"><LoaderCircle className="spin" size={18} /></span>}
                </div>
                {busy && !paper.length && !result ? (
                  <ResultPanel mode={mode} result={null} results={[]} busy progress={progress} />
                ) : (
                  <>
                    {busy && progress && (
                      <div className="streaming-hint no-print">
                        <LoaderCircle className="spin" size={15} />
                        正在生成第 {progress.done} / {progress.total} 道题…
                      </div>
                    )}
                    <ResultPanel
                      mode={mode}
                      result={result}
                      results={paper}
                      busy={false}
                      onCopy={copyResult}
                      onExportWord={exportCurrent}
                      onPrint={printPage}
                    />
                  </>
                )}
              </section>
            </div>
          )}
        </section>
      </main>
      {toast && <div className="toast no-print"><CheckCircle2 size={16} />{toast}</div>}
    </div>
  );
}

export default App;
