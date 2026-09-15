// 答题记录持久化：写入 SQL Server（本机默认 LocalDB 实例，可通过环境变量切换到正式实例/云端）。
// 设计原则：
//  1. 记录失败绝不影响答题主流程（静默降级，只写服务端日志）；
//  2. 双通道：优先原生 ODBC 驱动（msnodesqlv8，支持参数化），探测不通自动降级为 sqlcmd 命令行；
//  3. 迁移友好：连接串全部走环境变量（MSSQL_SERVER / MSSQL_DATABASE / MSSQL_USER / MSSQL_PASSWORD），
//     后续把库搬到云端只需改 .env，代码零改动。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 轻量 .env 加载（仅补缺，不覆盖已有环境变量），无需引入 dotenv 依赖
const __dbDirname = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.resolve(__dbDirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const DB_SERVER = process.env.MSSQL_SERVER ?? '(localdb)\\MSSQLLocalDB';
const DB_NAME = process.env.MSSQL_DATABASE ?? 'AITeacherDB';
const DB_USER = process.env.MSSQL_USER ?? '';
const DB_PASSWORD = process.env.MSSQL_PASSWORD ?? '';
const SQLCMD_EXE = process.env.MSSQL_SQLCMD ?? 'sqlcmd';
// 可强制指定通道：odbc | sqlcmd | off。默认 auto（先试 odbc，8 秒内没建立连接就降级 sqlcmd）。
const TRANSPORT_OVERRIDE = (process.env.DB_TRANSPORT ?? 'auto').toLowerCase();

let transport = null; // 'odbc' | 'sqlcmd' | 'off'
let odbcModule = null;
let warned = false;

const ODBC_PROBE_TIMEOUT_MS = Number(process.env.DB_PROBE_TIMEOUT_MS ?? 8000);
const SQLCMD_TIMEOUT_MS = Number(process.env.DB_SQLCMD_TIMEOUT_MS ?? 8000);

function log(message) {
  console.log('[db] ' + message);
}

function warnOnce(message) {
  if (!warned) {
    warned = true;
    console.warn('[db] ' + message);
  }
}

// ---- 值清洗：sqlcmd 通道是文本拼接，必须做转义；控制字符统一剔除 ----
export function sanitizeValue(value) {
  return String(value ?? '')
    .replace(/\0/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

export function toSqlLiteral(value) {
  return "N'" + sanitizeValue(value).replace(/'/g, "''") + "'";
}

export function buildInsertSql(record) {
  return [
    'INSERT INTO dbo.query_records',
    '(client_ip, user_name, subject, stage, question_text, model_mode, model_calls, duration_ms, result_json)',
    'VALUES (',
    [
      toSqlLiteral(record.clientIp ?? 'unknown'),
      record.userName ? toSqlLiteral(record.userName) : 'NULL',
      record.subject ? toSqlLiteral(record.subject) : 'NULL',
      record.stage ? toSqlLiteral(record.stage) : 'NULL',
      toSqlLiteral(record.questionText ?? ''),
      record.modelMode ? toSqlLiteral(record.modelMode) : 'NULL',
      toSqlLiteral(JSON.stringify(record.modelCalls ?? {})),
      Number.isFinite(record.durationMs) ? String(Math.round(record.durationMs)) : 'NULL',
      record.result ? toSqlLiteral(JSON.stringify(record.result)) : 'NULL',
    ].join(', '),
    ');',
  ].join(' ');
}

// 历史记录要能「点开回看」，只存题干是不够的，得把结果快照一起落库。
// 老库没有 result_json 列，这里做一次幂等补列（新增列一律可空，不影响既有数据）。
export function buildEnsureSchemaSql() {
  return [
    'SET NOCOUNT ON;',
    "IF COL_LENGTH('dbo.query_records', 'result_json') IS NULL",
    'ALTER TABLE dbo.query_records ADD result_json NVARCHAR(MAX) NULL;',
    "IF COL_LENGTH('dbo.query_records', 'client_ip') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_query_records_client_ip')",
    'CREATE INDEX IX_query_records_client_ip ON dbo.query_records (client_ip, id DESC);',
  ].join(' ');
}

// ---- 通道一：原生 ODBC 驱动（参数化查询，推荐） ----
async function loadOdbc() {
  if (odbcModule) return odbcModule;
  odbcModule = await import('msnodesqlv8');
  return odbcModule;
}

function odbcConnectionString() {
  const auth = DB_USER
    ? `UID=${DB_USER};PWD=${DB_PASSWORD};`
    : 'Trusted_Connection=Yes;';
  return `Server=${DB_SERVER};Database=${DB_NAME};Driver={ODBC Driver 17 for SQL Server};${auth}`;
}

export function insertViaOdbc(record) {
  const sql = odbcModule.default ?? odbcModule;
  const connStr = odbcConnectionString();
  return new Promise((resolve, reject) => {
    sql.query(
      connStr,
      `INSERT INTO dbo.query_records
        (client_ip, user_name, subject, stage, question_text, model_mode, model_calls, duration_ms, result_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        String(record.clientIp ?? 'unknown'),
        record.userName ?? null,
        record.subject ?? null,
        record.stage ?? null,
        String(record.questionText ?? ''),
        record.modelMode ?? null,
        JSON.stringify(record.modelCalls ?? {}),
        Number.isFinite(record.durationMs) ? Math.round(record.durationMs) : null,
        record.result ? JSON.stringify(record.result) : null,
      ],
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

// ---- 通道二：sqlcmd 命令行（无原生依赖，任何环境都能跑） ----
export function insertViaSqlcmd(record) {
  return new Promise((resolve, reject) => {
    const args = ['-S', DB_SERVER, '-d', DB_NAME];
    if (DB_USER) args.push('-U', DB_USER, '-P', DB_PASSWORD);
    else args.push('-E');
    // SQL 走 stdin（-Q 传参会被 Windows 命令行引号规则拆碎），-f 65001 = UTF-8
    args.push('-f', '65001', '-h', '-1');
    const child = spawn(SQLCMD_EXE, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('sqlcmd 写入超时'));
    }, SQLCMD_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`sqlcmd 退出码 ${code} ${stderr.slice(0, 200)}`));
    });
    child.stdin.end(buildInsertSql(record) + '\nGO\n', 'utf8');
  });
}

async function probeOdbc() {
  const sql = (await loadOdbc()).default ?? odbcModule;
  const connStr = odbcConnectionString();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), ODBC_PROBE_TIMEOUT_MS);
    try {
      sql.query(connStr, 'SELECT 1 AS ok', (error) => {
        clearTimeout(timer);
        finish(!error);
      });
    } catch {
      clearTimeout(timer);
      finish(false);
    }
  });
}

async function resolveTransport() {
  if (TRANSPORT_OVERRIDE === 'off') return 'off';
  if (TRANSPORT_OVERRIDE === 'odbc') return (await probeOdbc()) ? 'odbc' : 'sqlcmd';
  if (TRANSPORT_OVERRIDE === 'sqlcmd') return 'sqlcmd';
  // auto
  try {
    if (await probeOdbc()) return 'odbc';
    // LocalDB 实例可能处于停止态：进程内 ODBC 驱动无法触发其自动启动，会一直等。
    // 显式拉起实例后再试一次。
    if (/localdb/i.test(DB_SERVER) && (await tryStartLocalDb()) && (await probeOdbc())) {
      log('LocalDB 实例已拉起，答题记录走 odbc 通道。');
      return 'odbc';
    }
    log('原生 ODBC 连接未就绪，答题记录改走 sqlcmd 通道。');
  } catch (error) {
    log('原生 ODBC 加载失败（' + String(error.message ?? error).slice(0, 120) + '），答题记录改走 sqlcmd 通道。');
  }
  return 'sqlcmd';
}

function tryStartLocalDb() {
  return new Promise((resolve) => {
    const instance = DB_SERVER.split('\\')[1]?.replace(/\)$/, '').trim();
    if (!instance) return resolve(false);
    const child = spawn('sqllocaldb', ['start', instance], { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => {
      setTimeout(() => resolve(code === 0), 1500);
    });
    setTimeout(() => resolve(false), 10000);
  });
}

let schemaReady = false;

// 幂等补列：老库缺 result_json 时补上，并保证按 IP 查历史有索引可用。
// 失败不影响主流程 —— 只是历史记录里回看不到结果快照。
export async function ensureDbSchema() {
  if (schemaReady) return true;
  if (!transport) await initDbTransport();
  if (transport === 'off') return false;
  try {
    if (transport === 'odbc') {
      const sql = odbcModule.default ?? odbcModule;
      await new Promise((resolve, reject) => {
        sql.query(odbcConnectionString(), buildEnsureSchemaSql(), (error) => (error ? reject(error) : resolve()));
      });
    } else {
      await queryViaSqlcmdText(buildEnsureSchemaSql());
    }
    schemaReady = true;
    return true;
  } catch (error) {
    warnOnce('答题记录的 result_json 列补建失败（历史记录回看将不可用）：' + String(error.message ?? error).slice(0, 160));
    return false;
  }
}

export async function initDbTransport() {
  if (transport) return transport;
  transport = await resolveTransport();
  log(`答题记录通道：${transport}（服务器 ${DB_SERVER}，数据库 ${DB_NAME}）`);
  if (transport !== 'off') {
    const started = Date.now();
    const ok = await ensureDbSchema();
    log(`答题记录表结构检查${ok ? '通过' : '未完成'}（${Date.now() - started} ms）`);
  }
  return transport;
}

// 供测试复位状态
export function resetDbTransport() {
  transport = null;
  warned = false;
  schemaReady = false;
}

export async function logQueryRecord(record) {
  try {
    if (!transport) await initDbTransport();
    if (transport === 'off') return;
    if (transport === 'odbc') await insertViaOdbc(record);
    else await insertViaSqlcmd(record);
  } catch (error) {
    warnOnce('答题记录写入失败（不影响答题功能）：' + String(error.message ?? error).slice(0, 160));
  }
}

// ---- 管理端查询：按 IP 分页查记录、按 IP 汇总统计 ----
// kind 存在 model_calls JSON 里，用 JSON_VALUE 取出；文本里的换行压成空格便于表格展示。

export function buildRecordsSql(ip, offset, limit) {
  const where = ip ? 'WHERE client_ip = ' + toSqlLiteral(ip) + ' ' : '';
  return [
    'SET NOCOUNT ON;',
    'SELECT id, CONVERT(varchar(23), created_at, 120) AS ts, client_ip, user_name, subject, stage,',
    "ISNULL(JSON_VALUE(model_calls, '$.kind'), '') AS kind,",
    "ISNULL(model_mode, '') AS model_mode,",
    "ISNULL(CAST(duration_ms AS nvarchar(20)), '') AS duration_ms,",
    "REPLACE(REPLACE(question_text, CHAR(13), ''), CHAR(10), ' ') AS question_text,",
    "REPLACE(REPLACE(CAST(model_calls AS nvarchar(max)), CHAR(13), ''), CHAR(10), ' ') AS model_calls,",
    'COUNT(*) OVER() AS total_cnt',
    'FROM dbo.query_records ' + where,
    'ORDER BY id DESC',
    'OFFSET ' + Math.max(0, Number(offset) | 0) + ' ROWS FETCH NEXT ' + Math.max(1, Number(limit) | 0) + ' ROWS ONLY',
    'FOR XML RAW;',
  ].join(' ');
}

export function buildIpStatsSql() {
  return [
    'SET NOCOUNT ON;',
    'SELECT client_ip,',
    "ISNULL(MAX(user_name), '') AS user_name,",
    'COUNT(*) AS cnt,',
    'CONVERT(varchar(23), MIN(created_at), 120) AS first_at,',
    'CONVERT(varchar(23), MAX(created_at), 120) AS last_at',
    'FROM dbo.query_records GROUP BY client_ip ORDER BY MAX(id) DESC FOR XML RAW;',
  ].join(' ');
}

function decodeXmlEntities(text) {
  return String(text)
    .replace(/&#x[0-9a-fA-F]+;/g, (m) => String.fromCodePoint(parseInt(m.slice(3, -1), 16)))
    .replace(/&#\d+;/g, (m) => String.fromCodePoint(parseInt(m.slice(2, -1), 10)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseXmlRows(stdout) {
  const rows = [];
  for (const tag of String(stdout).match(/<row\b[^>]*\/?>/g) ?? []) {
    const row = {};
    for (const m of tag.matchAll(/([\w@]+)="([^"]*)"/g)) {
      row[m[1]] = decodeXmlEntities(m[2]);
    }
    rows.push(row);
  }
  return rows;
}

function queryViaSqlcmdText(sqlText) {
  return new Promise((resolve, reject) => {
    const args = ['-S', DB_SERVER, '-d', DB_NAME];
    if (DB_USER) args.push('-U', DB_USER, '-P', DB_PASSWORD);
    else args.push('-E');
    args.push('-f', '65001', '-h', '-1', '-y', '0');
    const child = spawn(SQLCMD_EXE, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('sqlcmd 查询超时'));
    }, SQLCMD_TIMEOUT_MS);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`sqlcmd 查询退出码 ${code} ${stderr.slice(0, 200)}`));
    });
    child.stdin.end(sqlText + '\nGO\n', 'utf8');
  });
}

// msnodesqlv8 对 FOR XML 返回 [{ 列名: '<row .../>' }]，取出含 <row 的字符串列
function extractXml(raw) {
  if (typeof raw === 'string') return raw;
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (first && typeof first === 'object') {
    for (const value of Object.values(first)) {
      if (typeof value === 'string' && value.includes('<row')) return value;
    }
  }
  return '';
}

async function queryRecordsOdbc(ip, offset, limit) {
  const sql = odbcModule.default ?? odbcModule;
  const connStr = odbcConnectionString();
  const where = ip ? 'WHERE client_ip = ? ' : '';
  const sqlText = [
    'SELECT id, CONVERT(varchar(23), created_at, 120) AS ts, client_ip, user_name, subject, stage,',
    "ISNULL(JSON_VALUE(model_calls, '$.kind'), '') AS kind,",
    'ISNULL(model_mode, ' + "''" + ') AS model_mode,',
    "ISNULL(CAST(duration_ms AS nvarchar(20)), '') AS duration_ms,",
    "REPLACE(REPLACE(question_text, CHAR(13), ''), CHAR(10), ' ') AS question_text,",
    "REPLACE(REPLACE(CAST(model_calls AS nvarchar(max)), CHAR(13), ''), CHAR(10), ' ') AS model_calls,",
    'COUNT(*) OVER() AS total_cnt',
    'FROM dbo.query_records ' + where,
    'ORDER BY id DESC OFFSET ? ROWS FETCH NEXT ? ROWS ONLY FOR XML RAW;',
  ].join(' ');
  const params = ip ? [ip, offset, limit] : [offset, limit];
  const raw = await new Promise((resolve, reject) => {
    sql.query(connStr, sqlText, params, (error, result) => (error ? reject(error) : resolve(result)));
  });
  return parseXmlRows(extractXml(raw));
}

export async function queryRecords({ ip = '', page = 1, pageSize = 20 } = {}) {
  if (!transport) await initDbTransport();
  if (transport === 'off') return { total: 0, items: [] };
  const limit = Math.min(100, Math.max(1, Number(pageSize) || 20));
  const offset = (Math.max(1, Number(page) || 1) - 1) * limit;
  let rows;
  if (transport === 'odbc') rows = await queryRecordsOdbc(ip || null, offset, limit);
  else rows = parseXmlRows(await queryViaSqlcmdText(buildRecordsSql(ip, offset, limit)));
  const total = rows.length ? Number(rows[0].total_cnt || 0) : 0;
  return {
    total,
    items: rows.map((r) => ({
      id: Number(r.id),
      time: r.ts,
      clientIp: r.client_ip,
      userName: r.user_name || null,
      subject: r.subject || null,
      stage: r.stage || null,
      kind: r.kind || 'solve',
      modelMode: r.model_mode || null,
      durationMs: r.duration_ms ? Number(r.duration_ms) : null,
      questionText: r.question_text || '',
      modelCalls: safeJsonParse(r.model_calls),
    })),
  };
}

// ---- 学生端历史记录：按客户端 IP + 题类（搜题/出题/批改）分页 ----
// 列表只回轻量字段，结果快照（可能几 KB）单独按 id 取，避免一次拉回一屏大 JSON。
export function buildHistorySql(ip, kind, offset, limit) {
  const clauses = [];
  if (ip) clauses.push('client_ip = ' + toSqlLiteral(ip));
  if (kind) clauses.push("ISNULL(JSON_VALUE(model_calls, '$.kind'), 'solve') = " + toSqlLiteral(kind));
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') + ' ' : '';
  return [
    'SET NOCOUNT ON;',
    'SELECT id, CONVERT(varchar(23), created_at, 120) AS ts, client_ip, user_name, subject, stage,',
    "ISNULL(JSON_VALUE(model_calls, '$.kind'), 'solve') AS kind,",
    "ISNULL(model_mode, '') AS model_mode,",
    "ISNULL(CAST(duration_ms AS nvarchar(20)), '') AS duration_ms,",
    "REPLACE(REPLACE(question_text, CHAR(13), ''), CHAR(10), ' ') AS question_text,",
    'CASE WHEN result_json IS NULL OR DATALENGTH(result_json) = 0 THEN 0 ELSE 1 END AS has_result,',
    'COUNT(*) OVER() AS total_cnt',
    'FROM dbo.query_records ' + where,
    'ORDER BY id DESC',
    'OFFSET ' + Math.max(0, Number(offset) | 0) + ' ROWS FETCH NEXT ' + Math.max(1, Number(limit) | 0) + ' ROWS ONLY',
    'FOR XML RAW;',
  ].join(' ');
}

// 结果快照走纯文本通道（前缀标记 + 原文），不用 FOR XML —— 长 JSON 放在 XML 属性里
// 有被转义和截断的风险，而快照本来就可能是几 KB 的范文或阅读原文。
export const HISTORY_RESULT_MARKER = 'AITJSON>>';

export function buildHistoryDetailSql(id) {
  const safeId = Math.max(0, Number(id) | 0);
  return [
    'SET NOCOUNT ON;',
    "SELECT '" + HISTORY_RESULT_MARKER + "' + ISNULL(CAST(result_json AS nvarchar(max)), '')",
    'FROM dbo.query_records WHERE id = ' + safeId + ';',
  ].join(' ');
}

export function extractMarkedPayload(stdout) {
  const text = String(stdout ?? '');
  const at = text.indexOf(HISTORY_RESULT_MARKER);
  if (at < 0) return '';
  const rest = text.slice(at + HISTORY_RESULT_MARKER.length);
  const newline = rest.indexOf('\n');
  return (newline >= 0 ? rest.slice(0, newline) : rest).replace(/\r$/, '').trim();
}

function mapHistoryRow(r) {
  return {
    id: Number(r.id),
    time: r.ts,
    clientIp: r.client_ip || null,
    userName: r.user_name || null,
    subject: r.subject || null,
    stage: r.stage || null,
    kind: r.kind || 'solve',
    modelMode: r.model_mode || null,
    durationMs: r.duration_ms ? Number(r.duration_ms) : null,
    questionText: r.question_text || '',
    hasResult: String(r.has_result ?? '') === '1',
  };
}

export async function queryHistory({ ip = '', kind = '', page = 1, pageSize = 20 } = {}) {
  if (!transport) await initDbTransport();
  if (transport === 'off') return { total: 0, items: [] };
  const limit = Math.min(50, Math.max(1, Number(pageSize) || 20));
  const offset = (Math.max(1, Number(page) || 1) - 1) * limit;
  let rows;
  if (transport === 'odbc') {
    const sql = odbcModule.default ?? odbcModule;
    const clauses = [];
    const params = [];
    if (ip) {
      clauses.push('client_ip = ?');
      params.push(ip);
    }
    if (kind) {
      clauses.push("ISNULL(JSON_VALUE(model_calls, '$.kind'), 'solve') = ?");
      params.push(kind);
    }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') + ' ' : '';
    params.push(offset, limit);
    const sqlText = [
      'SELECT id, CONVERT(varchar(23), created_at, 120) AS ts, client_ip, user_name, subject, stage,',
      "ISNULL(JSON_VALUE(model_calls, '$.kind'), 'solve') AS kind,",
      'ISNULL(model_mode, ' + "''" + ') AS model_mode,',
      "ISNULL(CAST(duration_ms AS nvarchar(20)), '') AS duration_ms,",
      "REPLACE(REPLACE(question_text, CHAR(13), ''), CHAR(10), ' ') AS question_text,",
      'CASE WHEN result_json IS NULL OR DATALENGTH(result_json) = 0 THEN 0 ELSE 1 END AS has_result,',
      'COUNT(*) OVER() AS total_cnt',
      'FROM dbo.query_records ' + where,
      'ORDER BY id DESC OFFSET ? ROWS FETCH NEXT ? ROWS ONLY FOR XML RAW;',
    ].join(' ');
    const raw = await new Promise((resolve, reject) => {
      sql.query(odbcConnectionString(), sqlText, params, (error, result) => (error ? reject(error) : resolve(result)));
    });
    rows = parseXmlRows(extractXml(raw));
  } else {
    rows = parseXmlRows(await queryViaSqlcmdText(buildHistorySql(ip, kind, offset, limit)));
  }
  const total = rows.length ? Number(rows[0].total_cnt || 0) : 0;
  return { total, items: rows.map(mapHistoryRow) };
}

export async function queryHistoryResult(id) {
  if (!transport) await initDbTransport();
  if (transport === 'off') return null;
  if (transport === 'odbc') {
    const sql = odbcModule.default ?? odbcModule;
    const raw = await new Promise((resolve, reject) => {
      sql.query(
        odbcConnectionString(),
        'SELECT ISNULL(CAST(result_json AS nvarchar(max)), ' + "''" + ') AS payload FROM dbo.query_records WHERE id = ?;',
        [Math.max(0, Number(id) | 0)],
        (error, result) => (error ? reject(error) : resolve(result)),
      );
    });
    const first = Array.isArray(raw) ? raw[0] : raw;
    const value = first ? Object.values(first)[0] : '';
    return safeJsonParse(value ?? '');
  }
  return safeJsonParse(extractMarkedPayload(await queryViaSqlcmdText(buildHistoryDetailSql(id))));
}

export async function queryIpStats() {
  if (!transport) await initDbTransport();
  if (transport === 'off') return [];
  const rows = transport === 'odbc'
    ? await (async () => {
        const sql = odbcModule.default ?? odbcModule;
        const raw = await new Promise((resolve, reject) => {
          sql.query(
            odbcConnectionString(),
            [
              'SELECT client_ip, ISNULL(MAX(user_name), ' + "''" + ') AS user_name, COUNT(*) AS cnt,',
              'CONVERT(varchar(23), MIN(created_at), 120) AS first_at,',
              'CONVERT(varchar(23), MAX(created_at), 120) AS last_at',
              'FROM dbo.query_records GROUP BY client_ip ORDER BY MAX(id) DESC FOR XML RAW;',
            ].join(' '),
            (error, result) => (error ? reject(error) : resolve(result)),
          );
        });
        return parseXmlRows(extractXml(raw));
      })()
    : parseXmlRows(await queryViaSqlcmdText(buildIpStatsSql()));
  return rows.map((r) => ({
    clientIp: r.client_ip,
    userName: r.user_name || null,
    count: Number(r.cnt || 0),
    firstAt: r.first_at,
    lastAt: r.last_at,
  }));
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
