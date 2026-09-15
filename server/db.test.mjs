import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildInsertSql,
  buildRecordsSql,
  buildIpStatsSql,
  buildEnsureSchemaSql,
  buildHistorySql,
  buildHistoryDetailSql,
  extractMarkedPayload,
  sanitizeValue,
  toSqlLiteral,
  resetDbTransport,
} from './db.mjs';

test('sanitizeValue 剔除 NUL 与危险控制字符', () => {
  assert.equal(sanitizeValue('a\0b\u0007c'), 'abc');
  assert.equal(sanitizeValue('正常中文123'), '正常中文123');
  assert.equal(sanitizeValue(undefined), '');
});

test('toSqlLiteral 转义单引号防注入', () => {
  assert.equal(toSqlLiteral(" Robert'); DROP TABLE Students;-- "), "N' Robert''); DROP TABLE Students;-- '");
  assert.equal(toSqlLiteral("it's"), "N'it''s'");
});

test('buildInsertSql 生成完整 INSERT', () => {
  const sql = buildInsertSql({
    clientIp: '192.168.1.8',
    kind: 'solve',
    subject: '数学',
    stage: '初中',
    questionText: "解方程 2x=4, it's easy",
    modelMode: 'local-vision',
    modelCalls: { requestId: 'abcd1234', kind: 'solve', stages: ['vision ok'] },
    durationMs: 78123.4,
  });
  assert.ok(sql.startsWith('INSERT INTO dbo.query_records'));
  assert.ok(sql.includes("N'192.168.1.8'"));
  assert.ok(sql.includes("N'数学'"));
  assert.ok(sql.includes("N'初中'"));
  assert.ok(sql.includes("N'local-vision'"));
  assert.ok(sql.includes(' 78123'));
  assert.ok(sql.includes("it''s"));
  // model_calls 一定是合法 JSON 字符串字面量
  const jsonMatch = sql.match(/N'(\{.*?\})'/);
  assert.ok(jsonMatch, 'model_calls 应为 JSON 字面量');
  const parsed = JSON.parse(jsonMatch[1].replace(/''/g, "'"));
  assert.equal(parsed.kind, 'solve');
  assert.deepEqual(parsed.stages, ['vision ok']);
});

test('buildInsertSql 可空字段渲染为 NULL', () => {
  const sql = buildInsertSql({ clientIp: '127.0.0.1', questionText: 'x' });
  assert.ok(sql.includes('NULL, NULL, NULL,'));
  assert.ok(sql.trimEnd().endsWith('NULL );'));
});

test('buildRecordsSql 分页与 IP 过滤（含注入转义）', () => {
  const sql = buildRecordsSql("1.2.3.4'; DROP TABLE x;--", 20, 20);
  assert.ok(sql.includes("WHERE client_ip = N'1.2.3.4''; DROP TABLE x;--'"));
  assert.ok(sql.includes('OFFSET 20 ROWS FETCH NEXT 20 ROWS ONLY'));
  assert.ok(sql.includes('FOR XML RAW;'));
  assert.ok(sql.includes("JSON_VALUE(model_calls, '$.kind')"));
  const noIp = buildRecordsSql('', 0, 10);
  assert.ok(!noIp.includes('WHERE'));
  assert.ok(noIp.includes('OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY'));
});

test('buildIpStatsSql 按客户端 IP 汇总', () => {
  const sql = buildIpStatsSql();
  assert.ok(sql.includes('GROUP BY client_ip'));
  assert.ok(sql.includes('ORDER BY MAX(id) DESC'));
});

test('buildInsertSql 顺带写入结果快照，供历史记录回看', () => {
  const sql = buildInsertSql({
    clientIp: '127.0.0.1',
    kind: 'generate',
    questionText: '出题：散文阅读',
    result: { question: '阅读下文', referenceAnswer: '春季' },
  });
  assert.ok(sql.includes('result_json'));
  assert.ok(sql.includes('阅读下文'));
  // 不传结果时保持 NULL，不写空 JSON
  const without = buildInsertSql({ clientIp: '127.0.0.1', questionText: 'x' });
  assert.ok(without.trimEnd().endsWith('NULL );'));
});

test('buildEnsureSchemaSql 幂等补列并建索引', () => {
  const sql = buildEnsureSchemaSql();
  assert.ok(sql.includes("COL_LENGTH('dbo.query_records', 'result_json') IS NULL"));
  assert.ok(sql.includes('ALTER TABLE dbo.query_records ADD result_json NVARCHAR(MAX) NULL'));
  assert.ok(sql.includes('IX_query_records_client_ip'));
});

test('buildHistorySql 支持按 IP 与题类过滤（含注入转义）', () => {
  const sql = buildHistorySql("1.2.3.4'; DROP TABLE x;--", 'generate', 0, 20);
  assert.ok(sql.includes("client_ip = N'1.2.3.4''; DROP TABLE x;--'"));
  assert.ok(sql.includes("ISNULL(JSON_VALUE(model_calls, '$.kind'), 'solve') = N'generate'"));
  assert.ok(sql.includes('OFFSET 0 ROWS FETCH NEXT 20 ROWS ONLY'));
  assert.ok(sql.includes('has_result'));
  const all = buildHistorySql('', '', 0, 10);
  assert.ok(!all.includes('WHERE'));
});

test('结果快照走前缀标记的纯文本通道，长 JSON 不会被 XML 截断', () => {
  const sql = buildHistoryDetailSql(42);
  assert.ok(sql.includes('AITJSON>>'));
  assert.ok(sql.includes('WHERE id = 42'));
  assert.equal(extractMarkedPayload('AITJSON>>{"a":1}\r\n'), '{"a":1}');
  assert.equal(extractMarkedPayload('无标记'), '');
});

