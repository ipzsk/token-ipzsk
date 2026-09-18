// 导出共享契约：contracts/endpoints.json（接口清单 + 错误码）与 contracts/ipzsk-api.d.ts（形状）。
// 用法：npm run contracts。输出确定（键排序、无时间戳），产物提交进仓库；test/contracts.test.mjs 校验产物是最新的。
//
// 接口清单来自真实 Fastify app（createApp + onRoute 钩子，假 db，不连 Postgres）。
// 鉴权与错误码是对 handler 源码的静态推断：路由段（到同级下一个路由/辅助函数为止）+ 它调用的本文件/导入的辅助函数，
// 所以是近似值（可能多列，常见写法不会漏列）。请求/响应形状来自各模块的 routeMeta 登记。
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.mjs';
import { AUTH_ENDPOINTS } from '../src/customer-auth.mjs';
import { schemas, renderDts, parseShape, toTs } from '../src/contracts-schema.mjs';
import { stable } from '../src/validation.mjs';
import { routeMeta as studioMeta } from '../src/studio.mjs';
import { routeMeta as uploadMeta } from '../src/uploads.mjs';
import { routeMeta as libraryMeta } from '../src/library.mjs';
import { routeMeta as caseMeta } from '../src/cases.mjs';
import { routeMeta as roleMeta } from '../src/roles.mjs';
import { routeMeta as adminMeta } from '../src/admin-studio.mjs';
import { routeMeta as opsMeta } from '../src/admin-ops.mjs';
import { routeMeta as desktopMeta } from '../src/desktop-releases.mjs';

const ROOT = new URL('../', import.meta.url);
export const PREFIXES = ['/api/me/', '/api/public/', '/api/admin/', '/api/auth/', '/api/account/', '/api/videos/', '/api/desktop/', '/v1/'];
export const ROUTE_META = { ...studioMeta, ...uploadMeta, ...libraryMeta, ...caseMeta, ...roleMeta, ...adminMeta, ...opsMeta, ...desktopMeta };
// app.mjs 错误处理器里生成的码（不是字面 httpError 调用）。
const HANDLER_CODES = [['already_exists', 409], ['invalid_request', 400], ['internal_error', 500]];

export async function collectRoutes() {
  const routes = [];
  const app = await createApp({
    db: { query: async () => ({ rows: [], rowCount: 0 }), tx: async (fn) => fn({ query: async () => ({ rows: [], rowCount: 0 }) }) },
    upstream: {}, scheduler: { keys: new Map(), accounts: new Map() }, origin: 'https://api.ipzsk.com',
    onRoute: (r) => { for (const method of [r.method].flat()) routes.push({ method, url: r.url }); },
  });
  await app.close();
  const out = new Map();
  for (const { method, url } of routes) {
    if (['HEAD', 'OPTIONS'].includes(method) || !PREFIXES.some((p) => url.startsWith(p))) continue;
    if (url === '/api/auth/*') {
      for (const e of AUTH_ENDPOINTS) { const [m, p] = e.split(' '); if (m === method) out.set(`${m} /api/auth${p}`, { method: m, path: '/api/auth' + p, source: url }); }
      continue;
    }
    out.set(`${method} ${url}`, { method, path: url, source: url });
  }
  return [...out.values()];
}

// ── 静态扫描 ──
const CODE = "'([a-z][a-z0-9_]*)'";
function literalCodes(text, wrappers = new Map()) {
  const found = [];
  for (const m of text.matchAll(new RegExp(`\\b(?:httpError|fail)\\(\\s*(\\d{3})\\s*,\\s*${CODE}`, 'g'))) found.push([m[2], Number(m[1])]);
  for (const m of text.matchAll(/reply\.code\((\d{3})\)\.send\(\{\s*error:\s*\{\s*code:\s*([^,]+),/g)) {
    for (const c of m[2].matchAll(new RegExp(CODE, 'g'))) found.push([c[1], Number(m[1])]);
  }
  for (const m of text.matchAll(new RegExp(`Object\\.assign\\(new Error\\([^)]*\\),\\s*\\{\\s*code:\\s*${CODE}`, 'g'))) found.push([m[1], null]);
  for (const [name, status] of wrappers) {
    for (const m of text.matchAll(new RegExp(`\\b${name}\\(\\s*${CODE}`, 'g'))) found.push([m[1], status]);
  }
  return found;
}

const ROUTE_RE = /\bapp\.(get|post|put|patch|delete)\(\s*(['"])([^'"]+)\2/g;
const LOOP_RE = /\bfor\s*\(\s*const\s+(?:\w+|\[[^\]]*\])\s+of\s+\[((?:[^\[\]]|\[[^\]]*\])*)\]\s*\)\s*app\.(get|post|put|patch|delete)\(/g;
const HELPER_RE = /(?:\bfunction\s+(\w+)\s*\(|\bconst\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>)/g;
const indentAt = (text, index) => { const start = text.lastIndexOf('\n', index) + 1; return /^\s*/.exec(text.slice(start, index))[0].length; };

async function analyseSources() {
  const dir = new URL('src/', ROOT), files = {};
  for (const name of (await readdir(dir)).filter((f) => f.endsWith('.mjs')).sort()) files[name] = await readFile(new URL(name, dir), 'utf8');
  const index = {};
  for (const [file, text] of Object.entries(files)) {
    const markers = [];
    for (const m of text.matchAll(ROUTE_RE)) markers.push({ at: m.index, type: 'route', keys: [`${m[1].toUpperCase()} ${m[3]}`] });
    for (const m of text.matchAll(LOOP_RE)) {
      markers.push({ at: m.index, type: 'route', keys: [...m[1].matchAll(/'([^']+)'/g)].map((u) => `${m[2].toUpperCase()} ${u[1]}`) });
    }
    for (const m of text.matchAll(HELPER_RE)) markers.push({ at: m.index, type: 'helper', name: m[1] ?? m[2] });
    markers.sort((a, b) => a.at - b.at);
    const unique = markers;
    for (const m of unique) m.indent = indentAt(text, m.at);
    const wrappers = new Map();
    for (const m of text.matchAll(/\b(?:const|function)\s+(\w+)\s*=?\s*(?:async\s*)?\(?\s*(\w+)[^)=\n]*\)?\s*(?:=>|\{)[\s\S]{0,300}?\b(?:httpError|fail)\(\s*(\d{3})\s*,\s*(\w+)\s*[,)]/g)) {
      if (m[2] === m[4]) wrappers.set(m[1], Number(m[3]));
    }
    const imports = {};
    for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/([\w-]+\.mjs)'/g)) {
      for (const part of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
        const [orig, local = orig] = part.split(/\s+as\s+/);
        imports[local] = { file: m[2], name: orig };
      }
    }
    const segments = unique.map((m, i) => {
      // 段到同级或更外层（缩进 ≤）的下一个标记为止；路由段遇到下一个路由也结束。嵌套的辅助函数仍算在外层段里。
      const next = unique.slice(i + 1).find((o) => (m.type === 'route' && o.type === 'route') || o.indent <= m.indent);
      return { ...m, text: text.slice(m.at, next?.at ?? text.length) };
    });
    index[file] = { text, segments, wrappers, imports, helpers: Object.fromEntries(segments.filter((s) => s.type === 'helper').map((s) => [s.name, s])) };
  }
  return { files, index };
}

function routeFacts(analysis, key) {
  let seg = null, file = null;
  for (const [f, info] of Object.entries(analysis.index)) {
    const s = info.segments.find((x) => x.type === 'route' && x.keys.includes(key));
    if (s) { seg = s; file = f; break; }
  }
  if (!seg) return { codes: [], calls: new Set() };
  const codes = [], calls = new Set(), seen = new Set();
  const visit = (f, text) => {
    const info = analysis.index[f];
    codes.push(...literalCodes(text, info.wrappers));
    for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[1];
      const imported = Object.hasOwn(info.imports, name) ? info.imports[name] : null;
      const target = Object.hasOwn(info.helpers, name) ? { file: f, name }
        : imported && analysis.index[imported.file] && Object.hasOwn(analysis.index[imported.file].helpers, imported.name) ? imported : null;
      if (!target) continue;
      calls.add(`${target.file}:${target.name}`);
      const id = `${target.file}:${target.name}`;
      if (seen.has(id)) continue;
      seen.add(id);
      visit(target.file, analysis.index[target.file].helpers[target.name].text);
    }
  };
  seen.add(`${file}:route:${seg.at}`);
  visit(file, seg.text);
  return { codes, calls, segment: seg.text };
}

function authFor(path, facts) {
  const roles = [...(facts.segment ?? '').matchAll(/requireRole\(\s*req\s*,([^)]*)\)/g)].flatMap((m) => [...m[1].matchAll(/'(\w+)'/g)].map((r) => r[1]));
  if (roles.length) return { auth: 'cookie', roles: [...new Set(roles)].sort() };
  if (facts.calls.has('studio.mjs:me')) return { auth: 'cookie' };
  if (path.startsWith('/api/me/')) return { auth: 'cookie_or_bearer' };
  if (path.startsWith('/v1/') || path.startsWith('/api/videos/')) return { auth: 'bearer' };
  if (path.startsWith('/api/admin/')) return { auth: 'cookie' };
  return { auth: 'public' };
}

const oneLine = (node) => toTs(node).replace(/\s*\/\/[^\n]*/g, '').replace(/\s*\n\s*/g, ' ');

export async function buildContracts() {
  const routes = await collectRoutes();
  const analysis = await analyseSources();
  const errorMap = new Map();
  const addError = (code, status) => { const set = errorMap.get(code) ?? new Set(); if (status !== null) set.add(status); errorMap.set(code, set); };
  for (const [file, text] of Object.entries(analysis.files)) for (const [code, status] of literalCodes(text, analysis.index[file].wrappers)) addError(code, status);
  for (const [code, status] of HANDLER_CODES) addError(code, status);

  const routeKeys = new Set(routes.map((r) => `${r.method} ${r.path}`));
  const missing = Object.keys(ROUTE_META).filter((k) => !routeKeys.has(k));
  if (missing.length) throw new Error('routeMeta entries without a route: ' + missing.join(', '));
  const endpoints = routes.map((r) => {
    const key = `${r.method} ${r.path}`, facts = routeFacts(analysis, `${r.method} ${r.source}`), meta = ROUTE_META[key];
    const entry = { method: r.method, path: r.path, ...authFor(r.path, facts), errors: [...new Set(facts.codes.map(([c]) => c))].sort() };
    if (meta) {
      for (const name of [meta.body, meta.response, meta.conflict, meta.query].filter(Boolean)) {
        const base = /^Page<(\w+)>$/.exec(name)?.[1] ?? name;
        if (!schemas[base] && name !== meta.query) throw new Error(`${key}: unknown schema ${name}`);
      }
      Object.assign(entry, { response: meta.response });
      if (meta.body) Object.assign(entry, { body: meta.body, body_shape: oneLine(schemas[meta.body]) });
      if (meta.query) entry.query = schemas[meta.query] ? meta.query : meta.query.split(',');
      if (meta.conflict) entry.conflict = meta.conflict;
      if (meta.headers) entry.headers = meta.headers;
    }
    return entry;
  }).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.method < b.method ? -1 : a.method > b.method ? 1 : 0));

  const json = {
    note: 'Generated by ipzsk-api-gateway scripts/export-contracts.mjs. Do not edit. auth/errors are static inferences from handler source; response/body names refer to ipzsk-api.d.ts.',
    auth_kinds: {
      public: { description: 'no credentials', common_errors: ['rate_limited'] },
      cookie: { description: 'better-auth customer session cookie required (bearer tokens rejected with customer_login_required); roles → user_roles，会话时长与官网一致（7 天、访问即续期）', common_errors: ['customer_login_required', 'origin_denied', 'origin_not_allowed', 'rate_limited', 'forbidden_role'] },
      cookie_or_bearer: { description: 'customer session cookie, or Bearer ipz_ token (plugin tokens denied)', common_errors: ['invalid_api_token', 'origin_denied', 'plugin_scope_denied', 'rate_limited'] },
      bearer: { description: 'Authorization: Bearer ipz_…', common_errors: ['invalid_api_token', 'rate_limited'] },
    },
    endpoints,
    errors: [...errorMap].map(([code, status]) => ({ code, status: [...status].sort() })).sort((a, b) => (a.code < b.code ? -1 : 1)),
  };
  const endpointTypes = endpoints.filter((e) => e.response).map((e) => {
    const resp = e.response === 'Empty' ? 'void' : oneLine(parseShape(e.response));
    return `  ${JSON.stringify(`${e.method} ${e.path}`)}: { body: ${e.body ?? 'never'}; response: ${resp} }`;
  });
  const dts = renderDts() + '\n/** Typed endpoints (only routes with a routeMeta entry). */\nexport interface Endpoints {\n' + endpointTypes.join('\n') + '\n}\n';
  return { json: JSON.stringify(stable(json), null, 2) + '\n', dts };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { json, dts } = await buildContracts();
  await mkdir(new URL('contracts/', ROOT), { recursive: true });
  await writeFile(new URL('contracts/endpoints.json', ROOT), json);
  await writeFile(new URL('contracts/ipzsk-api.d.ts', ROOT), dts);
  console.log('wrote contracts/endpoints.json, contracts/ipzsk-api.d.ts');
}
