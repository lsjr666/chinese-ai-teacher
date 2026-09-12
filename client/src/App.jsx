import { useEffect, useMemo, useState } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import {
  ArrowRight,
  BookOpen,
  Brain,
  Camera,
  CheckCircle2,
  CircleAlert,
  ClipboardCheck,
  Copy,
  FileQuestion,
  GraduationCap,
  Lightbulb,
  LoaderCircle,
  RefreshCw,
  ScanLine,
  Send,
  Settings2,
  Sparkles,
  Upload,
  Wifi,
} from 'lucide-react';
import { getRestoredTaskView } from './task-state.mjs';

const modes = [
  { id: 'solve', label: '拍照搜题', short: '解题', icon: ScanLine, description: '看懂题目，拆解思路' },
  { id: 'generate', label: '知识点命题', short: '命题', icon: FileQuestion, description: '按要求生成练习题' },
  { id: 'grade', label: '拍照批改', short: '批改', icon: ClipboardCheck, description: '识别过程，给出反馈' },
];

const stages = ['小学', '初中', '高中'];
const stageSubjects = {
  小学: ['语文', '数学', '英语'],
  初中: ['语文', '数学', '英语', '物理', '化学', '生物', '地理'],
  高中: ['语文', '数学', '英语', '物理', '化学', '生物', '地理'],
};
const questionTypesBySubject = {
  语文: ['选择题', '填空题', '阅读题', '作文题'],
  英语: ['选择题', '填空题', '阅读题', '作文题'],
  数学: ['选择题', '填空题', '解答题'],
  物理: ['选择题', '填空题', '解答题', '实验探究题'],
  化学: ['选择题', '填空题', '解答题', '实验探究题'],
  生物: ['选择题', '填空题', '解答题', '实验探究题'],
  地理: ['选择题', '填空题', '解答题'],
};
const difficulties = ['基础', '进阶', '挑战'];

function getQuestionTypes(subject) {
  return questionTypesBySubject[subject] ?? ['选择题', '填空题', '解答题'];
}

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

function ResultSection({ title, icon: Icon, children, tone = '' }) {
  return (
    <section className={`result-section ${tone}`}>
      <div className="result-section-title"><Icon size={17} /><span>{title}</span></div>
      {children}
    </section>
  );
}

function renderInlineMarkdown(text) {
  const parts = String(text ?? '').split(/(\$\$[\s\S]*?\$\$|\$[^$\n]+\$|\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, index) => {
    if (part.startsWith('$$') && part.endsWith('$$')) return <div className="math-block" key={index}>{part.slice(2, -2)}</div>;
    if (part.startsWith('$') && part.endsWith('$')) return <span className="math-inline" key={index}>{part.slice(1, -1)}</span>;
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>;
    return part;
  });
}

function MarkdownText({ value, className = '' }) {
  const source = String(value ?? '')
    .replace(/\\\(([^\n]*?)\\\)/g, '$$$1$$')
    .replace(/\\\[([\s\S]*?)\\\]/g, '$$$$$1$$$$')
    .replace(/#{3,}/g, '')
    .replace(/\*{2,}/g, '');
  const pieces = source.split(/(\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/g);
  return <div className={`markdown-text ${className}`}>{pieces.map((piece, index) => {
    const display = piece.startsWith('$$') && piece.endsWith('$$');
    const inline = piece.startsWith('$') && piece.endsWith('$');
    if (display || inline) {
      const formula = piece.slice(display ? 2 : 1, display ? -2 : -1);
      try {
        return <span className={display ? 'math-block' : 'math-inline'} key={index} dangerouslySetInnerHTML={{ __html: katex.renderToString(formula, { displayMode: display, throwOnError: false, strict: false }) }} />;
      } catch {
        return <span key={index}>{piece}</span>;
      }
    }
    return <span key={index}>{piece}</span>;
  })}</div>;
}

function ResultPanel({ mode, result, busy, onCopy }) {
  if (busy) {
    return (
      <div className="result-empty is-loading">
        <LoaderCircle className="spin" size={27} />
        <strong>模型正在推理</strong>
        <span>页面刷新后也会自动恢复，模型完成前不会返回空结果</span>
      </div>
    );
  }
  if (!result) {
    return (
      <div className="result-empty">
        <div className="empty-orbit"><Brain size={25} /></div>
        <strong>{mode === 'generate' ? '生成的题目会出现在这里' : '分析结果会出现在这里'}</strong>
        <span>{mode === 'grade' ? '上传作答照片，查看得分与改进建议' : '提交后将看到答案、过程和知识点'}</span>
      </div>
    );
  }
  return (
    <div className="result-content">
      {mode === 'generate' ? (
        <>
          <ResultSection title="生成题目" icon={FileQuestion}>
            <MarkdownText value={result.question || result.answer} className="question-text" />
            {result.options?.length > 0 && (
              <div className="option-list">{result.options.map((option) => <div key={option}>{option}</div>)}</div>
            )}
          </ResultSection>
          <ResultSection title="参考答案" icon={CheckCircle2} tone="answer-tone">
            <MarkdownText value={result.referenceAnswer} className="answer-text" />
            <MarkdownText value={result.explanation} />
          </ResultSection>
        </>
      ) : (
        <>
          {mode === 'grade' && (
            <div className="score-hero">
              <div><span>本次得分</span><strong>{result.scorePercent}<small>%</small></strong></div>
              <div className="score-ring" style={{ '--score': `${result.scorePercent * 3.6}deg` }}><span>{result.scorePercent}</span></div>
            </div>
          )}
          <ResultSection title={mode === 'grade' ? '批改结论' : '最终答案'} icon={mode === 'grade' ? ClipboardCheck : CheckCircle2} tone="answer-tone">
            <MarkdownText value={mode === 'grade' ? result.verdict : result.answer} className="answer-text" />
            {mode === 'grade' && <MarkdownText value={result.answer} />}
          </ResultSection>
          {result.steps?.length > 0 && (
            <ResultSection title="解题过程" icon={ArrowRight}>
              <ol className="step-list">{result.steps.map((step, index) => <li key={`${step}-${index}`}><span>{index + 1}</span><MarkdownText value={step} /></li>)}</ol>
            </ResultSection>
          )}
          {result.keyIdeas?.length > 0 && (
            <ResultSection title="关键思路" icon={Lightbulb}>
              <ul className="bullet-list">{result.keyIdeas.map((idea) => <li key={idea}><MarkdownText value={idea} /></li>)}</ul>
            </ResultSection>
          )}
          {mode === 'grade' && (
            <ResultSection title="改进建议" icon={Lightbulb}>
              <ul className="bullet-list">{[...(result.mistakes ?? []), ...(result.suggestions ?? [])].map((item) => <li key={item}><MarkdownText value={item} /></li>)}</ul>
            </ResultSection>
          )}
        </>
      )}
      {result.knowledgePoints?.length > 0 && (
        <div className="knowledge-row"><span>涉及知识点</span>{result.knowledgePoints.map((point) => <em key={point}>{point}</em>)}</div>
      )}
      <button className="copy-button" onClick={() => onCopy(result)}><Copy size={15} /> 复制结果</button>
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
  const [busy, setBusy] = useState(initialTask.busy);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [stage, setStage] = useState('小学');
  const [subject, setSubject] = useState('数学');
  const [pointId, setPointId] = useState('primary-math-fractions');
  const [questionType, setQuestionType] = useState('解答题');
  const [difficulty, setDifficulty] = useState('基础');
  const [deepThink, setDeepThink] = useState(() => Boolean(initialTask.task?.deepThink));
  const [activeTask, setActiveTask] = useState(initialTask.task);

  const filteredPoints = useMemo(
    () => points.filter((point) => point.stage === stage && point.subject === subject),
    [points, stage, subject],
  );

  const availableSubjects = stageSubjects[stage] ?? ['语文', '数学', '英语'];
  const availableQuestionTypes = getQuestionTypes(subject);
  const engines = [
    { key: 'vision', role: '视觉识别', name: 'Qwen3-VL', available: Boolean(health?.model?.available) },
    { key: 'math', role: '数学专用', name: 'Qwen2.5-Math', available: Boolean(health?.mathModel?.available) },
    { key: 'science', role: '深度科学', name: 'Intern-S1-mini', available: Boolean(health?.scienceModel?.available) },
  ];

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
    if (filteredPoints.length && !filteredPoints.some((point) => point.id === pointId)) setPointId(filteredPoints[0].id);
  }, [filteredPoints, pointId]);

  useEffect(() => {
    const list = stageSubjects[stage] ?? [];
    if (list.length && !list.includes(subject)) setSubject(list[0]);
  }, [stage, subject]);

  useEffect(() => {
    const list = getQuestionTypes(subject);
    if (list.length && !list.includes(questionType)) setQuestionType(list[0]);
  }, [subject, questionType]);

  useEffect(() => {
    if (activeTask?.mode === mode) return;
    setImage(null);
    setResult(null);
    setError('');
    if (activeTask) {
      setActiveTask(null);
      clearSavedTask();
    }
  }, [mode]);

  const currentMode = modes.find((item) => item.id === mode);
  const selectedPoint = points.find((point) => point.id === pointId);

  const submitImageTask = async () => {
    if (!image?.dataUrl) {
      setError('请先拍照或上传一张图片。');
      return;
    }
    setBusy(true);
    setError('');
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
    try {
      const data = await apiRequest('/api/generate', {
        method: 'POST',
        body: JSON.stringify({ stage, subject, knowledgePointId: pointId, questionType, difficulty }),
      });
      setResult(data.result);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const copyResult = async (value) => {
    // 复制出去的内容不包含「由哪个模型作答」的字段：走回退时用户不应察觉。
    const visible = { ...(value ?? {}) };
    delete visible.mode;
    await navigator.clipboard?.writeText(JSON.stringify(visible, null, 2));
    setToast('结果已复制');
    setTimeout(() => setToast(''), 1800);
  };

  const handleImage = (value) => {
    setImage(value);
    setError(value.error || '');
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><div className="brand-mark"><GraduationCap size={21} /></div><div><strong>中国人能教</strong></div></div>
        <div className="topbar-actions">
          <StatusPill connected={Boolean(health?.ok)} />
          <button className="icon-button" title="刷新连接状态" onClick={checkHealth}><RefreshCw size={17} /></button>
          <button className="icon-button" title="连接设置" onClick={() => setToast('电脑端服务默认地址：当前页面所在电脑的 8787 端口')}><Settings2 size={17} /></button>
        </div>
      </header>

      <main className="workspace">
        <aside className="side-rail">
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

          <div className={`work-grid ${mode === 'generate' ? 'generate-grid' : ''}`}>
            <section className="task-panel">
              <div className="panel-head"><div><span className="panel-kicker">STEP 01</span><h2>{mode === 'generate' ? '设置出题要求' : '上传照片'}</h2></div><span className="panel-icon">{mode === 'generate' ? <BookOpen size={18} /> : <Camera size={18} />}</span></div>
              {mode === 'generate' ? (
                <div className="form-stack">
                  <div className="form-row two"><label>学段<select value={stage} onChange={(event) => setStage(event.target.value)}>{stages.map((item) => <option key={item}>{item}</option>)}</select></label><label>学科<select value={subject} onChange={(event) => setSubject(event.target.value)}>{availableSubjects.map((item) => <option key={item}>{item}</option>)}</select></label></div>
                  <label>知识点<select value={pointId} onChange={(event) => setPointId(event.target.value)}>{filteredPoints.map((point) => <option key={point.id} value={point.id}>{point.name} · {point.description}</option>)}</select></label>
                  {selectedPoint && <div className="point-preview"><BookOpen size={16} /><div><strong>{selectedPoint.name}</strong><span>{selectedPoint.description}</span></div></div>}
                  <div className="form-row two"><label>题型<select value={questionType} onChange={(event) => setQuestionType(event.target.value)}>{availableQuestionTypes.map((item) => <option key={item}>{item}</option>)}</select></label><label>难度<select value={difficulty} onChange={(event) => setDifficulty(event.target.value)}>{difficulties.map((item) => <option key={item}>{item}</option>)}</select></label></div>
                  <button className="primary-button" onClick={generate} disabled={busy || !health?.ok}><Sparkles size={17} />{busy ? '电脑端生成中…' : '生成一道练习题'}<ArrowRight size={17} /></button>
                </div>
              ) : (
                <div className="form-stack">
                  <ImageDropzone mode={mode} image={image} onImage={handleImage} busy={busy} />
                  <label className="deep-think-option">
                    <input type="checkbox" checked={deepThink} onChange={(event) => setDeepThink(event.target.checked)} disabled={busy} />
                    <span className="checkbox-mark" aria-hidden="true"><CheckCircle2 size={14} /></span>
                    <span>深度思考（可能消耗较长时间）</span>
                  </label>
                  <div className="task-tip"><Lightbulb size={16} /><span>{mode === 'grade' ? '尽量拍全题目、完整作答过程和最终答案，批改会更准确。' : '保持文字清晰、光线均匀，数学公式尽量正对镜头。'}</span></div>
                  <button className="primary-button" onClick={submitImageTask} disabled={busy || !health?.ok}><Send size={17} />{busy ? '模型推理中…' : mode === 'grade' ? '开始批改' : '开始解题'}<ArrowRight size={17} /></button>
                </div>
              )}
              {error && <div className="notice error"><CircleAlert size={16} />{error}</div>}
              {!health?.ok && <div className="connection-help"><Wifi size={16} /><span>请让手机和电脑连接同一个手机热点，并确认电脑端服务已启动。</span></div>}
            </section>

            <section className="result-panel">
              <div className="panel-head"><div><span className="panel-kicker">STEP 02</span><h2>教师反馈</h2></div></div>
              <ResultPanel mode={mode} result={result} busy={busy} onCopy={copyResult} />
            </section>
          </div>

        </section>
      </main>
      {toast && <div className="toast"><CheckCircle2 size={16} />{toast}</div>}
    </div>
  );
}

export default App;
