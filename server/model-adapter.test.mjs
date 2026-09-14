import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDemoResult,
  buildLocalChatPayload,
  buildChineseTeacherInstruction,
  buildLocalGeneratePayload,
  buildMathSolvePayload,
  buildScienceSolvePayload,
  buildScienceChatPayload,
  getRuntimeConfig,
  isMathTask,
  isScienceTask,
  normalizeTaskResult,
  parseModelJson,
  runVisionTask,
  requestJsonNoTimeout,
  resetScienceCooldown,
  scienceRequestOptions,
  visionRequestOptions,
  ensureVisibleAnswer,
} from './model-adapter.mjs';
import http from 'node:http';

test('demo solver result has structured teaching sections', () => {
  const result = buildDemoResult('solve');

  assert.equal(result.mode, 'demo');
  assert.equal(result.kind, 'solve');
  assert.equal(typeof result.answer, 'string');
  assert.ok(result.steps.length >= 2);
  assert.ok(result.knowledgePoints.length >= 1);
});

test('model output is normalized even when optional fields are absent', () => {
  const result = normalizeTaskResult(
    { answer: '42', steps: ['先观察', '再计算'] },
    'grade',
  );

  assert.equal(result.kind, 'grade');
  assert.equal(result.answer, '42');
  assert.deepEqual(result.steps, ['先观察', '再计算']);
  assert.equal(result.scorePercent, 0);
  assert.deepEqual(result.knowledgePoints, []);
});

test('math output aliases are normalized into the fields rendered by the result panel', () => {
  const result = normalizeTaskResult(
    {
      mode: 'math',
      finalAnswer: 'x=2',
      solutionSteps: ['2x=4', 'x=2'],
      keyideas: ['移项并化简'],
      knowledgepoints: ['一元一次方程'],
    },
    'solve',
  );

  assert.equal(result.answer, 'x=2');
  assert.deepEqual(result.steps, ['2x=4', 'x=2']);
  assert.deepEqual(result.keyIdeas, ['移项并化简']);
  assert.deepEqual(result.knowledgePoints, ['一元一次方程']);
});

test('empty math output keeps a visible diagnostic instead of rendering a blank answer', () => {
  const result = normalizeTaskResult({ mode: 'math' }, 'solve');

  assert.match(result.answer, /\u6ca1\u6709\u8fd4\u56de\u53ef\u663e\u793a\u7684\u6570\u5b66\u7b54\u6848/);
  assert.ok(result.suggestions.length >= 1);
});

test('math explanation is promoted to the answer when the model leaves answer empty', () => {
  const result = normalizeTaskResult(
    {
      mode: 'math',
      answer: '',
      explanation: '由 e^x > 1+x 可得最终结论。',
    },
    'solve',
  );

  assert.equal(result.answer, '由 e^x > 1+x 可得最终结论。');
});

test('math service failure is surfaced instead of returning a blank fallback', async () => {
  const originalFetch = global.fetch;
  let mathCalls = 0;
  global.fetch = async (url) => {
    if (String(url).endsWith('/models')) {
      return { ok: true, json: async () => ({ data: [{ id: 'vision-model' }] }) };
    }
    if (String(url).endsWith('/math/health')) {
      return { ok: true, json: async () => ({ available: true }) };
    }
    if (String(url).endsWith('/math/solve')) {
      mathCalls += 1;
      throw new Error('math model timeout');
    }
    if (String(url).endsWith('/chat/completions')) {
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({
            subject: '\u6570\u5b66',
            problemText: '\u8bc1\u660e\uff1ae^x > ln x + 2',
            answer: '',
          }) } }],
        }),
      };
    }
    throw new Error(`unexpected URL ${url}`);
  };

  try {
    await assert.rejects(
      runVisionTask('solve', {
        imageDataUrl: 'data:image/png;base64,ZmFrZQ==',
        deepThink: true,
      }, { mathRequest: async () => {
        mathCalls += 1;
        throw new Error('math model timeout');
      }}),
      /math model timeout/,
    );

    assert.equal(mathCalls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('math stays on the vision result unless deep thinking is selected', async () => {
  const originalFetch = global.fetch;
  let mathCalls = 0;
  global.fetch = async (url) => {
    if (String(url).endsWith('/models')) {
      return { ok: true, json: async () => ({ data: [{ id: 'vision-model' }] }) };
    }
    if (String(url).endsWith('/chat/completions')) {
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({
            subject: '数学',
            problemText: '解方程 2x=4',
            answer: 'x=2',
          }) } }],
        }),
      };
    }
    if (String(url).endsWith('/math/health')) {
      mathCalls += 1;
      return { ok: true, json: async () => ({ available: true }) };
    }
    throw new Error(`unexpected URL ${url}`);
  };

  try {
    const result = await runVisionTask('solve', {
      imageDataUrl: 'data:image/png;base64,ZmFrZQ==',
      deepThink: false,
    });

    assert.equal(result.answer, 'x=2');
    assert.equal(result.mode, 'local-vision');
    assert.equal(mathCalls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('non-math tasks stay on the vision model even with deep thinking selected', async () => {
  const originalFetch = global.fetch;
  let mathCalls = 0;
  global.fetch = async (url) => {
    if (String(url).endsWith('/models')) {
      return { ok: true, json: async () => ({ data: [{ id: 'vision-model' }] }) };
    }
    if (String(url).endsWith('/math/health')) {
      mathCalls += 1;
      return { ok: true, json: async () => ({ available: true }) };
    }
    if (String(url).endsWith('/chat/completions')) {
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({
            subject: '英语',
            problemText: 'Translate this sentence.',
            answer: '请翻译这个句子。',
          }) } }],
        }),
      };
    }
    throw new Error(`unexpected URL ${url}`);
  };

  try {
    const result = await runVisionTask('grade', {
      imageDataUrl: 'data:image/png;base64,ZmFrZQ==',
      deepThink: true,
    });

    assert.equal(result.answer, '请翻译这个句子。');
    assert.equal(mathCalls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('local runtime defaults to llama.cpp and sends image data through the OpenAI-compatible schema', () => {
  const config = getRuntimeConfig({});
  const payload = buildLocalChatPayload('solve', {
    imageDataUrl: 'data:image/jpeg;base64,ZmFrZQ==',
    prompt: '请讲清楚关键步骤',
  });

  assert.equal(config.runtime, 'llama.cpp');
  assert.equal(config.baseUrl, 'http://127.0.0.1:8080/v1');
  assert.equal(config.model, 'Qwen/Qwen3-VL-4B-Instruct-GGUF');
  assert.equal(payload.stream, false);
  assert.equal(payload.messages[1].content[1].type, 'image_url');
  assert.equal(payload.messages[1].content[1].image_url.url, 'data:image/jpeg;base64,ZmFrZQ==');
});

test('model JSON with LaTeX backslashes is parsed into structured fields', () => {
  const parsed = parseModelJson(
    '{"answer":"方程 \\\\(2x+3=7\\\\) 的解是 \\\\(x=2\\\\)。","steps":["两边减去 3"]}',
  );

  assert.equal(parsed.answer, '方程 \\(2x+3=7\\) 的解是 \\(x=2\\)。');
  assert.deepEqual(parsed.steps, ['两边减去 3']);
});

test('vision requests carry the task instruction and image', () => {
  const instruction = buildChineseTeacherInstruction();
  const payload = buildLocalChatPayload('solve', {
    imageDataUrl: 'data:image/jpeg;base64,ZmFrZQ==',
    prompt: '',
  });

  assert.match(instruction, /AI教师/);
  assert.equal(payload.messages[0].role, 'system');
  assert.match(payload.messages[1].content[0].text, /读取图片/);
});

test('vision prompts include local OCR text as a second reading signal', () => {
  const payload = buildLocalChatPayload('solve', {
    imageDataUrl: 'data:image/jpeg;base64,ZmFrZQ==',
    ocrText: '解不等式 e^x > ln x + 2',
  });

  assert.match(payload.messages[1].content[0].text, /本地 OCR 识别结果/);
  assert.match(payload.messages[1].content[0].text, /e\^x > ln x \+ 2/);
});

test('question generation requests carry the task instruction', () => {
  const payload = buildLocalGeneratePayload({
    stage: '小学',
    subject: '数学',
    knowledgePointName: '分数',
    questionType: '解答题',
    difficulty: '基础',
  });

  assert.equal(payload.messages[0].role, 'system');
  assert.match(payload.messages[0].content, /AI教师/);
  assert.match(payload.messages[1].content, /生成一道/);
});

test('math task detection recognizes an explicitly classified math result', () => {
  assert.equal(isMathTask({ subject: '\u6570\u5b66', answer: 'x=2' }), true);
  assert.equal(isMathTask({ subject: '\u82f1\u8bed', answer: 'x=2' }), false);
});

test('science task detection recognizes physics, chemistry, biology, and geography', () => {
  for (const subject of ['物理', '化学', '生物', '地理']) {
    assert.equal(isScienceTask({ subject }), true, subject);
  }
  assert.equal(isScienceTask({ subject: '语文' }), false);
  assert.equal(isScienceTask({ subject: '数学' }), false);
});

test('deep science routes natural science tasks to the science model', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push(String(url));
    if (String(url).endsWith('/models')) {
      return { ok: true, json: async () => ({ data: [{ id: 'vision-model' }] }) };
    }
    if (String(url).endsWith('/chat/completions')) {
      const body = JSON.parse(options.body);
      const isScience = body.model === 'Intern-S1-mini';
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(isScience
            ? { subject: '物理', answer: '由牛顿第二定律可得。', steps: ['列出受力关系。'] }
            : { subject: '物理', problemText: '求物体加速度', answer: 'a=F/m' }) } }],
        }),
      };
    }
    throw new Error(`unexpected URL ${url}`);
  };

  try {
    const result = await runVisionTask('solve', {
      imageDataUrl: 'data:image/png;base64,ZmFrZQ==',
      deepThink: true,
    });

    assert.equal(result.mode, 'science');
    assert.equal(result.answer, '由牛顿第二定律可得。');
    assert.equal(calls.filter((url) => url.endsWith('/chat/completions')).length, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test('science solve payload preserves the image for multimodal science models', () => {
  const payload = buildScienceSolvePayload({
    imageDataUrl: 'data:image/png;base64,ZmFrZQ==',
    problemText: '求物体加速度',
    answerText: '学生答案',
    kind: 'grade',
  });

  assert.equal(payload.kind, 'grade');
  assert.equal(payload.imageDataUrl, 'data:image/png;base64,ZmFrZQ==');
  assert.equal(payload.problem, '求物体加速度');
});

// Intern-S1-mini reads the picture plus a field list, decides there is nothing to
// answer, and returns every field empty unless the question the vision model
// already extracted is handed over in the prompt. That produced a blank answer
// card in the UI.
test('the science prompt carries the problem the vision model already read', () => {
  const solved = buildLocalChatPayload('solve', {
    imageDataUrl: 'data:image/png;base64,ZmFrZQ==',
    problem: '喀斯特地貌成因',
  });
  const solvedText = solved.messages[1].content[0].text;
  assert.match(solvedText, /题目原文/);
  assert.match(solvedText, /喀斯特地貌成因/);
  assert.match(solvedText, /answer 字段给出完整解答/);

  const graded = buildLocalChatPayload('grade', {
    imageDataUrl: 'data:image/png;base64,ZmFrZQ==',
    problem: '求物体加速度',
    studentAnswer: 'a = F/m',
  });
  const gradedText = graded.messages[1].content[0].text;
  assert.match(gradedText, /求物体加速度/);
  assert.match(gradedText, /a = F\/m/);
  assert.match(gradedText, /verdict/);
});

test('vision prompts stay unchanged when no problem has been extracted yet', () => {
  const payload = buildLocalChatPayload('solve', {
    imageDataUrl: 'data:image/png;base64,ZmFrZQ==',
  });

  assert.doesNotMatch(payload.messages[1].content[0].text, /题目原文/);
  assert.doesNotMatch(payload.messages[1].content[0].text, /answer 字段给出完整解答/);
});

test('parser merges multiple JSON fragments returned by a local multimodal model', () => {
  const parsed = parseModelJson(
    '{"answer":"图片内容看不清。","steps":[]}\n\n{"keyIdeas":["请补充清晰图片"]}\n\n{"knowledgePoints":["题目识别"]}',
  );

  assert.equal(parsed.answer, '图片内容看不清。');
  assert.deepEqual(parsed.keyIdeas, ['请补充清晰图片']);
  assert.deepEqual(parsed.knowledgePoints, ['题目识别']);
});

test('parser removes markdown fences and preserves raw LaTeX in a model JSON response', () => {
  const modelOutput = [
    '```json',
    String.raw`{"answer":"证明：设 \(f(x)=\frac{1}{x}\)，则 \(f(x)=\frac{1}{x}\) 在 \(x>0\) 时单调递减。","steps":["设 \(f(x)=\frac{1}{x}\)","求导得 \(f'(x)=-\frac{1}{x^2}<0\)"],"keyIdeas":["函数单调性定义"],"knowledgePoints":["函数单调性定义","反比例函数"]}`,
    '```',
  ].join('\n');

  const parsed = parseModelJson(modelOutput);

  assert.equal(parsed.parseError, undefined);
  assert.equal(parsed.answer, String.raw`证明：设 \(f(x)=\frac{1}{x}\)，则 \(f(x)=\frac{1}{x}\) 在 \(x>0\) 时单调递减。`);
  assert.deepEqual(parsed.steps, [
    String.raw`设 \(f(x)=\frac{1}{x}\)`,
    String.raw`求导得 \(f'(x)=-\frac{1}{x^2}<0\)`,
  ]);
});

test('parser preserves malformed model text for markdown display', () => {
  const parsed = parseModelJson('这不是 JSON，也不是可以展示给学生的答案。');

  assert.equal(parsed.answer, '这不是 JSON，也不是可以展示给学生的答案。');
  assert.deepEqual(parsed.steps, []);
});

test('plain-text generated questions populate the fields used by the result panel', () => {
  const parsed = normalizeTaskResult(
    {
      answer: [
        '**题目：**',
        '下列各数中，属于有理数的是（ ）',
        'A. π',
        'B. √2',
        'C. 0.333…',
        'D. -1.25',
        '',
        '**答案：** D',
        '',
        '**解析：**',
        '有限小数可以化为分数，因此 -1.25 是有理数。',
      ].join('\n'),
    },
    'generate',
  );

  assert.match(parsed.question, /属于有理数/);
  assert.match(parsed.question, /D\. -1\.25/);
  assert.equal(parsed.referenceAnswer, 'D');
  assert.match(parsed.explanation, /有限小数/);
});

test('parser unwraps a JSON object nested inside the answer field', () => {
  const nested = JSON.stringify({
    answer: '最终答案：8',
    steps: ['先计算 5 + 3 = 8。'],
    keyIdeas: ['先列式，再计算。'],
  });
  const parsed = parseModelJson(JSON.stringify({ answer: `\`\`\`json\n${nested}\n\`\`\`` }));

  assert.equal(parsed.answer, '最终答案：8');
  assert.deepEqual(parsed.steps, ['先计算 5 + 3 = 8。']);
  assert.deepEqual(parsed.keyIdeas, ['先列式，再计算。']);
});

test('vision task retries malformed local JSON without leaking the raw response', async () => {
  const originalFetch = global.fetch;
  let completionCalls = 0;
  global.fetch = async (url) => {
    if (String(url).endsWith('/models')) {
      return { ok: true, json: async () => ({ data: [{ id: 'local-test-model' }] }) };
    }
    if (String(url).endsWith('/math/health')) {
      return { ok: true, json: async () => ({ available: false }) };
    }
    completionCalls += 1;
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content:
                completionCalls === 1
                  ? '```json\n这不是有效 JSON\n```'
                  : '{"answer":"答案是 8。","steps":["计算 5 + 3 = 8。"],"keyIdeas":["先列式再计算。"],"knowledgePoints":["加法"]}',
            },
          },
        ],
      }),
    };
  };

  try {
    const result = await runVisionTask('solve', {
      imageDataUrl: 'data:image/jpeg;base64,ZmFrZQ==',
    });

    assert.equal(completionCalls, 1);
    assert.match(result.answer, /这不是有效 JSON/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('vision task retries a conservative unclear-image result with an OCR-first instruction', async () => {
  const originalFetch = global.fetch;
  let completionCalls = 0;
  const requestBodies = [];
  global.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/models')) {
      return { ok: true, json: async () => ({ data: [{ id: 'local-test-model' }] }) };
    }
    completionCalls += 1;
    requestBodies.push(JSON.parse(options.body));
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content:
                completionCalls === 1
                  ? '{"answer":"图片内容看不清","steps":[],"keyIdeas":[],"knowledgePoints":[]}'
                  : '{"answer":"答案是 8。","steps":["先计算 5 + 3 = 8。"],"keyIdeas":["先读题再列式。"],"knowledgePoints":["加法"]}',
            },
          },
        ],
      }),
    };
  };

  try {
    const result = await runVisionTask('solve', {
      imageDataUrl: 'data:image/jpeg;base64,ZmFrZQ==',
    });

    assert.equal(completionCalls, 1);
    assert.equal(result.answer, '图片内容看不清');
  } finally {
    global.fetch = originalFetch;
  }
});

test('vision task retries a mathematically inconsistent derivative proof', async () => {
  const originalFetch = global.fetch;
  let completionCalls = 0;
  const requestBodies = [];
  global.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/models')) {
      return { ok: true, json: async () => ({ data: [{ id: 'local-test-model' }] }) };
    }
    if (String(url).endsWith('/math/health')) {
      return { ok: true, json: async () => ({ available: false }) };
    }
    completionCalls += 1;
    requestBodies.push(JSON.parse(options.body));
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content:
                completionCalls === 1
                  ? JSON.stringify({
                      answer: '证明成立',
                      steps: ["计算 f'(x)=e^x-1/x。", "当 x>0 时，f'(x)>0，函数单调递增。"],
                      keyIdeas: ['利用单调性'],
                      knowledgePoints: ['导数'],
                    })
                  : JSON.stringify({
                      answer: '不等式成立',
                      steps: ['由 e^x>1+x，且 ln x<=x-1，所以 e^x-ln x-2>0。'],
                      keyIdeas: ['使用基本不等式逐项估计'],
                      knowledgePoints: ['指数函数', '对数函数'],
                    }),
            },
          },
        ],
      }),
    };
  };

  try {
    const result = await runVisionTask('solve', {
      imageDataUrl: 'data:image/jpeg;base64,ZmFrZQ==',
    });

    assert.equal(completionCalls, 1);
    assert.equal(result.answer, '证明成立');
  } finally {
    global.fetch = originalFetch;
  }
});
test('math transport waits past the fetch response-header timeout', async () => {
  const server = http.createServer((request, response) => {
    setTimeout(() => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ answer: 'x=2' }));
    }, 25);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const result = await requestJsonNoTimeout('http://127.0.0.1:' + port + '/math/solve', { answer: 'x=2' });
    assert.deepEqual(result, { answer: 'x=2' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('science weights that are not downloaded yet skip the call and keep the vision answer', async () => {
  const originalFetch = global.fetch;
  let scienceCalls = 0;
  global.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/models')) {
      return { ok: true, json: async () => ({ data: [{ id: 'Intern-S1-mini' }] }) };
    }
    if (String(url).endsWith('/health')) {
      return {
        ok: true,
        json: async () => ({
          available: false,
          ready: false,
          missingFiles: ['tokenizer_config.json'],
          error: '缺少模型文件：tokenizer_config.json',
        }),
      };
    }
    if (String(url).endsWith('/chat/completions')) {
      const body = JSON.parse(options.body);
      if (body.model === 'Intern-S1-mini') scienceCalls += 1;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ subject: '化学', problemText: '配平方程式', answer: '2H2+O2=2H2O' }) } }],
        }),
      };
    }
    throw new Error(`unexpected URL ${url}`);
  };
  try {
    const result = await runVisionTask('solve', {
      imageDataUrl: 'data:image/png;base64,ZmFrZQ==',
      deepThink: true,
    });

    assert.equal(scienceCalls, 0, 'science model must not be called without weights');
    assert.equal(result.mode, 'local-vision');
    assert.equal(result.answer, '2H2+O2=2H2O');
  } finally {
    global.fetch = originalFetch;
  }
});

test('a failing science model falls back to the vision answer instead of throwing', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/models')) {
      return { ok: true, json: async () => ({ data: [{ id: 'Intern-S1-mini' }] }) };
    }
    if (String(url).endsWith('/health')) {
      return {
        ok: true,
        json: async () => ({ available: true, ready: false, device: 'cpu', dtype: 'bfloat16' }),
      };
    }
    if (String(url).endsWith('/chat/completions')) {
      const body = JSON.parse(options.body);
      if (body.model === 'Intern-S1-mini') {
        return { ok: false, status: 503, json: async () => ({ detail: 'model is still loading' }) };
      }
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ subject: '物理', problemText: '求物体加速度', answer: 'a=F/m' }) } }],
        }),
      };
    }
    throw new Error(`unexpected URL ${url}`);
  };
  try {
    const result = await runVisionTask('solve', {
      imageDataUrl: 'data:image/png;base64,ZmFrZQ==',
      deepThink: true,
    });

    assert.equal(result.mode, 'local-vision');
    assert.equal(result.answer, 'a=F/m');
    assert.ok(
      !/Intern-S1|Qwen|科学模型|视觉模型|数学模型|回退|不可用/.test(JSON.stringify(result)),
      'the fallback must stay invisible to the student',
    );
  } finally {
    global.fetch = originalFetch;
    // The failure above opened the cooldown breaker; later science tests need a
    // clean slate.
    resetScienceCooldown();
  }
});

test('science requests carry a deadline so a wedged server cannot hang the app', () => {
  assert.equal(scienceRequestOptions({}).timeoutMs, 240000);
  assert.equal(scienceRequestOptions({ SCIENCE_MODEL_TIMEOUT_MS: '90000' }).timeoutMs, 90000);
  assert.equal(scienceRequestOptions({ SCIENCE_MODEL_TIMEOUT_MS: '0' }).timeoutMs, 240000);
  assert.equal(scienceRequestOptions({ SCIENCE_MODEL_TIMEOUT_MS: 'abc' }).timeoutMs, 240000);
});

// Every solve/grade request goes through the vision model, and that server can
// wedge the same way the science one does: request accepted, prompt counted, no
// token ever produced. Without a deadline the student stares at a spinner with
// no answer and no error, which is exactly what "没有输出" looks like.
test('vision requests carry a deadline so a wedged server fails instead of hanging', () => {
  assert.equal(visionRequestOptions({}).timeoutMs, 180000);
  assert.equal(visionRequestOptions({ VISION_MODEL_TIMEOUT_MS: '45000' }).timeoutMs, 45000);
  assert.equal(visionRequestOptions({ VISION_MODEL_TIMEOUT_MS: '0' }).timeoutMs, 180000);
  assert.equal(visionRequestOptions({ VISION_MODEL_TIMEOUT_MS: 'abc' }).timeoutMs, 180000);
});

// A photo the vision model cannot read comes back as JSON with every field empty.
// Rendering that is a blank answer card, so the student gets a message and a
// concrete next step - never a model name, because the UI must not expose which
// model ran.
test('an empty result is replaced by an actionable message, not a blank card', () => {
  const empty = ensureVisibleAnswer({
    mode: 'local-vision',
    kind: 'solve',
    answer: '',
    steps: [],
    keyIdeas: [],
    knowledgePoints: [],
    suggestions: [],
  });

  assert.ok(empty.answer.length > 0);
  assert.ok(empty.suggestions.length > 0);
  const text = [empty.answer, ...empty.suggestions].join(' ');
  for (const forbidden of ['模型', 'Qwen', 'Intern', '本地视觉', '深度科学']) {
    assert.ok(!text.includes(forbidden), `提示文案不应出现「${forbidden}」`);
  }
});

test('a result that already has content is passed through untouched', () => {
  const filled = { mode: 'local-vision', kind: 'solve', answer: 'x = 4', steps: ['移项'], suggestions: [] };
  assert.equal(ensureVisibleAnswer(filled), filled);
});

test('a hung vision request reports a timeout instead of spinning forever', async () => {  const originalFetch = global.fetch;
  const originalTimeout = process.env.VISION_MODEL_TIMEOUT_MS;
  process.env.VISION_MODEL_TIMEOUT_MS = '80';
  global.fetch = async (url) => {
    if (String(url).endsWith('/models')) {
      return { ok: true, json: async () => ({ data: [{ id: 'Qwen3-VL-4B-Instruct' }] }) };
    }
    if (String(url).endsWith('/chat/completions')) {
      // Accepts the request, then never answers (the wedged-server pattern).
      return new Promise(() => {});
    }
    throw new Error(`unexpected URL ${url}`);
  };
  try {
    await assert.rejects(
      () => runVisionTask('solve', { imageDataUrl: 'data:image/png;base64,ZmFrZQ==', deepThink: false }),
      /超过 0 秒仍未返回|仍未返回/,
    );
  } finally {
    global.fetch = originalFetch;
    if (originalTimeout === undefined) delete process.env.VISION_MODEL_TIMEOUT_MS;
    else process.env.VISION_MODEL_TIMEOUT_MS = originalTimeout;
  }
});

// A wedged llama.cpp server keeps the port open, answers /health with "ok", and
// then never returns a single token. The student must get the vision answer
// quickly instead of waiting minutes, and the next question must not walk into
// the same trap.
test('a hung science request times out and puts the science model in cooldown', async () => {
  const originalFetch = global.fetch;
  const originalTimeout = process.env.SCIENCE_MODEL_TIMEOUT_MS;
  resetScienceCooldown();
  process.env.SCIENCE_MODEL_TIMEOUT_MS = '80';
  let scienceCalls = 0;
  global.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/models')) {
      return { ok: true, json: async () => ({ data: [{ id: 'Intern-S1-mini' }] }) };
    }
    if (String(url).endsWith('/health')) {
      return { ok: true, json: async () => ({ status: 'ok' }) };
    }
    if (String(url).endsWith('/chat/completions')) {
      const body = JSON.parse(options.body);
      if (body.model === 'Intern-S1-mini') {
        scienceCalls += 1;
        // Accepts the request, then never answers.
        return new Promise(() => {});
      }
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                subject: '地理',
                problemText: '喀斯特地貌成因',
                answer: '石灰岩被含二氧化碳的水溶蚀而成。',
              }),
            },
          }],
        }),
      };
    }
    throw new Error(`unexpected URL ${url}`);
  };
  try {
    const first = await runVisionTask('solve', {
      imageDataUrl: 'data:image/png;base64,ZmFrZQ==',
      deepThink: true,
    });

    assert.equal(scienceCalls, 1);
    assert.equal(first.mode, 'local-vision');
    assert.equal(first.answer, '石灰岩被含二氧化碳的水溶蚀而成。');
    assert.ok(
      !/Intern-S1|科学模型|没有返回任何内容|超时/.test(JSON.stringify(first)),
      'a timeout must fall back silently instead of being reported',
    );

    const second = await runVisionTask('solve', {
      imageDataUrl: 'data:image/png;base64,ZmFrZQ==',
      deepThink: true,
    });

    assert.equal(scienceCalls, 1, 'a cooling-down science model must not be called again');
    assert.equal(second.mode, 'local-vision');
    assert.equal(second.answer, '石灰岩被含二氧化碳的水溶蚀而成。');
    assert.ok(
      !/Intern-S1|科学模型|暂停|回退/.test(JSON.stringify(second)),
      'the cooldown must not be explained to the student',
    );
  } finally {
    global.fetch = originalFetch;
    resetScienceCooldown();
    if (originalTimeout === undefined) delete process.env.SCIENCE_MODEL_TIMEOUT_MS;
    else process.env.SCIENCE_MODEL_TIMEOUT_MS = originalTimeout;
  }
});

test('a llama.cpp style science endpoint is detected as available and used', async () => {
  const originalFetch = global.fetch;
  let scienceCalls = 0;
  global.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/models')) {
      return { ok: true, json: async () => ({ data: [{ id: 'Intern-S1-mini-Q8_0.gguf' }] }) };
    }
    if (String(url).endsWith('/health')) {
      return { ok: true, json: async () => ({ status: 'ok' }) };
    }
    if (String(url).endsWith('/chat/completions')) {
      const body = JSON.parse(options.body);
      if (body.model === 'Intern-S1-mini') {
        scienceCalls += 1;
        return {
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  subject: '物理',
                  problemText: '求物体加速度',
                  answer: 'a = F/m',
                  steps: ['由牛顿第二定律 F = ma 得 a = F/m。'],
                }),
              },
            }],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ subject: '物理', problemText: '求物体加速度' }) } }],
        }),
      };
    }
    throw new Error(`unexpected URL ${url}`);
  };
  try {
    const result = await runVisionTask('solve', {
      imageDataUrl: 'data:image/png;base64,ZmFrZQ==',
      deepThink: true,
    });

    assert.equal(scienceCalls, 1, 'the llama.cpp science endpoint must be called');
    assert.equal(result.mode, 'science');
    assert.equal(result.answer, 'a = F/m');
    assert.equal(result.steps.length, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('a llama.cpp science endpoint that is still loading skips the call', async () => {
  const originalFetch = global.fetch;
  let scienceCalls = 0;
  global.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/models')) {
      return { ok: true, json: async () => ({ data: [{ id: 'Intern-S1-mini-Q8_0.gguf' }] }) };
    }
    if (String(url).endsWith('/health')) {
      return { ok: true, json: async () => ({ status: 'loading model' }) };
    }
    if (String(url).endsWith('/chat/completions')) {
      const body = JSON.parse(options.body);
      if (body.model === 'Intern-S1-mini') scienceCalls += 1;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ subject: '生物', problemText: '光合作用', answer: '光能转化学能' }) } }],
        }),
      };
    }
    throw new Error(`unexpected URL ${url}`);
  };
  try {
    const result = await runVisionTask('solve', {
      imageDataUrl: 'data:image/png;base64,ZmFrZQ==',
      deepThink: true,
    });

    assert.equal(scienceCalls, 0, 'a model that is still loading must not be called');
    assert.equal(result.mode, 'local-vision');
    assert.equal(result.answer, '光能转化学能');
  } finally {
    global.fetch = originalFetch;
  }
});

test('a science model that returns only empty fields falls back to the vision answer', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/models')) {
      return { ok: true, json: async () => ({ data: [{ id: 'Intern-S1-mini-Q8_0.gguf' }] }) };
    }
    if (String(url).endsWith('/health')) {
      return { ok: true, json: async () => ({ status: 'ok' }) };
    }
    if (String(url).endsWith('/chat/completions')) {
      const body = JSON.parse(options.body);
      if (body.model === 'Intern-S1-mini') {
        // Reproduces the real reply for a handwritten geography question: a schema
        // with every value empty, which rendered as a blank "最终答案" card.
        return {
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  subject: '地理',
                  problemText: '喀斯特地貌成因',
                  studentAnswer: '',
                  answer: '',
                  steps: '',
                  keyIdeas: '',
                  knowledgePoints: '',
                  scorePercent: '',
                  verdict: '',
                  mistakes: '',
                  suggestions: '',
                }),
              },
            }],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                subject: '地理',
                problemText: '喀斯特地貌成因',
                answer: '可溶性岩石在流水溶蚀作用下形成。',
              }),
            },
          }],
        }),
      };
    }
    throw new Error(`unexpected URL ${url}`);
  };

  try {
    const result = await runVisionTask('solve', {
      imageDataUrl: 'data:image/png;base64,ZmFrZQ==',
      deepThink: true,
    });

    assert.equal(result.mode, 'local-vision');
    assert.match(result.answer, /溶蚀/);
    assert.ok(
      !/Intern-S1|科学模型|没有返回可显示的内容|回退/.test(JSON.stringify(result)),
      'an empty specialised answer must fall back without telling the student',
    );
  } finally {
    global.fetch = originalFetch;
  }
});

// Intern-S1-mini opens a chain-of-thought block by default. Against the JSON-only
// teaching prompt it spends the whole token budget thinking and returns an empty
// `content`, so the science requests must switch thinking off.
test('science thinking is disabled by default and can be re-enabled', () => {
  assert.equal(scienceRequestOptions({}).disableThinking, true);
  assert.equal(scienceRequestOptions({ SCIENCE_ENABLE_THINKING: '0' }).disableThinking, true);
  assert.equal(scienceRequestOptions({ SCIENCE_ENABLE_THINKING: '1' }).disableThinking, false);
  assert.equal(scienceRequestOptions({ SCIENCE_ENABLE_THINKING: 'true' }).disableThinking, false);
});

test('science chat payloads disable thinking while vision payloads stay untouched', () => {
  const science = buildScienceChatPayload('solve', {
    imageDataUrl: 'data:image/png;base64,ZmFrZQ==',
    prompt: '求解',
  });
  assert.deepEqual(science.chat_template_kwargs, { enable_thinking: false });

  const vision = buildLocalChatPayload('solve', {
    imageDataUrl: 'data:image/png;base64,ZmFrZQ==',
    prompt: '求解',
  });
  assert.equal(vision.chat_template_kwargs, undefined);
});

test('an answer that only arrives in reasoning_content is still used', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/models')) {
      return { ok: true, json: async () => ({ data: [{ id: 'Intern-S1-mini-Q8_0.gguf' }] }) };
    }
    if (String(url).endsWith('/health')) {
      return { ok: true, json: async () => ({ status: 'ok' }) };
    }
    if (String(url).endsWith('/chat/completions')) {
      const body = JSON.parse(options.body);
      if (body.model === 'Intern-S1-mini') {
        return {
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                role: 'assistant',
                content: '',
                reasoning_content: JSON.stringify({ subject: '地理', answer: '季风气候' }),
              },
            }],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ subject: '地理', problemText: '判断气候类型' }) } }],
        }),
      };
    }
    throw new Error(`unexpected URL ${url}`);
  };
  try {
    const result = await runVisionTask('solve', {
      imageDataUrl: 'data:image/png;base64,ZmFrZQ==',
      deepThink: true,
    });

    assert.equal(result.mode, 'science');
    assert.equal(result.answer, '季风气候');
  } finally {
    global.fetch = originalFetch;
  }
});

// Intern-S1-mini labels its generated sections with 【题目】/【答案】/【解析】, while
// Qwen3-VL tends to use 题目： or **题目**. Both must split into the same fields.
test('generated sections are split for every header style the models use', () => {
  const bracket = normalizeTaskResult({
    answer: '【题目】\n物体受水平力 F，加速度 3 m/s²，质量 2 kg，求 F。\n【答案】\n\\[ F = 6 \\, \\text{N} \\]\n【解析】\n由牛顿第二定律 F = ma 得 F = 6 N。',
  }, 'generate');
  assert.equal(bracket.question, '物体受水平力 F，加速度 3 m/s²，质量 2 kg，求 F。');
  assert.equal(bracket.referenceAnswer, '\\[ F = 6 \\, \\text{N} \\]');
  assert.equal(bracket.explanation, '由牛顿第二定律 F = ma 得 F = 6 N。');

  const plain = normalizeTaskResult({
    answer: '题目：一盒彩笔 24 支，用去 1/3，还剩多少支？\n答案：16 支\n解析：24 × 1/3 = 8，24 - 8 = 16。',
  }, 'generate');
  assert.equal(plain.question, '一盒彩笔 24 支，用去 1/3，还剩多少支？');
  assert.equal(plain.referenceAnswer, '16 支');
  assert.equal(plain.explanation, '24 × 1/3 = 8，24 - 8 = 16。');
});
