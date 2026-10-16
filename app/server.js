'use strict';
// Family Vault: everything is encrypted at rest with AES-256-GCM, using a key derived from a passphrase
// (scrypt). The key lives only in memory while the vault is unlocked.

const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const yazl = require('yazl');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = path.resolve(process.env.DATA_DIR || '/data');
const FILES_DIR = path.join(DATA_DIR, 'files');
const META_FILE = path.join(DATA_DIR, 'meta.json');
const DB_FILE = path.join(DATA_DIR, 'vault.db');
const MAX_UPLOAD = 500 * 1024 * 1024;
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const VERIFIER_TEXT = 'family-vault-ok';

fs.mkdirSync(FILES_DIR, { recursive: true });

// ---------- crypto helpers ----------
const deriveKey = (pass, salt) =>
  new Promise((resolve, reject) =>
    crypto.scrypt(pass, salt, 32, SCRYPT, (err, key) => (err ? reject(err) : resolve(key)))
  );

function sealBuffer(key, buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]); // iv | tag | ciphertext
}
function openBuffer(key, blob) {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}
async function atomicWrite(file, data, mode) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, data, mode ? { mode } : undefined);
  await fsp.rename(tmp, file);
}

// ---------- vault state ----------
const state = { key: null, db: null, lastActive: Date.now(), fails: 0, lockedUntil: 0 };
let meta = null; // plaintext: salt, verifier, settings

async function loadMeta() {
  meta = await readJson(META_FILE, null);
}
const initialized = () => !!(meta && meta.salt);

function lock() {
  state.key = null;
  state.db = null;
}

const LISTS = ['people', 'items', 'files', 'reminders', 'contacts', 'bitcoin', 'wallets'];
const DEFAULT_SETTINGS = { btcLookups: true, btcApi: 'https://mempool.space/api' };
const EMPTY_DB = () => ({
  rev: 0,
  people: [],
  items: [],
  files: [],
  reminders: [],
  contacts: [],
  bitcoin: [], // where wallets, accounts and seed phrases are kept (instructions, not secrets)
  wallets: [], // tracked public addresses
  settings: { ...DEFAULT_SETTINGS },
});
// Vaults created by older versions lack the newer lists: fill them in.
function normalizeDb(d) {
  const base = EMPTY_DB();
  const out = { ...base, ...d };
  for (const k of LISTS) if (!Array.isArray(out[k])) out[k] = [];
  out.settings = { ...DEFAULT_SETTINGS, ...(d && d.settings) };
  return out;
}

async function saveDb() {
  const blob = sealBuffer(state.key, Buffer.from(JSON.stringify(state.db)));
  await atomicWrite(DB_FILE, blob, 0o600);
}

async function loadDb(key) {
  try {
    const blob = await fsp.readFile(DB_FILE);
    return normalizeDb(JSON.parse(openBuffer(key, blob).toString('utf8')));
  } catch (e) {
    if (e.code === 'ENOENT') return EMPTY_DB();
    throw e;
  }
}

// Remove encrypted files that are no longer referenced (and are not brand-new uploads waiting to be filed).
async function collectGarbage() {
  if (!state.db) return;
  const keep = new Set(state.db.files.map((f) => f.id));
  let names = [];
  try {
    names = await fsp.readdir(FILES_DIR);
  } catch {}
  for (const n of names) {
    const id = n.replace(/\.bin$/, '');
    if (keep.has(id) || !n.endsWith('.bin')) continue;
    try {
      const st = await fsp.stat(path.join(FILES_DIR, n));
      if (Date.now() - st.mtimeMs > 10 * 60 * 1000) await fsp.unlink(path.join(FILES_DIR, n));
    } catch {}
  }
}

setInterval(() => {
  const mins = (meta && meta.autoLockMin) ?? 30;
  if (state.key && mins > 0 && Date.now() - state.lastActive > mins * 60 * 1000) lock();
}, 30 * 1000).unref();

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));
app.use('/api', express.json({ limit: '10mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/status', (_req, res) => {
  res.json({
    initialized: initialized(),
    unlocked: !!state.key,
    autoLockMin: (meta && meta.autoLockMin) ?? 30,
  });
});

app.post('/api/setup', async (req, res) => {
  if (initialized()) return res.status(409).json({ error: 'The vault is already set up.' });
  const pass = String((req.body && req.body.passphrase) || '');
  if (pass.length < 8) return res.status(400).json({ error: 'Use a passphrase of at least 8 characters.' });
  const salt = crypto.randomBytes(16);
  const key = await deriveKey(pass, salt);
  meta = {
    v: 1,
    salt: salt.toString('base64'),
    verifier: sealBuffer(key, Buffer.from(VERIFIER_TEXT)).toString('base64'),
    autoLockMin: 30,
    createdAt: new Date().toISOString(),
  };
  await atomicWrite(META_FILE, JSON.stringify(meta, null, 2), 0o600);
  state.key = key;
  state.db = EMPTY_DB();
  state.lastActive = Date.now();
  await saveDb();
  res.json({ ok: true });
});

app.post('/api/unlock', async (req, res) => {
  if (!initialized()) return res.status(409).json({ error: 'The vault is not set up yet.' });
  const wait = state.lockedUntil - Date.now();
  if (wait > 0) return res.status(429).json({ error: `Too many tries. Wait ${Math.ceil(wait / 1000)} seconds.` });
  const pass = String((req.body && req.body.passphrase) || '');
  try {
    const key = await deriveKey(pass, Buffer.from(meta.salt, 'base64'));
    const ok = openBuffer(key, Buffer.from(meta.verifier, 'base64')).toString() === VERIFIER_TEXT;
    if (!ok) throw new Error('bad');
    state.key = key;
    state.db = await loadDb(key);
    state.fails = 0;
    state.lastActive = Date.now();
    collectGarbage();
    res.json({ ok: true });
  } catch {
    state.fails++;
    state.lockedUntil = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(state.fails, 5));
    res.status(401).json({ error: 'That passphrase is not right.' });
  }
});

app.post('/api/lock', (_req, res) => {
  lock();
  res.json({ ok: true });
});

// everything below needs the vault to be unlocked
app.use('/api', (req, res, next) => {
  if (!state.key) return res.status(423).json({ error: 'The vault is locked.' });
  state.lastActive = Date.now();
  next();
});

function cleanSettings(s) {
  const out = { ...DEFAULT_SETTINGS };
  if (s && typeof s === 'object') {
    out.btcLookups = s.btcLookups !== false;
    try {
      const u = new URL(String(s.btcApi || DEFAULT_SETTINGS.btcApi));
      if (u.protocol === 'http:' || u.protocol === 'https:') out.btcApi = u.toString().replace(/\/+$/, '');
    } catch {}
  }
  return out;
}

app.get('/api/db', (_req, res) => res.json(state.db));

// ---------- bitcoin balance lookups ----------
// Only public addresses are ever sent, and only to the API address in Settings (default: mempool.space;
// point it at your own Mempool node on Umbrel to keep lookups private).
const ADDR_RE = /^(bc1[ac-hj-np-z02-9]{11,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/i;
const btcCache = new Map(); // key -> {t, v}
async function getJson(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}
async function cached(key, fn, ttl = 60000) {
  const hit = btcCache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  const v = await fn();
  btcCache.set(key, { t: Date.now(), v });
  return v;
}
app.get('/api/btc/summary', async (_req, res) => {
  const st = state.db.settings;
  const out = { enabled: st.btcLookups, source: st.btcApi, price: null, wallets: [], at: Date.now() };
  if (!st.btcLookups) return res.json(out);
  try {
    out.price = await cached(`${st.btcApi}|price`, async () => (await getJson(`${st.btcApi}/v1/prices`)).USD || null);
  } catch {}
  out.wallets = await Promise.all(
    state.db.wallets.slice(0, 50).map(async (w) => {
      const addr = String(w.address || '').trim();
      if (!ADDR_RE.test(addr)) return { id: w.id, error: 'Not a valid Bitcoin address.' };
      try {
        const j = await cached(`${st.btcApi}|${addr}`, () => getJson(`${st.btcApi}/address/${encodeURIComponent(addr)}`));
        const c = j.chain_stats || {}, m = j.mempool_stats || {};
        const confirmed = (c.funded_txo_sum || 0) - (c.spent_txo_sum || 0);
        const pending = (m.funded_txo_sum || 0) - (m.spent_txo_sum || 0);
        return { id: w.id, confirmed, pending, txCount: (c.tx_count || 0) + (m.tx_count || 0) };
      } catch (e) {
        return { id: w.id, error: 'Lookup failed. Check the API address in Settings.' };
      }
    })
  );
  res.json(out);
});

app.put('/api/db', async (req, res) => {
  const b = req.body || {};
  if (!LISTS.every((k) => Array.isArray(b[k]))) return res.status(400).json({ error: 'Invalid data.' });
  if (b.rev !== state.db.rev) return res.status(409).json({ error: 'The vault changed in another window. Reload to continue.' });
  const next = { rev: state.db.rev + 1 };
  for (const k of LISTS) next[k] = b[k];
  next.settings = cleanSettings(b.settings);
  state.db = next;
  await saveDb();
  collectGarbage();
  res.json({ rev: next.rev });
});

app.put('/api/files', (req, res) => {
  const id = crypto.randomUUID();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', state.key, iv);
  const out = fs.createWriteStream(path.join(FILES_DIR, `${id}.bin`), { mode: 0o600 });
  let size = 0;
  let failed = false;
  const fail = (code, msg) => {
    if (failed) return;
    failed = true;
    out.destroy();
    fsp.unlink(path.join(FILES_DIR, `${id}.bin`)).catch(() => {});
    if (!res.headersSent) res.status(code).json({ error: msg });
  };
  out.write(iv);
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_UPLOAD) {
      req.unpipe();
      fail(413, 'That file is too large (500 MB limit).');
    }
  });
  req.on('error', () => fail(400, 'Upload failed.'));
  cipher.on('error', () => fail(500, 'Encryption failed.'));
  out.on('error', () => fail(500, 'Could not save the file.'));
  cipher.on('end', () => {
    if (failed) return;
    out.end(cipher.getAuthTag());
  });
  out.on('finish', () => {
    if (!failed) res.status(201).json({ id, size });
  });
  req.pipe(cipher).pipe(out, { end: false });
});

async function streamDecrypted(key, id, res) {
  const file = path.join(FILES_DIR, `${id.replace(/[^\w-]/g, '')}.bin`);
  const st = await fsp.stat(file);
  if (st.size < 28) throw new Error('corrupt');
  const fd = await fsp.open(file, 'r');
  const head = Buffer.alloc(12);
  const tag = Buffer.alloc(16);
  await fd.read(head, 0, 12, 0);
  await fd.read(tag, 0, 16, st.size - 16);
  await fd.close();
  const d = crypto.createDecipheriv('aes-256-gcm', key, head);
  d.setAuthTag(tag);
  const rs = fs.createReadStream(file, { start: 12, end: st.size - 17 });
  rs.on('error', () => res.destroy());
  d.on('error', () => res.destroy());
  rs.pipe(d).pipe(res);
}

app.get('/api/files/:id', async (req, res) => {
  const rec = state.db.files.find((f) => f.id === req.params.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  const safe = String(rec.name || 'file').replace(/[\r\n"\\]/g, '_');
  const inlineOk = /^(image\/(png|jpe?g|gif|webp)|application\/pdf|text\/plain)$/.test(rec.type || '');
  res.set({
    'Content-Type': inlineOk ? rec.type : 'application/octet-stream',
    'Content-Disposition': `${inlineOk && !req.query.dl ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(safe)}`,
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
    'Content-Length': String(Math.max(0, rec.size || 0)) || undefined,
  });
  if (!rec.size) res.removeHeader('Content-Length');
  try {
    await streamDecrypted(state.key, rec.id, res);
  } catch {
    if (!res.headersSent) res.status(404).json({ error: 'File data is missing.' });
    else res.destroy();
  }
});

app.post('/api/settings', async (req, res) => {
  const mins = parseInt(req.body && req.body.autoLockMin, 10);
  if (![0, 5, 15, 30, 60, 240].includes(mins)) return res.status(400).json({ error: 'Invalid setting.' });
  meta.autoLockMin = mins;
  await atomicWrite(META_FILE, JSON.stringify(meta, null, 2), 0o600);
  res.json({ ok: true });
});

// Change the passphrase: every file is decrypted and re-encrypted with the new key.
app.post('/api/change-passphrase', async (req, res) => {
  const oldPass = String((req.body && req.body.oldPassphrase) || '');
  const newPass = String((req.body && req.body.newPassphrase) || '');
  if (newPass.length < 8) return res.status(400).json({ error: 'Use a passphrase of at least 8 characters.' });
  try {
    const oldKey = await deriveKey(oldPass, Buffer.from(meta.salt, 'base64'));
    if (openBuffer(oldKey, Buffer.from(meta.verifier, 'base64')).toString() !== VERIFIER_TEXT) throw new Error('bad');
  } catch {
    return res.status(401).json({ error: 'The current passphrase is not right.' });
  }
  const salt = crypto.randomBytes(16);
  const newKey = await deriveKey(newPass, salt);
  const names = (await fsp.readdir(FILES_DIR)).filter((n) => n.endsWith('.bin'));
  const tmps = [];
  try {
    for (const n of names) {
      const src = path.join(FILES_DIR, n);
      const dst = `${src}.new`;
      const blob = await fsp.readFile(src);
      const iv = blob.subarray(0, 12);
      const tag = blob.subarray(blob.length - 16);
      const d = crypto.createDecipheriv('aes-256-gcm', state.key, iv);
      d.setAuthTag(tag);
      const plain = Buffer.concat([d.update(blob.subarray(12, blob.length - 16)), d.final()]);
      const iv2 = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', newKey, iv2);
      const ct = Buffer.concat([c.update(plain), c.final()]);
      await fsp.writeFile(dst, Buffer.concat([iv2, ct, c.getAuthTag()]), { mode: 0o600 });
      tmps.push([src, dst]);
    }
  } catch (e) {
    for (const [, dst] of tmps) fsp.unlink(dst).catch(() => {});
    return res.status(500).json({ error: 'Could not re-encrypt every file, so nothing was changed.' });
  }
  for (const [src, dst] of tmps) await fsp.rename(dst, src);
  const oldKeyHolder = state.key;
  state.key = newKey;
  await saveDb();
  meta.salt = salt.toString('base64');
  meta.verifier = sealBuffer(newKey, Buffer.from(VERIFIER_TEXT)).toString('base64');
  await atomicWrite(META_FILE, JSON.stringify(meta, null, 2), 0o600);
  oldKeyHolder.fill(0);
  res.json({ ok: true });
});

// An encrypted backup: the same files that live on disk. Useless without your passphrase.
app.get('/api/backup', async (_req, res) => {
  const zip = new yazl.ZipFile();
  zip.addFile(META_FILE, 'family-vault-backup/meta.json');
  try {
    await fsp.access(DB_FILE);
    zip.addFile(DB_FILE, 'family-vault-backup/vault.db');
  } catch {}
  for (const n of await fsp.readdir(FILES_DIR)) {
    if (n.endsWith('.bin')) zip.addFile(path.join(FILES_DIR, n), `family-vault-backup/files/${n}`, { compress: false });
  }
  res.set({
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="family-vault-backup-${new Date().toISOString().slice(0, 10)}.zip"`,
  });
  zip.outputStream.pipe(res);
  zip.end();
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

loadMeta().then(() => {
  app.listen(PORT, '0.0.0.0', () => console.log(`Family Vault listening on :${PORT} (data: ${DATA_DIR})`));
});
