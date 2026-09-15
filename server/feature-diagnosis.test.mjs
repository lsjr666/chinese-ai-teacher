import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureVisibleAnswer,
  buildLocalGeneratePayload,
  estimateGenerateTokens,
  isThinkingNoiseLine,
  normalizeTaskResult,
  parseModelJson,
  stripThinkingNoise,
} from './model-adapter.mjs';

// ---- 需求 1：题型与知识点必须对得上 ----

test('题型白名单挂在知识点上，每个知识点都有可选题型', async () => {
  const { getKnowledgePoints, resolveQuestionType, intersectQuestionTypes } = await import('./knowledge-points.mjs');
  const points = getKnowledgePoints();
  assert.ok(points.length >= 170);
  for (const point of points) {
    assert.ok(point.questionTypes.length > 0, `${point.stage}${point.subject}${point.name} 缺少题型白名单`);
  }
});

test('散文阅读不会给出作文题，写作只给作文题', async () => {
  const { getKnowledgePoints, resolveQuestionType, isQuestionTypeAllowed } = await import('./knowledge-points.mjs');
  const points = getKnowledgePoints();
  const prose = points.find((point) => point.name === '散文阅读');
  const writing = points.find((point) => point.stage === '初中' && point.name === '写作');
  assert.ok(!prose.questionTypes.includes('作文题'));
  assert.ok(prose.questionTypes.includes('阅读题'));
  assert.deepEqual(writing.questionTypes, ['作文题']);
  assert.equal(isQuestionTypeAllowed(prose, '作文题'), false);
  // 非法组合静默回落到白名单首项，而不是把矛盾要求递给模型
  assert.equal(resolveQuestionType(prose, '作文题'), prose.questionTypes[0]);
  assert.equal(resolveQuestionType(prose, '阅读题'), '阅读题');
});

test('数学不会出现阅读题，英语阅读题不带作文题', async () => {
  const { getKnowledgePoints } = await import('./knowledge-points.mjs');
  const points = getKnowledgePoints();
  for (const point of points.filter((item) => item.subject === '数学')) {
    assert.ok(!point.questionTypes.includes('阅读题'), `${point.name} 不应出现阅读题`);
    assert.ok(!point.questionTypes.includes('作文题'), `${point.name} 不应出现作文题`);
  }
  const englishReading = points.find((item) => item.stage === '初中' && item.name === '阅读理解');
  assert.ok(!englishReading.questionTypes.includes('作文题'));
});

test('复合知识点取题型交集，没有交集时退化为并集', async () => {
  const { getKnowledgePoints, intersectQuestionTypes } = await import('./knowledge-points.mjs');
  const points = getKnowledgePoints();
  const reading = points.find((point) => point.name === '散文阅读');
  const writing = points.find((point) => point.stage === '初中' && point.name === '写作');
  assert.deepEqual(intersectQuestionTypes([reading, reading]), reading.questionTypes);
  const merged = intersectQuestionTypes([reading, writing]);
  assert.ok(merged.includes('作文题'));
  assert.ok(merged.includes('阅读题'));
});

// ---- 需求 4：不输出自我纠错的思考过程 ----

test('思考过程的台词被识别并剔除，正常推理行保留', () => {
  assert.equal(isThinkingNoiseLine('嗯，让我先看看这道题。'), true);
  assert.equal(isThinkingNoiseLine('等等，刚才算错了，应该是 24 ÷ 3 = 8。'), true);
  assert.equal(isThinkingNoiseLine('让我重新想一下。'), true);
  assert.equal(isThinkingNoiseLine('先求用去的彩笔：24 × 1/3 = 8（支）。'), false);
  assert.equal(isThinkingNoiseLine('所以还剩 24 - 8 = 16（支）。'), false);
  assert.equal(isThinkingNoiseLine('hmm, let me rethink this.'), true);
});

test('整段过滤只留下正确路径，且不会返回空白', () => {
  const noisy = [
    '嗯，让我先看看这道题。',
    '去分母得 2x + 6 = 10。',
    '等等，刚才算错了，我重新来。',
    '解得 x = 2。',
  ].join('\n');
  assert.equal(stripThinkingNoise(noisy), '去分母得 2x + 6 = 10。\n解得 x = 2。');
  // 判定误伤时宁可原样保留，也不能把答案清空
  assert.equal(stripThinkingNoise('让我重新想一下'), '让我重新想一下');
});

test('归一化结果时顺手清掉 steps 与解析里的思考残留', () => {
  const result = normalizeTaskResult(
    {
      answer: 'x = 2',
      steps: ['嗯，让我先看看。', '两边减去 3 得 2x = 4。', '等等，我算错了，重来。'],
      explanation: '等等，我算错了，重来。\n系数化为 1 得 x = 2。',
    },
    'solve',
  );
  assert.deepEqual(result.steps, ['两边减去 3 得 2x = 4。']);
  assert.equal(result.explanation, '系数化为 1 得 x = 2。');
});

// ---- 需求 5/6/8：阅读原文、英语译文、图形说明 ----

test('新增字段被归一化，模型有地方放才会写', () => {
  const result = normalizeTaskResult(
    {
      question: '阅读下文，回答问题。',
      material: '秋天的雨，是一把钥匙……',
      translation: 'It is raining. 天在下雨。',
      figure: '矩形 ABCD 中，AB = 6，BC = 8，求对角线 AC。',
    },
    'generate',
  );
  assert.equal(result.material, '秋天的雨，是一把钥匙……');
  assert.equal(result.translation, 'It is raining. 天在下雨。');
  assert.equal(result.figure, '矩形 ABCD 中，AB = 6，BC = 8，求对角线 AC。');
});

test('只有阅读原文、没有答案时也算可见结果（不触发空卡片兜底）', () => {
  const result = ensureVisibleAnswer(normalizeTaskResult({ material: '一段阅读材料……' }, 'solve'));
  assert.equal(result.answer, '');
  assert.equal(result.material, '一段阅读材料……');
});

test('一张图多道题时按 questions 数组逐题归一化', () => {
  const result = normalizeTaskResult(
    {
      answer: '第一题答案',
      questions: [
        { index: 1, problemText: '1+1=?', answer: '2', steps: ['1+1=2'] },
        { question: '2+2=?', answer: '4' },
        { problemText: '', answer: '' },
      ],
    },
    'solve',
  );
  assert.equal(result.questions.length, 2);
  assert.equal(result.questions[1].problemText, '2+2=?');
  assert.equal(result.questions[0].steps.length, 1);
});

test('生成题的纯文本输出也能识别出阅读原文与译文', () => {
  const parsed = parseModelJson(
    ['请阅读下面的材料。', '【阅读材料】', '小草偷偷地从土里钻出来。', '【题目】', '作者描写了哪个季节？', '【答案】', '春季。', '【译文】', 'Spring.'].join('\n'),
  );
  const result = normalizeTaskResult({ ...parsed }, 'generate');
  assert.equal(result.material, '小草偷偷地从土里钻出来。');
  assert.equal(result.question, '作者描写了哪个季节？');
  assert.equal(result.referenceAnswer, '春季。');
  assert.equal(result.translation, 'Spring.');
});

// ---- 需求 3/4：复合知识点与更长的输出额度 ----

test('生成提示词带上多个知识点，并要求融合在同一道题里', () => {
  const payload = buildLocalGeneratePayload({
    stage: '高中',
    subject: '数学',
    knowledgePointNames: ['函数概念与性质', '导数及其应用'],
    questionType: '解答题',
    difficulty: '挑战',
  });
  const text = payload.messages[1].content;
  assert.match(text, /生成一道/);
  assert.match(text, /函数概念与性质/);
  assert.match(text, /导数及其应用/);
  assert.match(text, /融合进同一道题/);
  assert.match(text, /不要输出任何.*思考过程/);
});

test('阅读题、作文题拿到更多 token，普通题型保持精简', () => {
  assert.ok(estimateGenerateTokens({ questionType: '作文题' }) >= 4000);
  assert.ok(estimateGenerateTokens({ questionType: '阅读题' }) >= 4000);
  assert.ok(estimateGenerateTokens({ questionType: '选择题' }) >= 2400);
  assert.ok(estimateGenerateTokens({ questionType: '选择题' }) < estimateGenerateTokens({ questionType: '作文题' }));
});

test('出题请求的 max_tokens 明显大于原来的 1200，不会讲到一半就断', () => {
  const payload = buildLocalGeneratePayload({ stage: '小学', subject: '语文', knowledgePointName: '写作', questionType: '作文题', difficulty: '基础' });
  assert.ok(payload.max_tokens >= 4000);
});

// ---- 需求 7：数学可以改走 llama.cpp 快通道 ----
test('数学 llama.cpp 通道的提示词与 Python 服务保持一致的中文要求', async () => {
  const { buildMathLlamaPayload, buildMathLlamaPrompt, getRuntimeConfig } = await import('./model-adapter.mjs');
  const prompt = buildMathLlamaPrompt('/math/solve', { problem: '解方程 2x = 4', studentAnswer: '' });
  assert.match(prompt, /解方程 2x = 4/);
  assert.match(prompt, /所有字段一律使用简体中文作答/);
  assert.match(prompt, /不要写“让我重新想想”/);
  assert.match(prompt, /answer（最终答案字符串）/);
  assert.match(prompt, /steps（字符串数组/);
});

test('数学出题通道支持复合知识点，并要求图形说明', async () => {
  const { buildMathLlamaPrompt } = await import('./model-adapter.mjs');
  const prompt = buildMathLlamaPrompt('/math/generate', {
    stage: '高中',
    questionType: '解答题',
    knowledgePointNames: ['立体几何', '解析几何'],
    difficulty: '挑战',
  });
  assert.match(prompt, /立体几何、解析几何/);
  assert.match(prompt, /figure/);
});

test('数学运行时默认仍是 python，只有显式配置才切到 llama.cpp', async () => {
  const { getRuntimeConfig } = await import('./model-adapter.mjs');
  assert.equal(getRuntimeConfig({}).mathRuntime, 'python');
  assert.equal(getRuntimeConfig({ MATH_MODEL_RUNTIME: 'llama.cpp' }).mathRuntime, 'llama.cpp');
  const payload = (await import('./model-adapter.mjs')).buildMathLlamaPayload('/math/solve', { problem: 'x+1=2' }, { MATH_MODEL_NAME: 'Qwen2.5-Math-7B-Instruct-GGUF' });
  assert.equal(payload.model, 'Qwen2.5-Math-7B-Instruct-GGUF');
  assert.equal(payload.stream, false);
});

