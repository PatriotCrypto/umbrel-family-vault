'use strict';
// Family Vault 0.3.0
// Storage v2: a random 256-bit master key encrypts every file and the vault index (AES-256-GCM). The master key is
// stored only "wrapped" (encrypted) by a key derived from your passphrase with scrypt. Changing the passphrase only
// re-wraps the master key, so it is instant and cannot leave the vault half-converted.
// Legacy v1 vaults (key = scrypt(passphrase)) still open, and can be upgraded with a crash-safe migration.

const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const yazl = require('yazl');
const yauzl = require('yauzl');
const { HDKey } = require('@scure/bip32');
const { sha256 } = require('@noble/hashes/sha256');
const { ripemd160 } = require('@noble/hashes/ripemd160');
const { bech32, createBase58check } = require('@scure/base');

const VERSION = require('./package.json').version;
const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = path.resolve(process.env.DATA_DIR || '/data');
const META_FILE = path.join(DATA_DIR, 'meta.json');
const NTFY_FILE = path.join(DATA_DIR, 'ntfy.json');
const ALERTS_FILE = path.join(DATA_DIR, 'alerts.json');
const SENT_FILE = path.join(DATA_DIR, 'ntfy-sent.json');
const V1 = { dir: DATA_DIR, files: path.join(DATA_DIR, 'files'), db: path.join(DATA_DIR, 'vault.db') };
const V2DIR = path.join(DATA_DIR, 'v2');
const V2 = { dir: V2DIR, files: path.join(V2DIR, 'files'), db: path.join(V2DIR, 'vault.db') };
const MAX_UPLOAD = 500 * 1024 * 1024;
const KDF_LEGACY = { N: 32768, r: 8, p: 1 };
const KDF_DEFAULT = { N: 131072, r: 8, p: 1 };
const MIN_PASS = 12;
const VERIFIER_TEXT = 'family-vault-ok';
const UUID_RE = /^[0-9a-f-]{36}$/;

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- crypto helpers ----------
const deriveKey = (pass, salt, kdf) =>
  new Promise((resolve, reject) =>
    crypto.scrypt(pass, salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 512 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)))
  );
function sealBuffer(key, buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]); // iv | tag | ciphertext
}
function openBuffer(key, blob) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
}
async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; }
}
async function atomicWrite(file, data, mode = 0o600) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fh = await fsp.open(tmp, 'w', mode);
  try { await fh.writeFile(data); await fh.sync(); } finally { await fh.close(); }
  await fsp.rename(tmp, file);
}
const rmrf = (p) => fsp.rm(p, { recursive: true, force: true }).catch(() => {});

// ---------- vault state ----------
const state = { key: null, db: null, sessions: new Map(), fails: 0, lockedUntil: 0, upgrade: null };
let meta = null;
const initialized = () => !!(meta && (meta.v === 2 ? meta.wrapped : meta.salt));
const ver = () => (meta && meta.v === 2 ? 2 : 1);
const store = () => (ver() === 2 ? V2 : V1);

async function loadMeta() {
  meta = await readJson(META_FILE, null);
  if (!meta) return;
  // crash cleanup: a half-finished upgrade leaves a staging folder (v1 still active) or old v1 files (v2 active)
  if (ver() === 1) await rmrf(V2DIR);
  else { await rmrf(V1.files); await fsp.unlink(V1.db).catch(() => {}); }
}

function lock() {
  if (state.key) state.key.fill(0);
  state.key = null;
  state.db = null;
  state.sessions.clear();
}

const LISTS = ['people', 'items', 'files', 'reminders', 'contacts', 'bitcoin', 'wallets'];
const DEFAULT_SETTINGS = { btcLookups: true, btcApi: 'https://mempool.space/api', familyName: '' };
const EMPTY_DB = () => ({ rev: 0, people: [], items: [], files: [], reminders: [], contacts: [], bitcoin: [], wallets: [], settings: { ...DEFAULT_SETTINGS } });
function normalizeDb(d) {
  const out = { ...EMPTY_DB(), ...d };
  for (const k of LISTS) if (!Array.isArray(out[k])) out[k] = [];
  out.settings = { ...DEFAULT_SETTINGS, ...(d && d.settings) };
  return out;
}
async function saveDb() {
  await atomicWrite(store().db, sealBuffer(state.key, Buffer.from(JSON.stringify(state.db))));
  refreshAlerts().catch(() => {});
}
async function loadDb(key, st) {
  try { return normalizeDb(JSON.parse(openBuffer(key, await fsp.readFile(st.db)).toString('utf8'))); }
  catch (e) { if (e.code === 'ENOENT') return EMPTY_DB(); throw e; }
}

async function collectGarbage() {
  if (!state.db || state.upgrade) return;
  const keep = new Set(state.db.files.map((f) => f.id));
  let names = [];
  try { names = await fsp.readdir(store().files); } catch {}
  for (const n of names) {
    if (!n.endsWith('.bin') || keep.has(n.slice(0, -4))) continue;
    try {
      const f = path.join(store().files, n);
      if (Date.now() - (await fsp.stat(f)).mtimeMs > 10 * 60 * 1000) await fsp.unlink(f);
    } catch {}
  }
}

// ---------- sessions (one per browser) ----------
const COOKIE = 'fv_session';
function getCookie(req, name) {
  const m = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(name + '='));
  return m ? m.slice(name.length + 1) : '';
}
const idleLimit = () => ((meta && meta.autoLockMin) ?? 30) * 60 * 1000;
function sessionOk(req) {
  const t = getCookie(req, COOKIE), s = t && state.sessions.get(t);
  if (!s || !state.key) return false;
  if (idleLimit() > 0 && Date.now() - s.last > idleLimit()) { state.sessions.delete(t); return false; }
  s.last = Date.now();
  return true;
}
function startSession(res) {
  const t = crypto.randomBytes(32).toString('hex');
  state.sessions.set(t, { last: Date.now() });
  res.append('Set-Cookie', `${COOKIE}=${t}; HttpOnly; SameSite=Strict; Path=/`);
}
setInterval(() => {
  for (const [t, s] of state.sessions) if (idleLimit() > 0 && Date.now() - s.last > idleLimit()) state.sessions.delete(t);
  if (state.key && state.sessions.size === 0 && !state.upgrade) lock();
}, 30 * 1000).unref();

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'";
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP, 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' });
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));
// Browsers must send a custom header on every state-changing call (this forces a CORS preflight for other sites), and
// the page origin must match: other websites cannot drive the vault even if you are signed in.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (req.headers['x-fv'] !== '1') return res.status(403).json({ error: 'Blocked.' });
    const o = req.headers.origin;
    if (o) { try { if (new URL(o).host !== req.headers.host) return res.status(403).json({ error: 'Blocked.' }); } catch { return res.status(403).json({ error: 'Blocked.' }); } }
  }
  next();
});
app.use('/api', express.json({ limit: '10mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/status', (req, res) => {
  const ok = sessionOk(req);
  res.json({ version: VERSION, initialized: initialized(), unlocked: ok, legacy: ok && ver() === 1, upgrade: ok ? state.upgrade : null, autoLockMin: (meta && meta.autoLockMin) ?? 30 });
});

async function createVault(pass) {
  const salt = crypto.randomBytes(16);
  const kek = await deriveKey(pass, salt, KDF_DEFAULT);
  const master = crypto.randomBytes(32);
  await fsp.mkdir(V2.files, { recursive: true });
  meta = { v: 2, kdf: { ...KDF_DEFAULT, salt: salt.toString('base64') }, wrapped: sealBuffer(kek, master).toString('base64'), autoLockMin: 30, createdAt: new Date().toISOString() };
  kek.fill(0);
  state.key = master;
  state.db = EMPTY_DB();
  await saveDb();
  await atomicWrite(META_FILE, JSON.stringify(meta, null, 2));
}

app.post('/api/setup', async (req, res) => {
  if (initialized()) return res.status(409).json({ error: 'The vault is already set up.' });
  const pass = String((req.body && req.body.passphrase) || '');
  if (pass.length < MIN_PASS) return res.status(400).json({ error: `Use a passphrase of at least ${MIN_PASS} characters.` });
  await createVault(pass);
  startSession(res);
  res.json({ ok: true });
});

app.post('/api/unlock', async (req, res) => {
  if (!initialized()) return res.status(409).json({ error: 'The vault is not set up yet.' });
  const wait = state.lockedUntil - Date.now();
  if (wait > 0) return res.status(429).json({ error: `Too many tries. Wait ${Math.ceil(wait / 1000)} seconds.` });
  const pass = String((req.body && req.body.passphrase) || '');
  try {
    let key;
    if (ver() === 2) {
      const kek = await deriveKey(pass, Buffer.from(meta.kdf.salt, 'base64'), meta.kdf);
      key = openBuffer(kek, Buffer.from(meta.wrapped, 'base64')); // throws if the passphrase is wrong
      kek.fill(0);
    } else {
      key = await deriveKey(pass, Buffer.from(meta.salt, 'base64'), KDF_LEGACY);
      if (openBuffer(key, Buffer.from(meta.verifier, 'base64')).toString() !== VERIFIER_TEXT) throw new Error('bad');
    }
    if (!state.key || !state.key.equals(key)) { if (state.key) state.key.fill(0); state.key = key; state.db = await loadDb(key, store()); }
    state.fails = 0;
    startSession(res);
    collectGarbage();
    res.json({ ok: true });
  } catch {
    state.fails++;
    state.lockedUntil = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(state.fails, 5));
    res.status(401).json({ error: 'That passphrase is not right.' });
  }
});

app.post('/api/lock', (_req, res) => { lock(); res.json({ ok: true }); });

// ----- restore a backup ZIP into an empty vault (only allowed before a vault exists) -----
app.post('/api/restore', async (req, res) => {
  if (initialized()) return res.status(409).json({ error: 'A vault already exists here.' });
  const tmp = path.join(DATA_DIR, `restore-${Date.now()}.zip`);
  try {
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 8 * 1024 * 1024 * 1024) req.destroy(); });
    await pipeline(req, fs.createWriteStream(tmp, { mode: 0o600 }));
    const zip = await new Promise((ok, no) => yauzl.open(tmp, { lazyEntries: true, autoClose: false }, (e, z) => (e ? no(e) : ok(z))));
    const entries = [];
    await new Promise((ok, no) => {
      zip.on('entry', (en) => { entries.push(en); zip.readEntry(); });
      zip.on('end', ok); zip.on('error', no); zip.readEntry();
    });
    const get = (en) => new Promise((ok, no) => zip.openReadStream(en, (e, s) => (e ? no(e) : ok(s))));
    const metaEntry = entries.find((e) => e.fileName === 'family-vault-backup/meta.json');
    if (!metaEntry) throw new Error('This is not a Family Vault backup.');
    const chunks = []; for await (const c of await get(metaEntry)) chunks.push(c);
    const m = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (m.v !== 2 && !m.salt) throw new Error('Unrecognized backup.');
    const target = m.v === 2 ? V2 : V1;
    await fsp.mkdir(target.files, { recursive: true });
    for (const en of entries) {
      const n = en.fileName;
      let dest = null;
      if (n === 'family-vault-backup/vault.db') dest = target.db;
      else { const mm = n.match(/^family-vault-backup\/files\/([0-9a-f-]{36})\.bin$/); if (mm) dest = path.join(target.files, `${mm[1]}.bin`); }
      if (!dest) continue;
      await pipeline(await get(en), fs.createWriteStream(dest, { mode: 0o600 }));
    }
    zip.close();
    await atomicWrite(META_FILE, JSON.stringify(m, null, 2));
    await loadMeta();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Could not restore that file.' });
  } finally { fsp.unlink(tmp).catch(() => {}); }
});

// ================= everything below needs an unlocked session =================
app.use('/api', (req, res, next) => {
  if (!sessionOk(req)) return res.status(423).json({ error: 'The vault is locked.' });
  next();
});
const busy = (res) => (state.upgrade && state.upgrade.running ? (res.status(409).json({ error: 'Encryption upgrade in progress. Please wait.' }), true) : false);

function cleanSettings(s) {
  const out = { ...DEFAULT_SETTINGS };
  if (s && typeof s === 'object') {
    out.btcLookups = s.btcLookups !== false;
    out.familyName = typeof s.familyName === 'string' ? s.familyName.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60) : '';
    try {
      const u = new URL(String(s.btcApi || DEFAULT_SETTINGS.btcApi));
      if (u.protocol === 'http:' || u.protocol === 'https:') out.btcApi = u.toString().replace(/\/+$/, '');
    } catch {}
  }
  return out;
}
const PRV_RE = /[xyztuvXYZTUV]prv|^[5KL][1-9A-HJ-NP-Za-km-z]{50,51}$/;
app.get('/api/db', (_req, res) => res.json(state.db));
app.put('/api/db', async (req, res) => {
  if (busy(res)) return;
  const b = req.body || {};
  if (!LISTS.every((k) => Array.isArray(b[k]))) return res.status(400).json({ error: 'Invalid data.' });
  if (b.rev !== state.db.rev) return res.status(409).json({ error: 'The vault changed in another window. Reload to continue.' });
  for (const w of b.wallets) {
    const a = String((w && w.address) || '').trim(), x = String((w && w.xpub) || '').trim();
    if (PRV_RE.test(a) || PRV_RE.test(x)) return res.status(400).json({ error: 'That looks like a private key. Only public addresses or extended public keys (xpub/ypub/zpub) are allowed.' });
    if (x ? !XPUB_RE.test(x) : !ADDR_RE.test(a)) return res.status(400).json({ error: 'A tracked wallet needs a valid Bitcoin address or extended public key (xpub/ypub/zpub). Never enter a seed phrase.' });
  }
  const next = { rev: state.db.rev + 1 };
  for (const k of LISTS) next[k] = b[k];
  next.settings = cleanSettings(b.settings);
  state.db = next;
  await saveDb();
  collectGarbage();
  res.json({ rev: next.rev });
});

// ----- files -----
app.put('/api/files', (req, res) => {
  if (busy(res)) return;
  const id = crypto.randomUUID();
  const key = state.key;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const dest = path.join(store().files, `${id}.bin`);
  const out = fs.createWriteStream(dest, { mode: 0o600 });
  let size = 0, failed = false;
  const fail = (code, msg) => { if (failed) return; failed = true; out.destroy(); fsp.unlink(dest).catch(() => {}); if (!res.headersSent) res.status(code).json({ error: msg }); };
  out.write(iv);
  req.on('data', (c) => { size += c.length; if (size > MAX_UPLOAD) { req.unpipe(); fail(413, 'That file is too large (500 MB limit).'); } });
  req.on('error', () => fail(400, 'Upload failed.'));
  cipher.on('error', () => fail(500, 'Encryption failed.'));
  out.on('error', () => fail(500, 'Could not save the file.'));
  cipher.on('end', () => { if (!failed) out.end(cipher.getAuthTag()); });
  out.on('finish', () => { if (!failed) res.status(201).json({ id, size }); });
  req.pipe(cipher).pipe(out, { end: false });
});

async function decryptStream(key, file) {
  const st = await fsp.stat(file);
  if (st.size < 28) throw new Error('corrupt');
  const fd = await fsp.open(file, 'r');
  const head = Buffer.alloc(12), tag = Buffer.alloc(16);
  await fd.read(head, 0, 12, 0); await fd.read(tag, 0, 16, st.size - 16); await fd.close();
  const d = crypto.createDecipheriv('aes-256-gcm', key, head);
  d.setAuthTag(tag);
  const rs = fs.createReadStream(file, { start: 12, end: st.size - 17 });
  rs.on('error', (e) => d.destroy(e));
  return rs.pipe(d);
}
// Writes iv | ciphertext | auth tag, like uploads do.
class SealStream extends Transform {
  constructor(key) { super(); this.iv = crypto.randomBytes(12); this.c = crypto.createCipheriv('aes-256-gcm', key, this.iv); this.push(this.iv); }
  _transform(chunk, _e, cb) { cb(null, this.c.update(chunk)); }
  _flush(cb) { this.push(this.c.final()); this.push(this.c.getAuthTag()); cb(); }
}
app.get('/api/files/:id', async (req, res) => {
  const rec = state.db.files.find((f) => f.id === req.params.id);
  if (!rec || !UUID_RE.test(rec.id)) return res.status(404).json({ error: 'not found' });
  const safe = String(rec.name || 'file').replace(/[\r\n"\\]/g, '_');
  const isPdf = rec.type === 'application/pdf';
  const inlineOk = /^(image\/(png|jpe?g|gif|webp)|application\/pdf|text\/plain)$/.test(rec.type || '');
  res.set({
    'Content-Type': inlineOk ? rec.type : 'application/octet-stream',
    'Content-Disposition': `${inlineOk && !req.query.dl ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(safe)}`,
  });
  // images/text: locked-down sandbox. PDFs are inert in the browser's own viewer, which a sandbox policy would block.
  if (isPdf) res.removeHeader('Content-Security-Policy'); else res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
  try {
    const s = await decryptStream(state.key, path.join(store().files, `${rec.id}.bin`));
    s.on('error', () => res.destroy());
    s.pipe(res);
  } catch {
    if (!res.headersSent) res.status(404).json({ error: 'File data is missing.' }); else res.destroy();
  }
});

// ----- settings, passphrase, upgrade -----
app.post('/api/settings', async (req, res) => {
  const mins = parseInt(req.body && req.body.autoLockMin, 10);
  if (![0, 5, 15, 30, 60, 240].includes(mins)) return res.status(400).json({ error: 'Invalid setting.' });
  meta.autoLockMin = mins;
  await atomicWrite(META_FILE, JSON.stringify(meta, null, 2));
  res.json({ ok: true });
});

app.post('/api/change-passphrase', async (req, res) => {
  if (ver() !== 2) return res.status(409).json({ error: 'Upgrade the encryption first (Settings → Security).' });
  const oldPass = String((req.body && req.body.oldPassphrase) || ''), newPass = String((req.body && req.body.newPassphrase) || '');
  if (newPass.length < MIN_PASS) return res.status(400).json({ error: `Use a passphrase of at least ${MIN_PASS} characters.` });
  let master;
  try {
    const kek = await deriveKey(oldPass, Buffer.from(meta.kdf.salt, 'base64'), meta.kdf);
    master = openBuffer(kek, Buffer.from(meta.wrapped, 'base64')); kek.fill(0);
  } catch { return res.status(401).json({ error: 'The current passphrase is not right.' }); }
  const salt = crypto.randomBytes(16);
  const kek2 = await deriveKey(newPass, salt, KDF_DEFAULT);
  const next = { ...meta, kdf: { ...KDF_DEFAULT, salt: salt.toString('base64') }, wrapped: sealBuffer(kek2, master).toString('base64') };
  kek2.fill(0); master.fill(0);
  await atomicWrite(META_FILE, JSON.stringify(next, null, 2)); // single atomic write: either the old or the new passphrase works
  meta = next;
  res.json({ ok: true });
});

async function reencryptFile(oldKey, src, newKey, dst) {
  await pipeline(await decryptStream(oldKey, src), new SealStream(newKey), fs.createWriteStream(dst, { mode: 0o600 }));
}
async function runUpgrade(newPass) {
  const job = state.upgrade;
  try {
    const oldKey = state.key;
    const master = crypto.randomBytes(32);
    const salt = crypto.randomBytes(16);
    const kek = await deriveKey(newPass, salt, KDF_DEFAULT);
    await rmrf(V2DIR);
    await fsp.mkdir(V2.files, { recursive: true });
    const names = (await fsp.readdir(V1.files)).filter((n) => n.endsWith('.bin'));
    job.total = names.length;
    for (const n of names) {
      await reencryptFile(oldKey, path.join(V1.files, n), master, path.join(V2.files, n));
      job.done++;
    }
    await atomicWrite(V2.db, sealBuffer(master, Buffer.from(JSON.stringify(state.db))));
    const next = { v: 2, kdf: { ...KDF_DEFAULT, salt: salt.toString('base64') }, wrapped: sealBuffer(kek, master).toString('base64'), autoLockMin: meta.autoLockMin ?? 30, createdAt: meta.createdAt || new Date().toISOString(), upgradedAt: new Date().toISOString() };
    kek.fill(0);
    await atomicWrite(META_FILE, JSON.stringify(next, null, 2)); // <- the cutover: before this line v1 is intact
    meta = next;
    const old = state.key; state.key = master; old.fill(0);
    await rmrf(V1.files); await fsp.unlink(V1.db).catch(() => {});
    job.running = false; job.finished = true;
  } catch (e) {
    await rmrf(V2DIR);
    job.running = false; job.error = 'The upgrade did not complete, so nothing was changed. ' + (e.message || '');
  }
}
app.post('/api/upgrade', async (req, res) => {
  if (ver() !== 1) return res.status(409).json({ error: 'Already upgraded.' });
  if (state.upgrade && state.upgrade.running) return res.status(409).json({ error: 'Upgrade already running.' });
  const pass = String((req.body && req.body.newPassphrase) || '');
  if (pass.length < MIN_PASS) return res.status(400).json({ error: `Use a passphrase of at least ${MIN_PASS} characters.` });
  state.upgrade = { running: true, done: 0, total: 0 };
  runUpgrade(pass);
  res.json({ ok: true });
});

// ----- backup -----
app.get('/api/backup', async (_req, res) => {
  const zip = new yazl.ZipFile();
  zip.addFile(META_FILE, 'family-vault-backup/meta.json');
  try { await fsp.access(store().db); zip.addFile(store().db, 'family-vault-backup/vault.db'); } catch {}
  for (const n of await fsp.readdir(store().files)) if (n.endsWith('.bin')) zip.addFile(path.join(store().files, n), `family-vault-backup/files/${n}`, { compress: false });
  res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="family-vault-backup-${new Date().toISOString().slice(0, 10)}.zip"` });
  zip.outputStream.pipe(res);
  zip.end();
});

// ================= bitcoin =================
const ADDR_RE = /^(bc1[ac-hj-np-z02-9]{11,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/i;
const XPUB_RE = /^[xyz]pub[1-9A-HJ-NP-Za-km-z]{100,112}$/;
const XVERS = { zpub: 0x04b24746, ypub: 0x049d7cb2, xpub: 0x0488b21e };
const b58c = createBase58check(sha256);
const hash160 = (b) => ripemd160(sha256(b));
function deriveAddress(xpub, script, chain, i) {
  const k = HDKey.fromExtendedKey(xpub, { private: 0, public: XVERS[xpub.slice(0, 4)] });
  const h = hash160(k.deriveChild(chain).deriveChild(i).publicKey);
  if (script === 'wpkh') return bech32.encode('bc', [0, ...bech32.toWords(h)]);
  if (script === 'sh-wpkh') return b58c.encode(new Uint8Array([0x05, ...hash160(new Uint8Array([0x00, 0x14, ...h]))]));
  return b58c.encode(new Uint8Array([0x00, ...h]));
}
const scriptFor = (w) => ({ zpub: 'wpkh', ypub: 'sh-wpkh' }[String(w.xpub).slice(0, 4)] || (['wpkh', 'sh-wpkh', 'pkh'].includes(w.script) ? w.script : 'wpkh'));

const btcCache = new Map();
async function getJson(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}
async function cached(key, fn, ttl = 60000) {
  const hit = btcCache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  const v = await fn();
  btcCache.set(key, { t: Date.now(), v });
  return v;
}
async function addrStats(api, addr) {
  const j = await cached(`${api}|${addr}`, () => getJson(`${api}/address/${encodeURIComponent(addr)}`));
  const c = j.chain_stats || {}, m = j.mempool_stats || {};
  return { confirmed: (c.funded_txo_sum || 0) - (c.spent_txo_sum || 0), pending: (m.funded_txo_sum || 0) - (m.spent_txo_sum || 0), txCount: (c.tx_count || 0) + (m.tx_count || 0) };
}
async function scanXpub(api, w) {
  const script = scriptFor(w), GAP = 20;
  let confirmed = 0, pending = 0, txCount = 0, scanned = 0;
  for (const chain of [0, 1]) {
    let i = 0, gap = 0;
    while (gap < GAP && i < 400) {
      const batch = [];
      for (let n = 0; n < 5; n++) batch.push(deriveAddress(w.xpub, script, chain, i + n));
      const res = await Promise.all(batch.map((a) => addrStats(api, a)));
      for (const r of res) {
        scanned++; i++;
        if (r.txCount > 0) { gap = 0; confirmed += r.confirmed; pending += r.pending; txCount += r.txCount; } else gap++;
      }
    }
  }
  return { confirmed, pending, txCount, scanned };
}
app.get('/api/btc/summary', async (_req, res) => {
  const st = state.db.settings;
  const out = { enabled: st.btcLookups, source: st.btcApi, price: null, wallets: [], at: Date.now() };
  if (!st.btcLookups) return res.json(out);
  try { out.price = await cached(`${st.btcApi}|price`, async () => (await getJson(`${st.btcApi}/v1/prices`)).USD || null); } catch {}
  for (const w of state.db.wallets.slice(0, 30)) {
    try {
      if (w.xpub) {
        if (!XPUB_RE.test(String(w.xpub))) { out.wallets.push({ id: w.id, error: 'Not a valid extended public key.' }); continue; }
        out.wallets.push({ id: w.id, ...(await cached(`${st.btcApi}|x|${w.xpub}|${scriptFor(w)}`, () => scanXpub(st.btcApi, w), 300000)) });
      } else {
        const addr = String(w.address || '').trim();
        if (!ADDR_RE.test(addr)) { out.wallets.push({ id: w.id, error: 'Not a valid Bitcoin address.' }); continue; }
        out.wallets.push({ id: w.id, ...(await addrStats(st.btcApi, addr)) });
      }
    } catch { out.wallets.push({ id: w.id, error: 'Lookup failed. Check the API address in Settings, or try again in a minute.' }); }
  }
  res.json(out);
});

// ================= ntfy alerts =================
// Alerts must work while the vault is locked, so the schedule lives in a small UNENCRYPTED file (alerts.json): dates,
// plus titles only if you choose to include them. This is stated plainly in Settings.
const NTFY_DEFAULT = { enabled: false, server: 'https://ntfy.sh', topic: '', token: '', hour: 8, tz: 0, days: [30, 7, 1, 0], includeTitles: false };
const readNtfy = async () => ({ ...NTFY_DEFAULT, ...(await readJson(NTFY_FILE, {})) });
const dayNum = (iso) => Math.floor(Date.parse(iso + 'T00:00:00Z') / 864e5);
async function refreshAlerts() {
  const cfg = await readNtfy();
  if (!cfg.enabled || !state.db) { if (!cfg.enabled) await fsp.unlink(ALERTS_FILE).catch(() => {}); return; }
  const entries = [];
  for (const i of state.db.items) if (i.expires && i.reviewed !== false) entries.push({ id: 'i' + i.id, date: i.expires, label: cfg.includeTitles ? `${i.title} expires` : 'A document is expiring' });
  for (const r of state.db.reminders) if (!r.done && r.date) entries.push({ id: 'r' + r.id, date: r.date, label: cfg.includeTitles ? r.title : 'A reminder is due' });
  await atomicWrite(ALERTS_FILE, JSON.stringify({ entries }));
}
async function ntfySend(cfg, title, message, priority = 3) {
  const headers = { Title: title, Priority: String(priority), Tags: 'lock' };
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  try {
    const r = await fetch(`${cfg.server.replace(/\/+$/, '')}/${encodeURIComponent(cfg.topic)}`, { method: 'POST', body: message, headers, signal: ac.signal });
    if (!r.ok) throw new Error(`The ntfy server answered ${r.status}.`);
  } finally { clearTimeout(timer); }
}
async function runAlerts() {
  const cfg = await readNtfy();
  if (!cfg.enabled || !cfg.topic) return;
  const local = new Date(Date.now() + cfg.tz * 60000);
  if (local.getUTCHours() < cfg.hour) return;
  const today = Math.floor(local.getTime() / 864e5);
  const alerts = await readJson(ALERTS_FILE, { entries: [] });
  const sent = await readJson(SENT_FILE, {});
  const lines = [];
  let urgent = false;
  for (const e of alerts.entries) {
    const left = dayNum(e.date) - today;
    const bucket = left < 0 ? 'late' : cfg.days.includes(left) ? String(left) : null;
    if (bucket === null) continue;
    const key = `${e.id}|${e.date}|${bucket}`;
    if (sent[key]) continue;
    sent[key] = today;
    if (left <= 1) urgent = true;
    lines.push(left < 0 ? `${e.label} (${-left} day${left === -1 ? '' : 's'} overdue)` : left === 0 ? `${e.label} today` : `${e.label} in ${left} day${left === 1 ? '' : 's'}`);
  }
  if (!lines.length) return;
  await ntfySend(cfg, 'Family Vault', lines.slice(0, 8).join('\n') + (lines.length > 8 ? `\n…and ${lines.length - 8} more` : ''), urgent ? 4 : 3);
  for (const k of Object.keys(sent)) if (today - sent[k] > 120) delete sent[k];
  await atomicWrite(SENT_FILE, JSON.stringify(sent));
}
setInterval(() => runAlerts().catch(() => {}), 15 * 60 * 1000).unref();
setTimeout(() => runAlerts().catch(() => {}), 20 * 1000).unref();

app.get('/api/ntfy', async (_req, res) => { const c = await readNtfy(); res.json({ ...c, token: '', tokenSet: !!c.token }); });
app.put('/api/ntfy', async (req, res) => {
  const b = req.body || {}, prev = await readNtfy();
  const cfg = { ...NTFY_DEFAULT };
  cfg.enabled = !!b.enabled;
  try { const u = new URL(String(b.server || NTFY_DEFAULT.server)); if (!/^https?:$/.test(u.protocol)) throw 0; cfg.server = u.toString().replace(/\/+$/, ''); } catch { return res.status(400).json({ error: 'The ntfy server address is not valid.' }); }
  cfg.topic = String(b.topic || '').trim();
  if (cfg.enabled && !/^[A-Za-z0-9_-]{1,64}$/.test(cfg.topic)) return res.status(400).json({ error: 'The topic may use letters, numbers, - and _ (up to 64 characters).' });
  cfg.token = b.token ? String(b.token).trim() : b.clearToken ? '' : prev.token;
  cfg.hour = Math.min(23, Math.max(0, parseInt(b.hour, 10) || 0));
  cfg.tz = Math.min(840, Math.max(-720, parseInt(b.tz, 10) || 0));
  cfg.days = (Array.isArray(b.days) ? b.days : NTFY_DEFAULT.days).map((n) => parseInt(n, 10)).filter((n) => n >= 0 && n <= 365).slice(0, 8);
  cfg.includeTitles = !!b.includeTitles;
  await atomicWrite(NTFY_FILE, JSON.stringify(cfg));
  await refreshAlerts();
  res.json({ ok: true });
});
app.post('/api/ntfy/test', async (_req, res) => {
  const cfg = await readNtfy();
  if (!cfg.topic) return res.status(400).json({ error: 'Save a topic first.' });
  try { await ntfySend(cfg, 'Family Vault', 'Test notification: alerts are working.', 3); res.json({ ok: true }); }
  catch (e) { res.status(502).json({ error: e.name === 'AbortError' ? 'The ntfy server did not answer in time.' : e.message || 'Could not reach the ntfy server.' }); }
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, _req, res, _next) => { console.error(err.message); if (!res.headersSent) res.status(500).json({ error: 'Something went wrong.' }); });

loadMeta().then(() => app.listen(PORT, '0.0.0.0', () => console.log(`Family Vault ${VERSION} listening on :${PORT} (data: ${DATA_DIR})`)));
