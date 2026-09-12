// 答题记录持久化：写入 SQL Server（本机默认 LocalDB 实例，可通过环境变量切换到正式实例/云端）。
// 设计原则：
//  1. 记录失败绝不影响答题主流程（静默降级，只写服务端日志）；
//  2. 双通道：优先原生 ODBC 驱动（msnodesqlv8，支持参数化），探测不通自动降级为 sqlcmd 命令行；
//  3. 迁移友好：连接串全部走环境变量（MSSQL_SERVER / MSSQL_DATABASE / MSSQL_USER / MSSQL_PASSWORD），
//     后续把库搬到云端只需改 .env，代码零改动。
import { spawn } from 'node:child_process';

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
    '(client_ip, user_name, subject, stage, question_text, model_mode, model_calls, duration_ms)',
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
    ].join(', '),
    ');',
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
        (client_ip, user_name, subject, stage, question_text, model_mode, model_calls, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        String(record.clientIp ?? 'unknown'),
        record.userName ?? null,
        record.subject ?? null,
        record.stage ?? null,
        String(record.questionText ?? ''),
        record.modelMode ?? null,
        JSON.stringify(record.modelCalls ?? {}),
        Number.isFinite(record.durationMs) ? Math.round(record.durationMs) : null,
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

export async function initDbTransport() {
  if (transport) return transport;
  transport = await resolveTransport();
  log(`答题记录通道：${transport}（服务器 ${DB_SERVER}，数据库 ${DB_NAME}）`);
  return transport;
}

// 供测试复位状态
export function resetDbTransport() {
  transport = null;
  warned = false;
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
