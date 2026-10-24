#!/usr/bin/env node
/**
 * dsh-token-mascot · 离线契约校验（静态 + 宿主侧动态 import）
 *
 * 用法（脚本内部自行解析路径，cwd 任意）：
 *   node test/validate.mjs
 *   cd test && node validate.mjs
 *
 * 只读 plugin/，不写任何文件、不联网、不依赖第三方包。
 * 全通过 exit 0；任一失败 exit 1。输出每行 PASS/FAIL，最后一行汇总。
 *
 * 说明：lib/index.js 的 apply() 被调用时会打一行审计日志（它会读 client.js），
 * 校验器在调用 apply() 期间临时静音 console，避免污染 PASS/FAIL 输出。
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(here, '..', 'plugin');

let passed = 0;
let failed = 0;

class CheckFailure extends Error {}

function expect(condition, reason) {
  if (!condition) throw new CheckFailure(reason);
}

function firstLine(error) {
  if (error instanceof CheckFailure) return error.message;
  const message = error && error.message ? String(error.message) : String(error);
  return message.split(/\r?\n/)[0] || '未知错误';
}

function pass(desc, info) {
  passed += 1;
  console.log('PASS  ' + desc + (info ? '  (' + info + ')' : ''));
}

function fail(desc, reason) {
  failed += 1;
  console.log('FAIL  ' + desc + '（' + reason + '）');
}

async function test(desc, fn) {
  try {
    const info = await fn();
    pass(desc, typeof info === 'string' ? info : '');
  } catch (error) {
    fail(desc, firstLine(error));
  }
}

/** 把绝对路径显示成相对插件根目录的路径，便于定位。 */
function rel(file) {
  return relative(pluginDir, file).replace(/\\/g, '/') || '.';
}

/** 安全读取：文件不存在 / 目录 / 权限问题都变成 { ok:false, error }，绝不抛。 */
function readTextSafe(file) {
  try {
    if (!existsSync(file)) return { ok: false, error: '文件不存在（' + rel(file) + '）' };
    return { ok: true, text: readFileSync(file, 'utf8') };
  } catch (error) {
    return { ok: false, error: '读取失败（' + rel(file) + '）：' + firstLine(error) };
  }
}

/** 解析 exports 条件对象 / 字符串入口，返回第一个文件路径字符串。 */
function entryTarget(entry) {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    for (const key of ['default', 'import', 'module', 'require', 'node', 'browser']) {
      if (typeof entry[key] === 'string') return entry[key];
    }
  }
  return null;
}

/** 入口路径规范化后与期望值比较（接受 "./lib/x.js" / "lib/x.js"）。 */
function normalizeEntry(value) {
  if (typeof value !== 'string') return null;
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

/* ========================================================================== *
 * package.json
 * ========================================================================== */

const pkgPath = join(pluginDir, 'package.json');
const pkgRead = readTextSafe(pkgPath);

let pkg = null;
let pkgError = pkgRead.ok ? null : pkgRead.error;

if (pkgRead.ok) {
  try {
    const parsed = JSON.parse(pkgRead.text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      pkgError = '顶层不是 JSON 对象';
    } else {
      pkg = parsed;
    }
  } catch (error) {
    pkgError = 'JSON 解析失败：' + firstLine(error);
  }
}

function requirePkg() {
  if (!pkg) throw new CheckFailure(pkgError || 'package.json 不可用');
  return pkg;
}

let patchEntries = null;

await test('plugin/package.json 存在', () => {
  expect(pkgRead.ok, pkgRead.error || '文件不存在');
  return rel(pkgPath);
});

await test('plugin/package.json 是合法 JSON', () => {
  expect(pkg, pkgError || '解析失败');
  return '顶层对象，name=' + JSON.stringify(pkg.name);
});

await test('package.json name === "dsh-token-mascot"', () => {
  const manifest = requirePkg();
  expect(
    manifest.name === 'dsh-token-mascot',
    '实际 name=' + JSON.stringify(manifest.name),
  );
  return 'name=' + manifest.name;
});

await test('package.json 声明 dsh.bundle.patch（字符串或数组）', () => {
  const manifest = requirePkg();
  const declaration = manifest.dsh && manifest.dsh.bundle ? manifest.dsh.bundle.patch : undefined;
  if (typeof declaration === 'string') {
    patchEntries = [declaration];
  } else if (
    Array.isArray(declaration) &&
    declaration.length > 0 &&
    declaration.every((item) => typeof item === 'string')
  ) {
    patchEntries = declaration.slice();
  } else {
    throw new CheckFailure('实际值=' + JSON.stringify(declaration));
  }
  return JSON.stringify(patchEntries);
});

await test('dsh.bundle.patch 指向存在的 cordis.patch.yml', () => {
  expect(patchEntries, '前置失败：dsh.bundle.patch 声明缺失或格式非法');
  const targets = patchEntries.map((entry) => ({
    entry,
    file: resolve(pluginDir, entry),
  }));
  const missing = targets.filter((target) => !existsSync(target.file));
  expect(
    missing.length === 0,
    '以下 patch 文件不存在：' + missing.map((target) => target.entry).join('、'),
  );
  expect(
    targets.some((target) => basename(target.file) === 'cordis.patch.yml'),
    '未指向 cordis.patch.yml，实际指向：' + targets.map((target) => target.entry).join('、'),
  );
  return targets.map((target) => target.entry).join('、');
});

await test('dsh.client.platform === "web"', () => {
  const manifest = requirePkg();
  const platform = manifest.dsh && manifest.dsh.client ? manifest.dsh.client.platform : undefined;
  expect(platform === 'web', '实际 platform=' + JSON.stringify(platform));
  return 'platform=web';
});

await test('exports["./client"] 存在且指向 lib/client.js', () => {
  const manifest = requirePkg();
  const exported = manifest.exports ? manifest.exports['./client'] : undefined;
  expect(exported !== undefined, 'exports["./client"] 缺失');
  const target = entryTarget(exported);
  expect(target, '无法解析出口路径：' + JSON.stringify(exported));
  const normalized = normalizeEntry(target);
  expect(normalized === 'lib/client.js', '实际指向 ' + JSON.stringify(normalized));
  return 'exports["./client"] → ' + target;
});

await test('package.json main 指向 lib/index.js', () => {
  const manifest = requirePkg();
  const normalized = normalizeEntry(manifest.main);
  expect(
    normalized === 'lib/index.js',
    '实际 main=' + JSON.stringify(manifest.main),
  );
  return 'main=' + manifest.main;
});

/* ========================================================================== *
 * cordis.patch.yml
 * ========================================================================== */

const patchPath = join(pluginDir, 'cordis.patch.yml');
const patchRead = readTextSafe(patchPath);

await test('plugin/cordis.patch.yml 存在', () => {
  expect(patchRead.ok, patchRead.error || '文件不存在');
  return rel(patchPath);
});

await test('cordis.patch.yml 包含 insert:', () => {
  expect(patchRead.ok, patchRead.error || '文件不存在');
  expect(patchRead.text.includes('insert:'), '文本中未找到 "insert:"');
  return '找到 insert:';
});

await test('cordis.patch.yml 包含 id: dsh-token-mascot', () => {
  expect(patchRead.ok, patchRead.error || '文件不存在');
  const match = /id\s*:\s*["']?dsh-token-mascot["']?/.exec(patchRead.text);
  expect(match, '文本中未找到 id: dsh-token-mascot');
  return match[0];
});

/* ========================================================================== *
 * lib/index.js（宿主侧：必须可 import，apply() 无参不抛）
 * ========================================================================== */

const indexPath = join(pluginDir, 'lib', 'index.js');
const indexRead = readTextSafe(indexPath);

let indexModule = null;
let indexApply = null;

await test('plugin/lib/index.js 存在', () => {
  expect(indexRead.ok, indexRead.error || '文件不存在');
  return rel(indexPath) + '（' + Buffer.byteLength(indexRead.text, 'utf8') + ' 字节）';
});

await test('plugin/lib/index.js 可被 import()', async () => {
  expect(indexRead.ok, indexRead.error || '文件不存在');
  try {
    indexModule = await import(pathToFileURL(indexPath).href);
  } catch (error) {
    throw new CheckFailure('import() 失败：' + firstLine(error));
  }
  const keys = Object.keys(indexModule);
  return keys.length > 0 ? '导出键：' + keys.join(', ') : '无导出键';
});

await test('lib/index.js 导出 apply 函数', () => {
  expect(indexModule, '前置失败：import() 未成功');
  if (typeof indexModule.apply === 'function') {
    indexApply = indexModule.apply;
  } else if (indexModule.default && typeof indexModule.default.apply === 'function') {
    indexApply = indexModule.default.apply;
  }
  expect(indexApply, '未找到 mod.apply 或 mod.default.apply');
  return 'apply 是函数';
});

await test('lib/index.js apply() 无参调用不抛错', async () => {
  expect(indexApply, '前置失败：apply 未导出');
  // 插件 apply 会打审计日志（内容是 client.js 检查结果），静音以免污染本脚本输出。
  const saved = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  const captured = [];
  const sink = (...args) => captured.push(args.map((item) => String(item)).join(' '));
  console.log = sink;
  console.info = sink;
  console.warn = sink;
  console.error = sink;
  try {
    const result = indexApply();
    if (result && typeof result.then === 'function') await result;
  } catch (error) {
    throw new CheckFailure('apply() 抛出：' + firstLine(error));
  } finally {
    Object.assign(console, saved);
  }
  return '无异常（静音插件日志 ' + captured.length + ' 条）';
});

/* ========================================================================== *
 * lib/client.js（浏览器侧静态契约）
 * ========================================================================== */

const clientPath = join(pluginDir, 'lib', 'client.js');
const clientRead = readTextSafe(clientPath);

function requireClient() {
  if (!clientRead.ok) throw new CheckFailure(clientRead.error || '文件不存在');
  return clientRead.text;
}

await test('plugin/lib/client.js 存在', () => {
  expect(clientRead.ok, clientRead.error || '文件不存在');
  return rel(clientPath) + '（' + Buffer.byteLength(clientRead.text, 'utf8') + ' 字节）';
});

await test('client.js 调用 __ModuleLoader__.load', () => {
  const source = requireClient();
  expect(source.includes('__ModuleLoader__.load'), '未找到字面量 "__ModuleLoader__.load"');
  return '存在';
});

await test('client.js 包含 id: "dsh-token-mascot"', () => {
  const source = requireClient();
  const match = /id\s*:\s*["']dsh-token-mascot["']/.exec(source);
  expect(match, '未找到 id: "dsh-token-mascot"（允许空格变体）');
  return match[0];
});

await test('client.js 包含 exports.apply', () => {
  const source = requireClient();
  expect(source.includes('exports.apply'), '未找到字面量 "exports.apply"');
  return '存在';
});

await test('client.js 包含 conversation.input.right', () => {
  const source = requireClient();
  expect(source.includes('conversation.input.right'), '未找到 "conversation.input.right"');
  return '存在';
});

/*
 * DSH 0.2.1-rc.3 起标准 hook `useSession` 是「选择器 hook」：必须传 selector
 * （官方 ui-chat 写法 `useSession((s) => s.running)`）。无参 `useSession()` 会把
 * undefined 塞进 useSyncExternalStoreWithSelector，抛 "selector is not a function"，
 * 整个插槽条目崩溃 —— 表现是插件「运行中」但界面什么都不出现。
 * 这条静态回归断言防止再退回旧契约。
 */
await test('client.js 的 useSession 调用带 selector（rc.3 契约）', () => {
  const source = requireClient();
  /* 注释里的 useSession() 说明文字不是调用；先去掉块注释再做静态扫描。 */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const pattern = /useSession\s*\(\s*([^)]*?)\s*\)/g;
  const args = [];
  let match = pattern.exec(code);
  while (match !== null) {
    args.push(match[1].trim());
    match = pattern.exec(code);
  }
  expect(args.length > 0, '未找到 useSession(...) 调用');
  const empty = args.filter((arg) => arg.length === 0);
  expect(
    empty.length === 0,
    '发现无参 useSession()：rc.3 起它是选择器 hook，必须传 selector（恒等 selector 即 (s) => s）',
  );
  const literal = args.filter((arg) => /^['"`\d]/.test(arg));
  expect(literal.length === 0, 'useSession 的第一个参数必须是函数，不能是字面量：' + literal.join('、'));
  return args.map((arg) => 'useSession(' + arg + ')').join('、');
});

await test('client.js 的 require 仅使用 react / react-dom', () => {
  const source = requireClient();
  const ids = new Set();
  const pattern = /\brequire\s*\(\s*(["'])([^"'\\]+)\1\s*\)/g;
  let match = pattern.exec(source);
  while (match !== null) {
    ids.add(match[2]);
    match = pattern.exec(source);
  }
  const all = Array.from(ids);
  const disallowed = all.filter((id) => id !== 'react' && id !== 'react-dom');
  expect(
    disallowed.length === 0,
    '出现不允许的 require id：' +
      disallowed.map((id) => JSON.stringify(id)).join('、') +
      '（只允许 react / react-dom）',
  );
  return all.length > 0 ? all.map((id) => JSON.stringify(id)).join('、') : '未发现 require("…") 调用';
});

await test('client.js 不含 fetch(', () => {
  const source = requireClient();
  expect(!/\bfetch\s*\(/.test(source), '包含网络请求 fetch(');
  return '无 fetch(';
});

await test('client.js 不含 XMLHttpRequest', () => {
  const source = requireClient();
  expect(!source.includes('XMLHttpRequest'), '包含 XMLHttpRequest');
  return '无 XMLHttpRequest';
});

await test('client.js 不含 new WebSocket', () => {
  const source = requireClient();
  expect(!/\bnew\s+WebSocket\b/.test(source), '包含 new WebSocket');
  return '无 new WebSocket';
});

await test('client.js 包含 exports.__internals', () => {
  const source = requireClient();
  const match = /exports\s*\.\s*__internals\b/.exec(source);
  expect(match, '未找到 exports.__internals');
  return '存在';
});

await test('client.js 读取今日全部会话（useSessions + refreshProjections）', () => {
  const source = requireClient();
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '');
  expect(/\buseSessions\b/.test(code), '未使用全局 useSessions 会话列表');
  expect(/refreshProjections\s*\(/.test(code), '未调用 ctx.sessions.refreshProjections 按需加载投影');
  expect(/\btokenUsage\b/.test(code), '未读取 tokenUsage 投影');
  return 'useSessions + refreshProjections + tokenUsage';
});

const INTERNAL_FUNCTIONS = [
  'estimateTokens',
  'computeLiveStream',
  'formatTokens',
  'deriveMascotState',
  'usageTotals',
  'clampPercent',
  'startOfLocalDay',
  'sumUsageBuckets',
];

for (const name of INTERNAL_FUNCTIONS) {
  await test('client.js 导出关键纯函数 ' + name, () => {
    const source = requireClient();
    const pattern = new RegExp('\\b' + name + '\\b');
    expect(pattern.test(source), '文件里未出现标识符 ' + name);
    return '存在';
  });
}

/* ========================================================================== *
 * 汇总
 * ========================================================================== */

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exitCode = failed === 0 ? 0 : 1;
