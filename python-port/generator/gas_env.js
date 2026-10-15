'use strict';
// 共用：假 GAS 環境（Cache／Properties／Lock／UrlFetch／時鐘）。load 的原始碼可以是多個檔案串接。
const vm = require('vm'), crypto = require('crypto');
const T0 = 1758470000000;
function makeEnv(SRC, seed) {
  const env = { t: T0, props: Object.assign({}, seed.props || {}), cache: new Map(), lockOk: true, sleeps: [], uuid: 0,
    fetchPlan: [], fetchCalls: [] };
  for (const [k, v] of Object.entries(seed.cache || {})) env.cache.set(k, { v: v[0], exp: v[1] });
  class FD extends Date { constructor(...a) { if (a.length) super(...a); else super(env.t); } static now() { return env.t; } }
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Date: FD,
    Math: Object.assign(Object.create(Math), { random: () => 0 }),
    PropertiesService: { getScriptProperties: () => ({
      getProperties: () => Object.assign({}, env.props), getKeys: () => Object.keys(env.props),
      getProperty: (k) => (k in env.props ? env.props[k] : null),
      setProperty: (k, v) => { env.props[k] = String(v); }, deleteProperty: (k) => { delete env.props[k]; } }) },
    CacheService: { getScriptCache: () => ({
      get: (k) => { const e = env.cache.get(k); if (!e) return null; if (e.exp <= env.t) { env.cache.delete(k); return null; } return e.v; },
      put: (k, v, ttl) => { env.cache.set(k, { v: String(v), exp: env.t + ttl * 1000 }); },
      remove: (k) => { env.cache.delete(k); } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => (env.lockSeq && env.lockSeq.length ? env.lockSeq.shift() : env.lockOk), releaseLock() {} }), getUserLock: () => ({ tryLock: () => (env.lockSeq && env.lockSeq.length ? env.lockSeq.shift() : env.lockOk), releaseLock() {} }) },
    ContentService: { MimeType: { TEXT: 'TEXT' }, createTextOutput: (t) => ({ text: t, setMimeType() { return this; } }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
      computeDigest: (a, s) => Array.from(crypto.createHash('sha256').update(String(s), 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
      getUuid: () => 'u' + (++env.uuid), sleep: (ms) => { env.sleeps.push(ms); },
      formatDate: (d, tz, fmt) => { const x = new Date(d.getTime() + 8 * 3600e3).toISOString();
        const p = x.slice(0, 10) + ' ' + x.slice(11, 16); return fmt.endsWith('ss') ? p + ':' + x.slice(17, 19) : p; } },
    UrlFetchApp: { fetch: (url, opts) => {
      env.fetchCalls.push({ url, opts: JSON.parse(JSON.stringify(opts)) });
      const plan = env.fetchPlan.length ? env.fetchPlan.shift() : { status: 200, body: '{"ok":true}' };
      if (plan.advance) env.t += plan.advance;
      if (plan.throw) throw new Error(plan.throw);
      return { getResponseCode: () => plan.status, getContentText: () => plan.body, getAllHeaders: () => plan.headers || {},
        getBlob: () => sandbox.__mkBlob(null, plan.body) }; } },
    __mkBlob: (name, body) => { const bytes = Array.from(Buffer.from(String(body), 'utf8'));
      return { name, getBytes: () => bytes.slice(), setName(n) { this.name = n; return this; }, toJSON() { return { __blob: true, name: this.name, len: bytes.length }; } }; },
    __rec: { calls: [], logs: [] }, __plan: {},
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(SRC, ctx);
  env.ctx = ctx; env.run = (code) => vm.runInContext(code, ctx);
  return env;
}

const J = (x) => JSON.parse(JSON.stringify(x === undefined ? null : x));
function stateOf(env) {
  const props = {};
  for (const [k, v] of Object.entries(env.props)) { try { props[k] = JSON.parse(v); } catch (e) { props[k] = v; } }
  const cache = {};
  for (const [k, e] of env.cache) if (e.exp > env.t) cache[k] = [e.v, e.exp];
  return { props, cache };
}


function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
module.exports = { makeEnv, J, stateOf, rng, T0 };
