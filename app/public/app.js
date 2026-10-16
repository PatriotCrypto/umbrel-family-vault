'use strict';
const BASE_CATS = [['Family','👪'],['Finance','💰'],['Property','🏠'],['Passwords','🔑'],['Insurance','🛡️'],['Tax','🧾'],['Legal','⚖️'],['Business','💼'],['Family Resources','📚']];
const PROTECTED_CATS = ['Family', 'Passwords'];
const CATS = [], CAT_ICON = {};
function syncCats() {
  const st = (db && db.settings) || {};
  let list = st.categories && st.categories.length ? st.categories.map((c) => ({ name: c.name, icon: c.icon })) : BASE_CATS.map(([name, icon]) => ({ name, icon }));
  for (const n of PROTECTED_CATS) if (!list.some((c) => c.name === n)) list.unshift({ name: n, icon: BASE_CATS.find((b) => b[0] === n)[1] });
  if (db) for (const i of db.items) if (i.category && !list.some((c) => c.name === i.category)) list.push({ name: i.category, icon: i.category === 'Employment' ? '👔' : '📁' });
  CATS.length = 0; for (const k of Object.keys(CAT_ICON)) delete CAT_ICON[k];
  for (const c of list) { CATS.push(c.name); CAT_ICON[c.name] = c.icon; }
}
const KINDS = [
  { id: 'birth', label: 'Birth Certificate', icon: '📜', re: /birth/i },
  { id: 'passbook', label: 'Passport Book', icon: '📘', re: /passport(?!.*card)/i },
  { id: 'passcard', label: 'Passport Card', icon: '🪪', re: /passport.*card/i },
  { id: 'dl', label: "Driver's License", icon: '🚗', re: /\bdriver['’]?s?\s+(licen[sc]e|permit)/i },
  { id: 'ssn', label: 'Social Security Card', icon: '🔢', re: /social security|\bssn\b/i },
];
const docKind = (i) => (i.category === 'Family' ? (KINDS.find((k) => k.re.test(i.title)) || {}).id || '' : '');
const HINTS = {
  Family:['birth certificate','birth','passport','driver','drivers','license','licence','social security','ssn','marriage','certificate','vaccination','vaccine','immunization','medical','school','report card','faa','handgun','concealed','carry','state id','id card','visa','citizenship','military','dd214','dd 214','records'],
  Finance:['bank','statement','invoice','receipt','loan','mortgage','401k','ira','brokerage','investment','credit','savings','checking','crypto','wallet','kraken','robinhood','coinbase','balance','deposit'],
  Property:['deed','title','lease','rent','hoa','property','vehicle','registration','car','truck','trailer','house','home','appraisal','survey','boat','closing'],
  Insurance:['insurance','policy','claim','coverage','premium','life','auto','homeowners','umbrella','liability','dental','health'],
  Tax:['tax','1040','w2','w 2','1099','irs','return','k 1','taxes'],
  Legal:['will','trust','power of attorney','poa','contract','court','agreement','divorce','estate','directive','lawsuit','notary','living will'],
  Business:['llc','business','incorporation','ein','corp','articles','operating agreement','s corp'],
};
const BTC_KINDS = ['Hardware wallet','Software wallet','Exchange account','Seed phrase backup','Passphrase / PIN hint','Inheritance instructions','Other'];
const THEMES = [
  { id:'classic', name:'Classic', sw:['#ffffff','#f3f4f6','#2563eb','#111827'] },
  { id:'light', name:'Bright', sw:['#f5f1ff','#7b3ff2','#e83e8c','#1b1450'] },
  { id:'dark', name:'Midnight', sw:['#12102a','#9b6bff','#ff5fa8','#ece8ff'] },
  { id:'retro', name:'Retro 95', sw:['#008080','#c0c0c0','#000080','#ffffff'] },
  { id:'8bit', name:'8-Bit', sw:['#0a0a18','#ff2fd0','#00e5ff','#39ff14'] },
];
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
const today = () => new Date().toISOString().slice(0, 10);
const daysUntil = (d) => Math.round((new Date(d + 'T00:00:00') - new Date(today() + 'T00:00:00')) / 864e5);
const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const fmtDate = (d) => (d ? new Date(d + 'T00:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
const fmtBtc = (sats) => (sats / 1e8).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 });
const fmtUsd = (n) => n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let db = null, S = {}, view = { name: 'home' }, query = '', btcSummary = null, toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3000); }
function setTheme(id) { document.documentElement.dataset.theme = id; try { localStorage.setItem('fv-theme', id); } catch {} }
const curTheme = () => document.documentElement.dataset.theme;

async function api(url, opts = {}) {
  const o = { method: opts.method || 'GET', headers: { 'X-FV': '1' } };
  if (opts.json !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(opts.json); }
  const r = await fetch(url, o);
  if (r.status === 423) { await boot(); throw new Error('The vault is locked.'); }
  let data = null; try { data = await r.json(); } catch {}
  if (!r.ok) throw new Error((data && data.error) || 'Something went wrong.');
  return data;
}
async function save() { const r = await api('/api/db', { method: 'PUT', json: db }); db.rev = r.rev; syncCats(); for (const f of db.files) localFiles.delete(f.id); }

// ---------- passphrase strength ----------
function strength(p) {
  if (!p) return { bits: 0, label: '', pct: 0, ok: false };
  let bits;
  const wordy = /^[A-Za-z' ]+$/.test(p) && p.includes(' ');
  if (wordy) bits = p.trim().split(/\s+/).length * 11.5;          // words from a common word list
  else {
    let pool = 0;
    if (/[a-z]/.test(p)) pool += 26; if (/[A-Z]/.test(p)) pool += 26; if (/\d/.test(p)) pool += 10; if (/[^A-Za-z0-9 ]/.test(p)) pool += 32; if (/ /.test(p)) pool += 1;
    bits = p.length * Math.log2(pool || 1) * Math.min(1, new Set(p).size / (p.length * 0.6));
    if (/(.)\1{2,}/.test(p)) bits *= 0.8;
  }
  if (/^(password|123456|qwerty|letmein|iloveyou)/i.test(p)) bits = Math.min(bits, 15);
  bits = Math.round(bits);
  const label = bits < 40 ? 'Too weak' : bits < 60 ? 'Okay' : bits < 80 ? 'Strong' : 'Excellent';
  return { bits, label, pct: Math.min(100, Math.round(bits)), ok: p.length >= 12 && bits >= 40 };
}
function meterHtml() { return `<div class="meter"><i></i></div><div class="meter-l muted"></div>`; }
function meterBind(root, input) {
  const upd = () => { const s = strength(input.value); const i = $('.meter i', root); i.style.width = s.pct + '%'; i.className = s.bits < 40 ? 'bad' : s.bits < 60 ? 'mid' : 'good'; $('.meter-l', root).textContent = input.value ? `${s.label}${input.value.length < 12 ? ' · at least 12 characters' : ''}` : 'Tip: 5 or more random words make a strong, memorable passphrase.'; };
  input.addEventListener('input', upd); upd();
}

// ---------- gate ----------
async function boot() {
  S = await api('/api/status');
  if (S.unlocked) {
    db = await api('/api/db'); syncCats();
    $('#gate').classList.add('hidden'); $('#app').classList.remove('hidden');
    render();
    if (S.upgrade && S.upgrade.running) upgradeProgress();
    return;
  }
  $('#app').classList.add('hidden');
  const g = $('#gate'); g.classList.remove('hidden');
  if (!S.initialized) {
    g.innerHTML = `<form class="box" id="gf"><img src="icon.svg" alt=""><h1>Create your vault</h1>
      <p class="muted">Choose a passphrase. Everything you store is encrypted with it, and it is never saved anywhere.
      <b>If you forget it, nobody can recover your documents</b>, so write it down and keep it somewhere safe.</p>
      <label>Passphrase (12+ characters)<input id="p1" type="password" autocomplete="new-password" required></label>
      <div id="m1">${meterHtml()}</div>
      <label>Type it again<input id="p2" type="password" autocomplete="new-password" required></label>
      <div class="err" id="ge"></div><button class="primary" style="width:100%">Create vault</button>
      <p class="muted" style="text-align:center;margin-top:14px">Already have a backup? <a href="#" id="rs">Restore it</a></p></form>`;
    meterBind($('#m1'), $('#p1'));
    $('#gf').onsubmit = async (e) => {
      e.preventDefault();
      if ($('#p1').value !== $('#p2').value) return ($('#ge').textContent = 'The two passphrases do not match.');
      if (!strength($('#p1').value).ok) return ($('#ge').textContent = 'Please choose a stronger passphrase (12+ characters, hard to guess).');
      try { await api('/api/setup', { method: 'POST', json: { passphrase: $('#p1').value } }); boot(); } catch (x) { $('#ge').textContent = x.message; }
    };
    $('#rs').onclick = (e) => {
      e.preventDefault();
      const i = document.createElement('input'); i.type = 'file'; i.accept = '.zip';
      i.onchange = async () => {
        if (!i.files[0]) return;
        $('#ge').textContent = 'Restoring… this can take a while for large backups.';
        try {
          const r = await fetch('/api/restore', { method: 'POST', body: i.files[0], headers: { 'X-FV': '1', 'Content-Type': 'application/octet-stream' } });
          const d = await r.json(); if (!r.ok) throw new Error(d.error);
          toast('Backup restored. Enter your passphrase.'); boot();
        } catch (x) { $('#ge').textContent = x.message; }
      };
      i.click();
    };
  } else {
    g.innerHTML = `<form class="box" id="gf"><img src="icon.svg" alt=""><h1>Family Vault</h1>
      <p class="muted">Enter your passphrase to unlock.</p>
      <label>Passphrase<input id="p1" type="password" autocomplete="current-password" required></label>
      <div class="err" id="ge"></div><button class="primary" style="width:100%">Unlock</button></form>`;
    $('#gf').onsubmit = async (e) => {
      e.preventDefault();
      $('#ge').textContent = 'Unlocking…';
      try { await api('/api/unlock', { method: 'POST', json: { passphrase: $('#p1').value } }); boot(); } catch (x) { $('#ge').textContent = x.message; }
    };
  }
  setTimeout(() => $('#p1') && $('#p1').focus(), 50);
}

// ---------- data helpers ----------
const person = (id) => db.people.find((p) => p.id === id);
const fileOf = (id) => db.files.find((f) => f.id === id);
const inbox = () => db.items.filter((i) => !i.reviewed);
function upcoming() {
  const out = [];
  for (const i of db.items) if (i.expires && i.reviewed !== false) out.push({ kind: 'item', id: i.id, title: i.title + ' expires', date: i.expires });
  for (const r of db.reminders) if (!r.done) out.push({ kind: 'rem', id: r.id, title: r.title, date: r.date });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
const famName = () => ((db.settings && db.settings.familyName) || '').trim() || 'Welcome home';
const dueBadge = (d) => {
  const n = daysUntil(d);
  if (n < 0) return `<span class="pill bad">${-n}d overdue</span>`;
  if (n <= 30) return `<span class="pill warn">in ${n}d</span>`;
  return `<span class="pill">${fmtDate(d)}</span>`;
};
const avatar = (p, cls = '') => `<div class="avatar ${cls}">${p.photo && fileOf(p.photo) ? `<img src="/api/files/${esc(p.photo)}" alt="">` : esc((p.name || '?')[0].toUpperCase())}</div>`;

// ---------- best guesses from a file name ----------
const norm = (s) => ' ' + s.toLowerCase().replace(/\.[a-z0-9]{2,4}$/, '').replace(/['’]s\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
function guessCategory(name) {
  const n = norm(name); let best = '', top = 0;
  for (const [c, words] of Object.entries(HINTS)) {
    let sc = 0;
    for (const w of words) if (n.includes(' ' + w + ' ') || n.includes(' ' + w + 's ')) sc += w.includes(' ') ? 3 : 2;
    if (sc > top) { best = c; top = sc; }
  }
  for (const c of CATS) { if (HINTS[c]) continue; const w = norm(c).trim(); if (w.length >= 3 && n.includes(' ' + w + ' ') && 4 > top) { best = c; top = 4; } }
  return CATS.includes(best) ? best : (CATS.includes('Family Resources') ? 'Family Resources' : CATS[0]);
}
function guessPerson(name) {
  const n = norm(name); let best = '', top = 0, tie = false;
  for (const p of db.people) {
    const full = norm(p.name).trim(); if (!full) continue;
    let sc = 0;
    if (n.includes(' ' + full + ' ')) sc = 100;
    else { const hit = full.split(' ').filter((t) => t.length >= 3 && n.includes(' ' + t + ' ')); if (hit.length) sc = 10 * hit.length + hit[0].length; }
    if (sc > top) { best = p.id; top = sc; tie = false; } else if (sc === top && sc > 0) tie = true;
  }
  return tie ? '' : best;
}
const cleanTitle = (name) => name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();

// ---------- thumbnails and previews (everything is decrypted by the server and drawn here, in memory only) ----------
const localFiles = new Map(); // files just attached but not saved yet: the server only serves files recorded in the vault
const fileUrl = (id) => (localFiles.has(id) ? (localFiles.get(id).url ||= URL.createObjectURL(localFiles.get(id).file)) : '/api/files/' + id);
const fetchFile = (id) => fetch(fileUrl(id));
let pdfLib = null;
async function pdfjs() {
  if (!pdfLib) { pdfLib = await import('/vendor/pdfjs/pdf.min.mjs'); pdfLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs'; }
  return pdfLib;
}
async function loadPdf(fid) {
  const lib = await pdfjs();
  const buf = await (await fetchFile(fid)).arrayBuffer();
  return lib.getDocument({ data: new Uint8Array(buf), standardFontDataUrl: '/vendor/pdfjs/standard_fonts/', isEvalSupported: false, enableXfa: false }).promise;
}
const isImg = (t) => /^image\/(png|jpe?g|gif|webp)$/.test(t || '');
const isPdf = (t) => t === 'application/pdf';
const thumbCache = new Map();
let thumbBusy = 0; const thumbQ = [];
function thumbPump() {
  while (thumbBusy < 2 && thumbQ.length) {
    const job = thumbQ.shift(); thumbBusy++;
    makeThumb(job.rec).then(job.done).catch(() => job.done(null)).finally(() => { thumbBusy--; thumbPump(); });
  }
}
async function makeThumb(rec) {
  const c = document.createElement('canvas');
  if (isImg(rec.type)) {
    const bmp = await createImageBitmap(await (await fetchFile(rec.id)).blob());
    const s = 200 / Math.max(bmp.width, bmp.height); c.width = Math.max(1, Math.round(bmp.width * s)); c.height = Math.max(1, Math.round(bmp.height * s));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  } else if (isPdf(rec.type)) {
    const pdf = await loadPdf(rec.id), page = await pdf.getPage(1), v0 = page.getViewport({ scale: 1 }), s = 200 / Math.max(v0.width, v0.height), v = page.getViewport({ scale: s });
    c.width = Math.round(v.width); c.height = Math.round(v.height);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: v }).promise; pdf.destroy();
  } else return null;
  return c.toDataURL('image/jpeg', 0.7);
}
let thumbObs = null;
function hydrateThumbs(root) {
  if (!thumbObs) thumbObs = new IntersectionObserver((es) => es.forEach((e) => {
    if (!e.isIntersecting) return;
    const el = e.target; thumbObs.unobserve(el);
    const rec = fileOf(el.dataset.fid); if (!rec) return;
    const put = (u) => { if (u) el.innerHTML = `<img src="${u}" alt="">`; };
    if (thumbCache.has(rec.id)) return put(thumbCache.get(rec.id));
    thumbQ.push({ rec, done: (u) => { thumbCache.set(rec.id, u); put(u); } }); thumbPump();
  }), { rootMargin: '200px' });
  root.querySelectorAll('.th[data-fid],.tile-th[data-fid]').forEach((el) => thumbObs.observe(el));
}
async function buildPreview(host, rec) {
  host.innerHTML = '';
  if (!rec) { host.innerHTML = '<div class="empty">No file attached yet.</div>'; return; }
  const url = fileUrl(rec.id);
  const bar = `<div class="pv-bar"><b>${esc(rec.name)}</b><span class="muted">${fmtSize(rec.size)}</span><span class="grow"></span><a href="${url}" target="_blank" rel="noopener">Open</a> · <a href="${url}?dl=1">Download</a></div>`;
  if (isImg(rec.type)) host.innerHTML = bar + `<div class="pv-scroll"><img class="pv-img" src="${url}" alt=""></div>`;
  else if (rec.type === 'text/plain') { host.innerHTML = bar + '<div class="pv-scroll"><pre class="pv-txt"></pre></div>'; $('.pv-txt', host).textContent = (await (await fetchFile(rec.id)).text()).slice(0, 30000); }
  else if (isPdf(rec.type)) {
    host.innerHTML = bar + '<div class="pv-scroll"><div class="pv-load muted">Loading preview…</div></div>';
    try {
      const pdf = await loadPdf(rec.id), box = $('.pv-scroll', host);
      const w = Math.max(280, box.clientWidth - 8);
      box.innerHTML = '';
      for (let n = 1; n <= Math.min(pdf.numPages, 30); n++) {
        const page = await pdf.getPage(n), v0 = page.getViewport({ scale: 1 }), v = page.getViewport({ scale: (w / v0.width) * (window.devicePixelRatio || 1) });
        const c = document.createElement('canvas'); c.className = 'pv-page'; c.width = Math.round(v.width); c.height = Math.round(v.height);
        const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        box.appendChild(c); await page.render({ canvasContext: ctx, viewport: v }).promise;
      }
      if (pdf.numPages > 30) box.insertAdjacentHTML('beforeend', `<div class="muted" style="padding:8px">Showing the first 30 of ${pdf.numPages} pages. Use Open for the full file.</div>`);
      pdf.destroy();
    } catch { $('.pv-scroll', host).innerHTML = '<div class="empty">Could not draw a preview. Use Open or Download.</div>'; }
  } else host.innerHTML = bar + '<div class="empty">No preview for this type of file. Use Download.</div>';
}

// ---------- nav / render ----------
function go(v) { view = v; $('.side').classList.remove('open'); render(); }
function renderNav() {
  const n = inbox().length, soon = upcoming().filter((u) => daysUntil(u.date) <= 30).length;
  const b = (name, ic, label, extra = '', arg) => `<button data-v="${name}" ${arg ? `data-a="${esc(arg)}"` : ''} class="${view.name === name && (!arg || view.cat === arg) ? 'on' : ''}"><span class="ic">${ic}</span><span class="lb">${label}</span>${extra}</button>`;
  $('#nav').innerHTML =
    b('home', '🏠', 'Home') + b('inbox', '📥', 'Inbox', n ? `<span class="count">${n}</span>` : '') + b('reminders', '⏰', 'Reminders', soon ? `<span class="count">${soon}</span>` : '') +
    `<div class="sep">Categories</div>` + CATS.map((c) => b('cat', CAT_ICON[c], esc(c), '', c)).join('') +
    `<div class="sep">More</div>` + b('bitcoin', '₿', 'Bitcoin') + b('contacts', '📇', 'Contacts') + b('people', '🧑‍🤝‍🧑', 'People') + b('sheet', '🚑', 'Emergency sheet') + b('settings', '⚙️', 'Settings');
  for (const el of $('#nav').querySelectorAll('button')) el.onclick = () => { const v = el.dataset.v; go(v === 'cat' ? { name: 'cat', cat: el.dataset.a } : { name: v }); };
}
function render() {
  renderNav();
  const v = $('#view');
  if (query) renderSearch(v);
  else ({ home: renderHome, inbox: renderInbox, reminders: renderReminders, cat: renderCat, kind: renderKind, contacts: renderContacts, people: renderPeople, person: renderPerson, bitcoin: renderBitcoin, sheet: renderSheet, settings: renderSettings }[view.name] || renderHome)(v);
  hydrateThumbs(v);
}

// ---------- bitcoin helpers ----------
async function loadBtc() {
  if (!db.wallets.length) { btcSummary = null; return null; }
  try { btcSummary = await api('/api/btc/summary'); } catch { btcSummary = null; }
  return btcSummary;
}
function btcTotals(s) {
  if (!s || !s.enabled) return null;
  let sats = 0, ok = 0;
  for (const w of s.wallets) if (!w.error) { sats += w.confirmed + (w.pending || 0); ok++; }
  return { sats, ok, usd: s.price ? (sats / 1e8) * s.price : null };
}

// ---------- list pieces ----------
let layout = 'tiles'; try { layout = localStorage.getItem('fv-layout') || 'tiles'; } catch {}
const layoutToggle = () => `<div class="seg"><button data-lay="tiles" class="${layout === 'tiles' ? 'on' : ''}">▦ Tiles</button><button data-lay="rows" class="${layout === 'rows' ? 'on' : ''}">☰ Rows</button></div>`;
function bindLayout(root) { root.querySelectorAll('[data-lay]').forEach((b) => (b.onclick = () => { layout = b.dataset.lay; try { localStorage.setItem('fv-layout', layout); } catch {} render(); })); }
const needsRenew = (i) => !!i.expires && daysUntil(i.expires) <= 60;
const renewBtn = (i) => (needsRenew(i) ? `<button class="small renew" data-renew="${i.id}">Renew</button>` : '');
const firstFile = (i) => (i.files || []).map(fileOf).find(Boolean);
function itemRow(i, opts = {}) {
  const p = person(i.personId), f = firstFile(i);
  const th = f && (isImg(f.type) || isPdf(f.type)) ? `<span class="th" data-fid="${esc(f.id)}">${CAT_ICON[i.category] || '📄'}</span>` : `<span class="th plain">${CAT_ICON[i.category] || '📄'}</span>`;
  return `<div class="row" data-item="${i.id}">${th}<div class="grow"><div class="t">${esc(i.title)}</div>
    <div class="s">${opts.noCat ? '' : esc(i.category)}${p && !opts.noPerson ? (opts.noCat ? '' : ' · ') + esc(p.name) : ''}${i.files && i.files.length ? ((opts.noCat && (!p || opts.noPerson)) ? '' : ' · ') + i.files.length + ' file' + (i.files.length > 1 ? 's' : '') : ''}</div></div>${i.expires ? dueBadge(i.expires) : ''}${renewBtn(i)}</div>`;
}
function itemTile(i, opts = {}) {
  const p = person(i.personId), f = firstFile(i);
  const media = f && (isImg(f.type) || isPdf(f.type)) ? `<div class="tile-th" data-fid="${esc(f.id)}">${CAT_ICON[i.category] || '📄'}</div>` : `<div class="tile-th plain">${CAT_ICON[i.category] || '📄'}</div>`;
  const sub = [opts.noCat ? '' : i.category, p && !opts.noPerson ? p.name : ''].filter(Boolean).join(' · ');
  return `<div class="tile" data-item="${i.id}">${media}<div class="tile-b"><div class="t">${esc(i.title)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ''}<div class="tile-f">${i.expires ? dueBadge(i.expires) : '<span></span>'}${renewBtn(i)}</div></div></div>`;
}
function itemList(items, opts = {}) {
  if (!items.length) return '';
  return layout === 'tiles' ? `<div class="tiles">${items.map((i) => itemTile(i, opts)).join('')}</div>` : `<div class="list">${items.map((i) => itemRow(i, opts)).join('')}</div>`;
}
function bindItems(root) {
  root.querySelectorAll('[data-item]').forEach((e) => (e.onclick = () => itemDialog(db.items.find((i) => i.id === e.dataset.item))));
  root.querySelectorAll('[data-renew]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); renewDialog(db.items.find((i) => i.id === b.dataset.renew)); }));
}
function groupHead(p, n) { return `<div class="grp">${p ? avatar(p, 'sm') : '<div class="avatar sm fam">👪</div>'}<b>${esc(p ? p.name : 'Whole family')}</b><span class="muted">${n} item${n === 1 ? '' : 's'}</span></div>`; }
function byPerson(items) {
  const groups = db.people.map((p) => [p, items.filter((i) => i.personId === p.id)]).filter(([, l]) => l.length);
  const rest = items.filter((i) => !i.personId || !person(i.personId));
  if (rest.length) groups.push([null, rest]);
  return groups.map(([p, l]) => groupHead(p, l.length) + itemList(l, { noCat: true, noPerson: true })).join('');
}

// ---------- views ----------
function renderHome(v) {
  const up = upcoming().slice(0, 5), n = inbox().length, due = upcoming().filter((u) => daysUntil(u.date) <= 30).length;
  const recent = db.items.filter((i) => i.reviewed !== false).slice().sort((a, b) => (b.created || '').localeCompare(a.created || '')).slice(0, 6);
  v.innerHTML = `<div class="head"><div><h2 class="fam-title">${esc(famName())}</h2><div class="muted">Everything here is encrypted with your passphrase.</div></div><div class="avs">${db.people.slice(0, 7).map((p) => avatar(p, 'sm')).join('')}</div></div>
    ${S.legacy ? `<div class="suggest" style="margin-bottom:14px"><div class="grow"><b>Upgrade your vault's encryption</b><div class="muted">This vault uses the older, weaker key setup. The upgrade takes a minute, keeps all your data, and makes the passphrase much harder to crack.</div></div><button class="primary" id="up1">Upgrade now</button></div>` : ''}
    <div class="stats">
      <div class="stat"><div class="n">${db.items.filter((i) => i.reviewed !== false).length}</div><div class="l">Documents</div></div>
      <div class="stat"><div class="n">${n}</div><div class="l">To review</div></div>
      <div class="stat"><div class="n">${due}</div><div class="l">Due in 30 days</div></div>
      ${db.wallets.length ? `<div class="stat btc-card" id="btc-home" style="cursor:pointer"><div class="n">₿ …</div><div class="l">Bitcoin tracked</div></div>` : ''}
    </div>
    ${n ? `<div class="suggest" style="margin-top:14px"><div class="grow"><b>${n} new file${n > 1 ? 's' : ''} to review</b><div class="muted">Check the suggested category and person, then accept.</div></div><button class="primary" id="gi">Review</button></div>` : ''}
    <div class="drop" id="drop">Drop files here or click to upload</div>
    <h3>Quick views</h3>${quickLinks()}
    <h3>Coming up</h3><div class="list">${up.length ? up.map((u) => `<div class="row"><span class="th plain">⏰</span><div class="grow"><div class="t">${esc(u.title)}</div></div>${dueBadge(u.date)}</div>`).join('') : '<div class="empty">Nothing due. Add an expiry date to a document or create a reminder.</div>'}</div>
    <h3>People</h3><div class="cards">${db.people.map(personCard).join('')}<div class="card" id="addp" style="display:flex;align-items:center;justify-content:center;color:var(--mute)">+ Add a person</div></div>
    <h3>Recently added</h3><div class="list">${recent.length ? recent.map((i) => itemRow(i)).join('') : '<div class="empty">No documents yet.</div>'}</div>`;
  if ($('#gi')) $('#gi').onclick = () => go({ name: 'inbox' });
  if ($('#up1')) $('#up1').onclick = upgradeDialog;
  $('#addp').onclick = () => personDialog();
  bindPersonCards(v); bindItems(v); bindQuick(v); bindDrop($('#drop'));
  if (db.wallets.length) {
    $('#btc-home').onclick = () => go({ name: 'bitcoin' });
    loadBtc().then((s) => {
      const el = $('#btc-home'); if (!el || view.name !== 'home') return;
      const t = btcTotals(s);
      el.innerHTML = t ? `<div class="n">₿ ${fmtBtc(t.sats)}</div><div class="l">${t.usd != null ? fmtUsd(t.usd) + ' · ' : ''}${t.ok} wallet${t.ok === 1 ? '' : 's'}</div>` : `<div class="n">₿ —</div><div class="l">${s && !s.enabled ? 'Lookups are off' : 'Lookup unavailable'}</div>`;
    });
  }
}
const quickLinks = () => `<div class="qv"><span class="muted">Quick views:</span>${KINDS.map((k) => `<button class="chip-btn" data-kind="${k.id}">${k.icon} ${esc(k.label)} <span class="count2">${db.items.filter((i) => i.reviewed !== false && docKind(i) === k.id).length}</span></button>`).join('')}</div>`;
function bindQuick(root) { root.querySelectorAll('[data-kind]').forEach((b) => (b.onclick = () => go({ name: 'kind', kind: b.dataset.kind }))); }
const personCard = (p) => `<div class="card" data-person="${p.id}">${avatar(p)}<div class="t">${esc(p.name)}</div><div class="muted">${db.items.filter((i) => i.personId === p.id).length} items</div></div>`;
function bindPersonCards(r) { r.querySelectorAll('[data-person]').forEach((e) => (e.onclick = () => go({ name: 'person', id: e.dataset.person }))); }

function renderCat(v) {
  const items = db.items.filter((i) => i.category === view.cat && i.reviewed !== false);
  v.innerHTML = `<div class="head"><h2>${CAT_ICON[view.cat]} ${esc(view.cat)}</h2><div class="hbtns">${layoutToggle()}<button class="primary" id="a">+ Add to ${esc(view.cat)}</button></div></div>
    <div class="muted">${view.cat === 'Passwords' ? 'Logins are stored inside the encrypted vault. ' : ''}Grouped by family member.</div>
    ${view.cat === 'Family' ? quickLinks() : ''}
    <div class="drop" id="drop" style="margin-top:12px">Drop files here to add to ${esc(view.cat)}</div>
    ${items.length ? byPerson(items) : '<div class="list"><div class="empty">Nothing here yet.</div></div>'}`;
  $('#a').onclick = () => itemDialog(null, { category: view.cat });
  bindItems(v); bindLayout(v); bindQuick(v); bindDrop($('#drop'), { cat: view.cat });
}

function renderKind(v) {
  const k = KINDS.find((x) => x.id === view.kind); if (!k) return go({ name: 'home' });
  const items = db.items.filter((i) => i.reviewed !== false && docKind(i) === k.id).sort((a, b) => db.people.findIndex((p) => p.id === a.personId) - db.people.findIndex((p) => p.id === b.personId));
  const missing = db.people.filter((p) => !items.some((i) => i.personId === p.id));
  v.innerHTML = `<div class="head"><div><h2>${k.icon} ${esc(k.label)}s</h2><div class="muted">Everyone's ${esc(k.label.toLowerCase())} in one place. <a href="#" id="back">Back to Family</a></div></div>${layoutToggle()}</div>
    ${quickLinks()}
    ${items.length ? itemList(items, { noCat: true }) : '<div class="list"><div class="empty">None filed yet.</div></div>'}
    ${missing.length ? `<h3>Not on file yet</h3><div class="tiles">${missing.map((p) => `<div class="tile miss" data-miss="${p.id}"><div class="tile-th plain">${avatar(p)}</div><div class="tile-b"><div class="t">${esc(p.name)}</div><div class="s">No ${esc(k.label)} yet</div><div class="tile-f"><span></span><button class="small">+ Add</button></div></div></div>`).join('')}</div>` : ''}`;
  $('#back').onclick = (e) => { e.preventDefault(); go({ name: 'cat', cat: 'Family' }); };
  v.querySelectorAll('[data-miss]').forEach((e) => (e.onclick = () => itemDialog(null, { category: 'Family', personId: e.dataset.miss, title: `${person(e.dataset.miss).name}'s ${k.label}` })));
  bindItems(v); bindLayout(v); bindQuick(v);
}

function renderInbox(v) {
  const items = inbox();
  v.innerHTML = `<div class="head"><div><h2>📥 Inbox</h2><div class="muted">New uploads wait here. The category and person are best guesses from the file name, so fix any that are wrong.</div></div>${items.length > 1 ? '<button class="primary" id="all">Accept all</button>' : ''}</div>
    <div class="drop" id="drop">Drop files here or click to upload</div>
    ${items.length ? items.map((i) => { const f = (i.files || []).map(fileOf).find(Boolean);
      return `<div class="suggest inb" data-id="${i.id}">${f && (isImg(f.type) || isPdf(f.type)) ? `<span class="th" data-fid="${esc(f.id)}">📄</span>` : '<span class="th plain">📄</span>'}
        <div class="grow"><b>${esc(i.title)}</b><div class="muted">${f ? fmtSize(f.size) : ''}</div>
        <div class="inb-sel"><select class="ic-cat">${opts(CATS.map((c) => [c, c]), i.category)}</select><select class="ic-who">${opts([['', 'Whole family'], ...db.people.map((p) => [p.id, p.name])], i.personId)}</select></div></div>
        <button class="primary acc">Accept</button><button class="rev">Review</button></div>`; }).join('') : '<div class="empty">Inbox is empty.</div>'}`;
  bindDrop($('#drop'));
  v.querySelectorAll('.suggest').forEach((el) => {
    const it = db.items.find((i) => i.id === el.dataset.id);
    el.querySelector('.ic-cat').onchange = (e) => { it.category = e.target.value; };
    el.querySelector('.ic-who').onchange = (e) => { it.personId = e.target.value; };
    el.querySelector('.acc').onclick = async () => { it.reviewed = true; await save(); render(); };
    el.querySelector('.rev').onclick = () => itemDialog(it);
  });
  if ($('#all')) $('#all').onclick = async () => { items.forEach((i) => (i.reviewed = true)); await save(); render(); };
}

function remTile(u) {
  if (u.kind === 'item') return itemTile(db.items.find((i) => i.id === u.id), {});
  return `<div class="tile rem" data-rid="${u.id}"><div class="tile-th plain">⏰</div><div class="tile-b"><div class="t">${esc(u.title)}</div><div class="s">Reminder</div><div class="tile-f">${dueBadge(u.date)}<button class="small chk">Done</button></div></div></div>`;
}
function remRow(u) {
  if (u.kind === 'item') return itemRow(db.items.find((i) => i.id === u.id), {});
  return `<div class="row" data-rid="${u.id}"><span class="th plain">⏰</span><div class="grow"><div class="t">${esc(u.title)}</div><div class="s">Reminder</div></div>${dueBadge(u.date)}<button class="small chk">Done</button></div>`;
}
function renderReminders(v) {
  const up = upcoming(), done = db.reminders.filter((r) => r.done);
  const buckets = [['Overdue', (u) => daysUntil(u.date) < 0], ['Next 30 days', (u) => daysUntil(u.date) >= 0 && daysUntil(u.date) <= 30], ['Later', (u) => daysUntil(u.date) > 30]];
  v.innerHTML = `<div class="head"><h2>⏰ Reminders</h2><div class="hbtns">${layoutToggle()}<button class="primary" id="a">+ New reminder</button></div></div>
    ${up.length ? buckets.map(([name, fn]) => { const l = up.filter(fn); return l.length ? `<div class="grp"><b>${name}</b><span class="muted">${l.length}</span></div>${layout === 'tiles' ? `<div class="tiles">${l.map(remTile).join('')}</div>` : `<div class="list">${l.map(remRow).join('')}</div>`}` : ''; }).join('') : '<div class="list"><div class="empty">No reminders.</div></div>'}
    <p class="muted" style="font-size:.85em">Want a phone alert? Set up ntfy notifications in Settings.</p>
    ${done.length ? `<h3>Done</h3><div class="list">${done.map((r) => `<div class="row"><div class="grow s">${esc(r.title)} · ${fmtDate(r.date)}</div><button class="small danger del" data-id="${r.id}">Delete</button></div>`).join('')}</div>` : ''}`;
  $('#a').onclick = reminderDialog; bindItems(v); bindLayout(v);
  v.querySelectorAll('[data-rid]').forEach((el) => { const c = el.querySelector('.chk'); if (c) c.onclick = async () => { db.reminders.find((r) => r.id === el.dataset.rid).done = true; await save(); render(); }; });
  v.querySelectorAll('.del').forEach((b) => (b.onclick = async () => { db.reminders = db.reminders.filter((r) => r.id !== b.dataset.id); await save(); render(); }));
}

const contactRow = (c) => `<div class="row" data-c="${c.id}"><span class="th plain">📇</span><div class="grow"><div class="t">${esc(c.name)}</div><div class="s">${esc([c.role, c.phone, c.email].filter(Boolean).join(' · '))}</div></div></div>`;
function renderContacts(v) {
  v.innerHTML = `<div class="head"><h2>📇 Contacts</h2><button class="primary" id="a">+ Add contact</button></div>
    <div class="muted">Doctors, lawyers, accountants, agents: the people you call when it matters.</div><div class="list" style="margin-top:12px">${db.contacts.length ? db.contacts.slice().sort((a, b) => a.name.localeCompare(b.name)).map(contactRow).join('') : '<div class="empty">No contacts yet.</div>'}</div>`;
  $('#a').onclick = () => contactDialog();
  v.querySelectorAll('[data-c]').forEach((e) => (e.onclick = () => contactDialog(db.contacts.find((c) => c.id === e.dataset.c))));
}

function renderPeople(v) {
  v.innerHTML = `<div class="head"><h2>🧑‍🤝‍🧑 People</h2><button class="primary" id="a">+ Add person</button></div>
    <div class="cards" style="margin-top:12px">${db.people.map(personCard).join('') || '<div class="empty">Add the family members whose documents you keep here.</div>'}</div>`;
  $('#a').onclick = () => personDialog(); bindPersonCards(v);
}
function renderPerson(v) {
  const p = person(view.id); if (!p) return go({ name: 'people' });
  const items = db.items.filter((i) => i.personId === p.id && i.reviewed !== false);
  const groups = CATS.map((c) => [c, items.filter((i) => i.category === c)]).filter(([, l]) => l.length);
  v.innerHTML = `<div class="head"><div class="hero">${avatar(p, 'lg')}<div><h2>${esc(p.name)}</h2><div class="muted">${p.birthday ? 'Born ' + fmtDate(p.birthday) : ''}${p.birthday && p.note ? ' · ' : ''}${esc(p.note || '')}</div></div></div><div class="hbtns">${layoutToggle()}<button id="e">Edit</button> <button class="primary" id="a">+ Add document</button></div></div>
    <div class="drop" id="drop" style="margin-top:14px">Drop files here to add them for ${esc(p.name)}</div>
    ${groups.length ? groups.map(([c, l]) => `<div class="grp"><span class="ic">${CAT_ICON[c]}</span><b>${esc(c)}</b><span class="muted">${l.length}</span></div>${itemList(l, { noCat: true, noPerson: true })}`).join('') : `<div class="list"><div class="empty">No documents filed for ${esc(p.name)} yet.</div></div>`}`;
  $('#e').onclick = () => personDialog(p); $('#a').onclick = () => itemDialog(null, { personId: p.id });
  bindItems(v); bindLayout(v); bindDrop($('#drop'), { personId: p.id });
}

function walletBalanceCell(w, r, s) {
  if (!r) return '';
  if (r.error) return `<span class="pill bad" title="${esc(r.error)}">error</span>`;
  const used = r.txCount > 0;
  return `<b>₿ ${fmtBtc(r.confirmed)}</b>${r.pending ? ' <span class="pill warn">pending</span>' : ''}${s.price ? `<div class="s">${fmtUsd((r.confirmed / 1e8) * s.price)}</div>` : ''}<div class="s">${used ? `${r.txCount} transaction${r.txCount === 1 ? '' : 's'}${!w.xpub && r.confirmed === 0 ? ' · emptied' : ''}` : 'never used'}${w.xpub ? ` · ${r.scanned} addresses checked` : ''}</div>`;
}
function renderBitcoin(v) {
  const wallets = db.wallets, notes = db.bitcoin, st = db.settings || {};
  v.innerHTML = `<div class="head"><div><h2>₿ Bitcoin</h2><div class="muted">Where your Bitcoin is, how to get to it, and a live view of the wallets you track.</div></div></div>
    <h3>Wallet tracker</h3>
    <div class="stats" id="btc-stats"><div class="stat btc-card"><div class="n">…</div><div class="l">Total</div></div></div>
    <div class="list" style="margin-top:14px">${wallets.length ? wallets.map((w) => `<div class="row" data-w="${w.id}"><span class="th plain">₿</span><div class="grow"><div class="t">${esc(w.label || 'Wallet')}${w.personId && person(w.personId) ? ' · ' + esc(person(w.personId).name) : ''} <span class="pill">${w.xpub ? 'wallet key' : 'single address'}</span></div><div class="s addr">${esc(w.xpub || w.address)}</div></div><div class="bal" data-bal="${w.id}">…</div></div>`).join('') : '<div class="empty">No wallets tracked yet.</div>'}</div>
    <div class="btns" style="justify-content:flex-start"><button class="primary" id="aw">+ Track a wallet</button></div>
    <div class="suggest"><div class="grow"><b>Why does a wallet show 0?</b><div class="muted">A single address is just one of hundreds a wallet creates, and wallets move coins to fresh addresses as you spend. To see a whole wallet's balance, track its <b>wallet key</b> (xpub, ypub or zpub, found in the wallet's “export / public key” screen). Custodial accounts like Cash App and multisig vaults can't be tracked from a single key.</div></div></div>
    <p class="muted" style="font-size:.85em">${st.btcLookups === false ? 'Live lookups are turned off in Settings.' : `Only public keys and addresses are looked up, using <b>${esc((st.btcApi || '').replace(/^https?:\/\//, ''))}</b>. A wallet key lets that server see all of the wallet's addresses, so for real privacy point this at your own Mempool node in Settings. Never enter seed phrases or private keys here.`}</p>
    <h3>Where everything is</h3>
    <div class="suggest"><div class="grow"><b>Write down where things are, not the secrets themselves.</b><div class="muted">For example: “Ledger is in the gun safe, seed card in the safe-deposit box at First Bank, PIN hint in the Passwords category.” Add instructions your family could follow if you were not around.</div></div></div>
    <div class="list">${notes.length ? notes.map((n) => `<div class="row" data-n="${n.id}"><span class="th plain">🗝️</span><div class="grow"><div class="t">${esc(n.title)}</div><div class="s">${esc(n.kind)}${n.location ? ' · ' + esc(n.location) : ''}</div></div></div>`).join('') : '<div class="empty">Nothing recorded yet.</div>'}</div>
    <div class="btns" style="justify-content:flex-start"><button class="primary" id="an">+ Add instructions</button></div>`;
  $('#aw').onclick = () => walletDialog(); $('#an').onclick = () => noteDialog();
  v.querySelectorAll('[data-w]').forEach((e) => (e.onclick = () => walletDialog(db.wallets.find((w) => w.id === e.dataset.w))));
  v.querySelectorAll('[data-n]').forEach((e) => (e.onclick = () => noteDialog(db.bitcoin.find((n) => n.id === e.dataset.n))));
  const fill = (s) => {
    if (view.name !== 'bitcoin' || !$('#btc-stats')) return;
    const t = btcTotals(s);
    $('#btc-stats').innerHTML = !wallets.length ? '' : t
      ? `<div class="stat btc-card"><div class="n">₿ ${fmtBtc(t.sats)}</div><div class="l">Total balance</div></div>${t.usd != null ? `<div class="stat"><div class="n">${fmtUsd(t.usd)}</div><div class="l">Value (USD)</div></div><div class="stat"><div class="n">${fmtUsd(s.price)}</div><div class="l">Price of 1 BTC</div></div>` : ''}`
      : `<div class="stat"><div class="n">—</div><div class="l">${s && !s.enabled ? 'Lookups are off' : 'Lookup unavailable'}</div></div>`;
    for (const w of wallets) { const el = v.querySelector(`[data-bal="${w.id}"]`); if (el) el.innerHTML = walletBalanceCell(w, s && s.wallets && s.wallets.find((x) => x.id === w.id), s || {}); }
  };
  if (wallets.length) { loadBtc().then(fill); const el = $('#btc-stats'); if (el) el.insertAdjacentHTML('afterend', '<div class="muted" style="font-size:.85em">Scanning wallet keys can take a few seconds.</div>'); } else fill(null);
}

function renderSheet(v) {
  const people = db.people, cons = db.contacts, docs = db.items.filter((i) => i.reviewed !== false && i.category !== 'Passwords');
  const byCat = CATS.filter((c) => c !== 'Passwords').map((c) => [c, docs.filter((i) => i.category === c)]).filter(([, l]) => l.length);
  v.innerHTML = `<div class="head noprint"><div><h2>🚑 Emergency sheet</h2><div class="muted">One printable page for the people who would need to step in. It lists what exists and where, never passwords.</div></div><button class="primary" id="pr">Print / save as PDF</button></div>
  <div class="sheet-box"><h2>Family emergency sheet</h2><div>Prepared ${fmtDate(today())}. Keep this somewhere safe: it describes where important things are.</div>
    <h3>How to open the Family Vault</h3><div>Located on our home server (Umbrel). The vault passphrase is kept at:</div><div class="line"></div><div>People who know how to access it:</div><div class="line"></div>
    <h3>Family</h3>${people.length ? `<table>${people.map((p) => `<tr><td><b>${esc(p.name)}</b></td><td>${p.birthday ? fmtDate(p.birthday) : ''}</td><td>${esc(p.note || '')}</td></tr>`).join('')}</table>` : '<div class="muted">No people added.</div>'}
    <h3>Who to call</h3>${cons.length ? `<table>${cons.map((c) => `<tr><td><b>${esc(c.name)}</b></td><td>${esc(c.role || '')}</td><td>${esc(c.phone || '')}</td><td>${esc(c.email || '')}</td></tr>`).join('')}</table>` : '<div class="muted">No contacts added.</div>'}
    <h3>Documents on file</h3>${byCat.length ? byCat.map(([c, l]) => `<div><b>${esc(c)}:</b> ${l.map((i) => esc(i.title)).join(', ')}</div>`).join('') : '<div class="muted">No documents yet.</div>'}
    <h3>Bitcoin</h3>${db.bitcoin.length ? db.bitcoin.map((n) => `<div style="margin-bottom:8px"><b>${esc(n.title)}</b> (${esc(n.kind)})${n.location ? '<br>Where: ' + esc(n.location) : ''}${n.notes ? '<br>' + esc(n.notes).replace(/\n/g, '<br>') : ''}</div>`).join('') : '<div class="muted">Nothing recorded.</div>'}
    ${db.wallets.length ? `<div style="margin-top:8px"><b>Tracked wallets</b></div><table>${db.wallets.map((w) => `<tr><td>${esc(w.label || '')}</td><td style="word-break:break-all">${esc(w.xpub || w.address)}</td></tr>`).join('')}</table>` : ''}
    <h3>Other notes</h3><div class="line"></div><div class="line"></div><div class="line"></div></div>`;
  $('#pr').onclick = () => window.print();
}

function renderSearch(v) {
  const q = query.toLowerCase();
  const hit = (...s) => s.some((x) => String(x || '').toLowerCase().includes(q));
  const items = db.items.filter((i) => hit(i.title, i.notes, i.category, i.username, i.url, (person(i.personId) || {}).name, (i.files || []).map((f) => (fileOf(f) || {}).name).join(' ')));
  const ppl = db.people.filter((p) => hit(p.name, p.note));
  const cons = db.contacts.filter((c) => hit(c.name, c.role, c.email, c.phone, c.notes));
  const btc = db.bitcoin.filter((n) => hit(n.title, n.kind, n.location, n.notes));
  const wal = db.wallets.filter((w) => hit(w.label, w.address, w.xpub, w.notes));
  v.innerHTML = `<h2>Results for “${esc(query)}”</h2>
    ${ppl.length ? `<h3>People</h3><div class="cards">${ppl.map(personCard).join('')}</div>` : ''}
    <h3>Documents</h3><div class="list">${items.length ? items.map((i) => itemRow(i)).join('') : '<div class="empty">No matching documents.</div>'}</div>
    ${cons.length ? `<h3>Contacts</h3><div class="list">${cons.map(contactRow).join('')}</div>` : ''}
    ${btc.length || wal.length ? `<h3>Bitcoin</h3><div class="list">${btc.map((n) => `<div class="row" data-n="${n.id}"><span class="th plain">🗝️</span><div class="grow"><div class="t">${esc(n.title)}</div><div class="s">${esc(n.kind)}</div></div></div>`).join('')}${wal.map((w) => `<div class="row" data-w="${w.id}"><span class="th plain">₿</span><div class="grow"><div class="t">${esc(w.label)}</div><div class="s addr">${esc(w.xpub || w.address)}</div></div></div>`).join('')}</div>` : ''}`;
  bindItems(v); bindPersonCards(v);
  v.querySelectorAll('[data-c]').forEach((e) => (e.onclick = () => contactDialog(db.contacts.find((c) => c.id === e.dataset.c))));
  v.querySelectorAll('[data-n]').forEach((e) => (e.onclick = () => noteDialog(db.bitcoin.find((n) => n.id === e.dataset.n))));
  v.querySelectorAll('[data-w]').forEach((e) => (e.onclick = () => walletDialog(db.wallets.find((w) => w.id === e.dataset.w))));
}

async function renderSettings(v) {
  const st = db.settings;
  let nt = {}; try { nt = await api('/api/ntfy'); } catch {}
  S = await api('/api/status').catch(() => S);
  if (view.name !== 'settings') return;
  v.innerHTML = `<h2>⚙️ Settings</h2>
  <h3>Theme</h3><div class="list"><div class="themes">${THEMES.map((t) => `<button class="theme-opt ${curTheme() === t.id ? 'on' : ''}" data-t="${t.id}"><div class="sw">${t.sw.map((c) => `<i style="background:${c}"></i>`).join('')}</div><div class="nm">${t.name}</div></button>`).join('')}</div></div>
  <h3>Family</h3><div class="list"><div class="row" style="cursor:default;display:block"><label style="margin:0">Family name (shown on the home page)<input id="fn" maxlength="60" value="${esc(st.familyName || '')}" placeholder="e.g. Gump Family"></label><div class="btns"><button id="fns">Save</button></div></div></div>
  <h3>Categories</h3><div class="list" id="catlist">${CATS.map((c) => `<div class="row" style="cursor:default"><span class="th plain">${esc(CAT_ICON[c])}</span><div class="grow"><div class="t">${esc(c)}</div><div class="s">${db.items.filter((i) => i.category === c).length} items</div></div>${PROTECTED_CATS.includes(c) ? '<span class="pill">built in</span>' : `<button class="small" data-ren="${esc(c)}">Rename</button><button class="small danger" data-delc="${esc(c)}">Delete</button>`}</div>`).join('')}
    <div class="row" id="addcat"><span class="th plain">➕</span><div class="grow"><div class="t">Add a category</div><div class="s">For anything that doesn't fit the built-in ones, e.g. Medical, Pets, School.</div></div></div></div>
  <h3>Security</h3><div class="list"><div class="row" style="cursor:default"><div class="grow"><div class="t">Auto-lock</div><div class="s">Lock this browser after this much inactivity.</div></div>
    <select id="al" style="width:auto"><option value="5">5 minutes</option><option value="15">15 minutes</option><option value="30">30 minutes</option><option value="60">1 hour</option><option value="240">4 hours</option><option value="0">Never</option></select></div>
    ${S.legacy ? `<div class="row" id="up2"><span class="th plain">⬆️</span><div class="grow"><div class="t">Upgrade encryption (recommended)</div><div class="s">Moves this vault to the stronger key setup. Keeps all your data.</div></div></div>`
      : `<div class="row" id="cp"><span class="th plain">🔑</span><div class="grow"><div class="t">Change passphrase</div><div class="s">Instant, and your files stay safe.</div></div></div>`}</div>
  <h3>Alerts (ntfy)</h3><div class="list" id="ntfy"><div class="row" style="cursor:default;display:block">
    <label class="inl"><input type="checkbox" id="n-on" ${nt.enabled ? 'checked' : ''} style="width:auto"> Send me phone alerts for expiring documents and reminders</label>
    <div class="grid2"><label>ntfy server<input id="n-srv" value="${esc(nt.server || 'https://ntfy.sh')}"></label>
    <label>Topic <a href="#" id="n-gen" style="float:right">generate a private one</a><input id="n-top" class="secret" value="${esc(nt.topic || '')}" placeholder="fv-… (keep it secret)" autocomplete="off"></label>
    <label>Access token (optional) ${nt.tokenSet ? '<span class="pill">saved</span>' : ''}<input id="n-tok" type="password" placeholder="${nt.tokenSet ? 'leave blank to keep the saved token' : 'only for private servers'}" autocomplete="off"></label>
    <label>Send at<select id="n-hr">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === (nt.hour ?? 8) ? 'selected' : ''}>${h === 0 ? '12 am' : h < 12 ? h + ' am' : h === 12 ? '12 pm' : h - 12 + ' pm'}</option>`).join('')}</select></label></div>
    <div class="s" style="margin:4px 0 8px">Alert me this many days before:</div>
    <div class="chips" id="n-days">${[30, 14, 7, 3, 1, 0].map((d) => `<label class="chip"><input type="checkbox" value="${d}" ${(nt.days || [30, 7, 1, 0]).includes(d) ? 'checked' : ''}> ${d === 0 ? 'the day' : d + 'd'}</label>`).join('')}</div>
    <label class="inl" style="margin-top:10px"><input type="checkbox" id="n-ttl" ${nt.includeTitles ? 'checked' : ''} style="width:auto"> Include document titles in the alert (otherwise it just says “A document is expiring”)</label>
    <div class="s" style="margin-top:8px">Alerts are sent by your Umbrel even while the vault is locked. To make that possible, a small schedule (dates, plus titles only if ticked) is kept <b>unencrypted</b> on your Umbrel. Anyone who knows your topic name can read your alerts on a public ntfy server, so keep the topic secret or use your own ntfy server. To receive them, install the ntfy app and subscribe to the same topic.</div>
    <div class="btns"><button id="n-test">Send test</button><button class="primary" id="n-save">Save alerts</button></div></div></div>
  <h3>Bitcoin lookups</h3><div class="list"><div class="row" style="cursor:default"><div class="grow"><div class="t">Look up balances of tracked wallets</div><div class="s">Sends only the public addresses and keys you track, never anything else.</div></div><input type="checkbox" id="bl" style="width:auto" ${st.btcLookups !== false ? 'checked' : ''}></div>
    <div class="row" style="cursor:default;display:block"><label style="margin:0">Mempool API address<input id="ba" value="${esc(st.btcApi)}"></label><div class="s">Default is the public mempool.space. For full privacy, use your own Mempool node (an Umbrel app), e.g. <span class="addr">http://umbrel.local:3006/api</span>.</div><div class="btns"><button id="bs">Save</button></div></div></div>
  <h3>Backup</h3><div class="list"><div class="row" style="cursor:default"><div class="grow"><div class="t">Download encrypted backup</div><div class="s">A ZIP of your encrypted vault. Useless without your passphrase, so keep copies somewhere other than this Umbrel. To restore, choose “Restore” on the setup screen of a fresh install.</div></div><a href="/api/backup"><button>Download</button></a></div></div>
  <h3>About</h3><p class="muted">Family Vault ${esc(S.version || '')} keeps everything on your own Umbrel, encrypted with AES-256-GCM. A random master key encrypts your data, and that key is locked by your passphrase (scrypt). Free and open source (MIT). Not independently audited.</p>`;
  v.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => { setTheme(b.dataset.t); renderSettings(v); }));
  $('#al').value = String(S.autoLockMin);
  $('#al').onchange = async () => { try { await api('/api/settings', { method: 'POST', json: { autoLockMin: +$('#al').value } }); toast('Saved'); } catch (e) { toast(e.message); } };
  const saveBtc = async () => { db.settings = { ...db.settings, btcLookups: $('#bl').checked, btcApi: $('#ba').value.trim() || 'https://mempool.space/api' }; try { await save(); db = await api('/api/db'); syncCats(); toast('Saved'); } catch (e) { toast(e.message); } };
  $('#addcat').onclick = () => categoryDialog();
  v.querySelectorAll('[data-ren]').forEach((b) => (b.onclick = () => categoryDialog(b.dataset.ren)));
  v.querySelectorAll('[data-delc]').forEach((b) => (b.onclick = () => deleteCategoryDialog(b.dataset.delc)));
  $('#fns').onclick = async () => { db.settings = { ...db.settings, familyName: $('#fn').value.trim() }; try { await save(); db = await api('/api/db'); toast('Saved'); } catch (e) { toast(e.message); } };
  $('#bs').onclick = saveBtc; $('#bl').onchange = saveBtc;
  if ($('#up2')) $('#up2').onclick = upgradeDialog;
  if ($('#cp')) $('#cp').onclick = changePassDialog;
  $('#n-gen').onclick = (e) => { e.preventDefault(); const a = new Uint8Array(12); crypto.getRandomValues(a); $('#n-top').value = 'fv-' + [...a].map((x) => x.toString(36).padStart(2, '0')).join('').slice(0, 20); };
  const ntBody = () => ({ enabled: $('#n-on').checked, server: $('#n-srv').value.trim(), topic: $('#n-top').value.trim(), token: $('#n-tok').value, hour: +$('#n-hr').value, tz: -new Date().getTimezoneOffset(), days: [...document.querySelectorAll('#n-days input:checked')].map((i) => +i.value), includeTitles: $('#n-ttl').checked });
  $('#n-save').onclick = async () => { try { await api('/api/ntfy', { method: 'PUT', json: ntBody() }); toast('Alert settings saved'); renderSettings(v); } catch (e) { toast(e.message); } };
  $('#n-test').onclick = async () => { try { await api('/api/ntfy', { method: 'PUT', json: ntBody() }); await api('/api/ntfy/test', { method: 'POST' }); toast('Test sent. Check your phone.'); } catch (e) { toast(e.message); } };
}

// ---------- dialogs ----------
function dialog(html, bind, wide) {
  const d = $('#dlg'); d.className = wide ? 'wide' : ''; d.innerHTML = `<div class="dlg">${html}</div>`;
  d.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => d.close()));
  if (!d.open) d.showModal();
  bind && bind(d);
  return d;
}
const opts = (list, sel) => list.map(([v, l]) => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(l)}</option>`).join('');
function genPassword(n = 20) {
  const set = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*-_=+';
  const a = new Uint32Array(n); crypto.getRandomValues(a);
  return [...a].map((x) => set[x % set.length]).join('');
}

async function saveCats(list, mutate) {
  const prev = db.settings.categories, prevItems = db.items.map((i) => i.category);
  db.settings = { ...db.settings, categories: list };
  if (mutate) mutate();
  try { await save(); } catch (e) { db.settings.categories = prev; db.items.forEach((i, n) => (i.category = prevItems[n])); syncCats(); throw e; }
}
const catObjs = () => CATS.map((name) => ({ name, icon: CAT_ICON[name] }));
function categoryDialog(name) {
  const cur = name ? { name, icon: CAT_ICON[name] } : { name: '', icon: '📁' };
  dialog(`<h2>${name ? 'Rename category' : 'Add a category'}</h2><form id="f"><div class="grid2"><label>Name<input id="n" value="${esc(cur.name)}" required maxlength="30" placeholder="Medical, School, Pets…"></label><label>Icon (emoji)<input id="i" value="${esc(cur.icon)}" maxlength="4"></label></div><div class="err muted" id="e"></div><div class="btns"><button type="button" class="ghost" data-close>Cancel</button><button class="primary">Save</button></div></form>`, (d) => {
    $('#f', d).onsubmit = async (e) => {
      e.preventDefault();
      const n = $('#n', d).value.trim(), icon = $('#i', d).value.trim() || '📁';
      if (CATS.some((c) => c.toLowerCase() === n.toLowerCase() && c !== name)) return ($('#e', d).textContent = 'You already have a category with that name.');
      const list = catObjs();
      try {
        if (name) { const c = list.find((x) => x.name === name); c.name = n; c.icon = icon; await saveCats(list, () => db.items.forEach((i) => { if (i.category === name) i.category = n; })); if (view.name === 'cat' && view.cat === name) view.cat = n; }
        else { list.push({ name: n, icon }); await saveCats(list); }
        d.close(); render();
      } catch (x) { $('#e', d).textContent = x.message; }
    };
  });
}
function deleteCategoryDialog(name) {
  const count = db.items.filter((i) => i.category === name).length, others = CATS.filter((c) => c !== name);
  dialog(`<h2>Delete “${esc(name)}”?</h2><form id="f">${count ? `<p class="muted">${count} document${count > 1 ? 's are' : ' is'} in this category. Choose where to move ${count > 1 ? 'them' : 'it'}. Nothing is deleted.</p><label>Move to<select id="to">${opts(others.map((c) => [c, c]), others.includes('Family Resources') ? 'Family Resources' : others[0])}</select></label>` : '<p class="muted">This category is empty.</p>'}
    <div class="err muted" id="e"></div><div class="btns"><button type="button" class="ghost" data-close>Cancel</button><button class="primary danger">Delete category</button></div></form>`, (d) => {
    $('#f', d).onsubmit = async (e) => {
      e.preventDefault();
      const to = count ? $('#to', d).value : '';
      try { await saveCats(catObjs().filter((c) => c.name !== name), () => db.items.forEach((i) => { if (i.category === name) i.category = to; })); if (view.name === 'cat' && view.cat === name) view = { name: 'home' }; d.close(); render(); }
      catch (x) { $('#e', d).textContent = x.message; }
    };
  });
}

function renewDialog(it) {
  let file = null;
  dialog(`<h2>Renew</h2><p class="muted"><b>${esc(it.title)}</b>${it.expires ? ` · ${daysUntil(it.expires) < 0 ? 'expired' : 'expires'} ${fmtDate(it.expires)}` : ''}</p>
    <form id="f"><label>New expiry date<input id="d" type="date" required min="${today()}"></label>
    <label>Replacement document or photo <span class="muted">(optional)</span></label>
    <div class="drop" id="pick" style="margin:0 0 10px">Choose a file or take a photo</div><div id="pk" class="muted" style="margin-bottom:8px"></div>
    <label class="inl"><input type="checkbox" id="rm" style="width:auto"> Remove the old file${(it.files || []).length > 1 ? 's' : ''} (otherwise ${(it.files || []).length > 1 ? 'they' : 'it'} stay attached)</label>
    <div class="err muted" id="e"></div><div class="btns"><button type="button" class="ghost" data-close>Cancel</button><button class="primary">Save renewal</button></div></form>`, (d) => {
    const pick = () => { const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*,application/pdf'; i.onchange = () => { if (i.files[0]) { file = i.files[0]; $('#pk', d).textContent = `Selected: ${file.name} (${fmtSize(file.size)})`; } }; i.click(); };
    $('#pick', d).onclick = pick;
    $('#f', d).onsubmit = async (e) => {
      e.preventDefault();
      const btn = $('#f .primary', d); btn.disabled = true; $('#e', d).textContent = file ? 'Encrypting the new file…' : '';
      try {
        let rec = null;
        if (file) { rec = await uploadOne(file); if (!rec) { btn.disabled = false; $('#e', d).textContent = 'The upload failed. Try again.'; return; } }
        const old = it.files || [];
        if (rec) { db.files.push(rec); it.files = [rec.id, ...(d.querySelector('#rm').checked ? [] : old)]; if (d.querySelector('#rm').checked) db.files = db.files.filter((f) => !old.includes(f.id) || f.id === rec.id); }
        it.expires = $('#d', d).value; it.reviewed = true;
        await save(); d.close(); render(); toast('Renewed');
      } catch (x) { btn.disabled = false; $('#e', d).textContent = x.message; }
    };
  });
}

function changePassDialog() {
  dialog(`<h2>Change passphrase</h2><form id="f"><label>Current passphrase<input id="o" type="password" required></label><label>New passphrase (12+ characters)<input id="n" type="password" required></label><div id="m">${meterHtml()}</div><label>New passphrase again<input id="n2" type="password" required></label><div class="err muted" id="e"></div><div class="btns"><button type="button" class="ghost" data-close>Cancel</button><button class="primary">Change</button></div></form>`, (d) => {
    meterBind($('#m', d), $('#n', d));
    $('#f', d).onsubmit = async (e) => {
      e.preventDefault();
      if ($('#n', d).value !== $('#n2', d).value) return ($('#e', d).textContent = 'The new passphrases do not match.');
      if (!strength($('#n', d).value).ok) return ($('#e', d).textContent = 'Please choose a stronger passphrase.');
      $('#e', d).textContent = 'Working…';
      try { await api('/api/change-passphrase', { method: 'POST', json: { oldPassphrase: $('#o', d).value, newPassphrase: $('#n', d).value } }); d.close(); toast('Passphrase changed'); } catch (x) { $('#e', d).textContent = x.message; }
    };
  });
}
function upgradeDialog() {
  dialog(`<h2>Upgrade encryption</h2><p class="muted">Your vault will be re-encrypted with a stronger key setup. All files and records are kept. It is safe: if anything goes wrong, nothing changes. Choose a new passphrase (you can reuse your current one only if it is strong).</p>
    <form id="f"><label>New passphrase (12+ characters)<input id="n" type="password" required></label><div id="m">${meterHtml()}</div><label>Type it again<input id="n2" type="password" required></label><div class="err muted" id="e"></div><div class="btns"><button type="button" class="ghost" data-close>Cancel</button><button class="primary">Upgrade</button></div></form>`, (d) => {
    meterBind($('#m', d), $('#n', d));
    $('#f', d).onsubmit = async (e) => {
      e.preventDefault();
      if ($('#n', d).value !== $('#n2', d).value) return ($('#e', d).textContent = 'The passphrases do not match.');
      if (!strength($('#n', d).value).ok) return ($('#e', d).textContent = 'Please choose a stronger passphrase.');
      try { await api('/api/upgrade', { method: 'POST', json: { newPassphrase: $('#n', d).value } }); upgradeProgress(); } catch (x) { $('#e', d).textContent = x.message; }
    };
  });
}
async function upgradeProgress() {
  const d = dialog('<h2>Upgrading…</h2><p id="up-t" class="muted">Starting…</p><div class="meter"><i id="up-b" class="good" style="width:3%"></i></div><p class="muted">Keep this page open. Large vaults can take a few minutes.</p>');
  d.oncancel = (e) => e.preventDefault();
  for (;;) {
    await sleep(700);
    let st; try { st = await api('/api/status'); } catch { continue; }
    const u = st.upgrade || {};
    if (u.error) { d.oncancel = null; $('#up-t', d).textContent = u.error; d.insertAdjacentHTML('beforeend', '<div class="btns"><button data-close>Close</button></div>'); d.querySelector('[data-close]').onclick = () => d.close(); return; }
    if (u.finished) { S = st; d.oncancel = null; d.close(); toast('Encryption upgraded'); render(); return; }
    $('#up-t', d).textContent = u.total ? `Re-encrypting file ${Math.min(u.done + 1, u.total)} of ${u.total}…` : 'Preparing…';
    $('#up-b', d).style.width = Math.max(3, u.total ? Math.round((u.done / u.total) * 100) : 3) + '%';
  }
}

function itemDialog(it, pre = {}) {
  const isNew = !it;
  const x = it || { id: uid(), title: '', category: pre.category || (CATS.includes('Family Resources') ? 'Family Resources' : CATS[0]), personId: pre.personId || '', notes: '', expires: '', files: [], reviewed: true, created: today(), ...pre };
  const touched = { cat: !isNew || !!pre.category, who: !isNew || !!pre.personId, title: !isNew };
  dialog(`<div class="pvcol" id="pvcol"><div id="pvsel"></div><div id="pv"></div></div><div class="formcol"><h2>${isNew ? 'Add document' : 'Edit document'}</h2><form id="f">
    <label>Title<input id="title" value="${esc(x.title)}" required maxlength="140"></label>
    <div class="grid2"><label>Category<select id="cat">${opts(CATS.map((c) => [c, c]), x.category)}</select></label>
    <label>Belongs to<select id="who">${opts([['', 'Whole family'], ...db.people.map((p) => [p.id, p.name])], x.personId)}</select></label></div>
    <div id="pwf" class="grid2 ${x.category === 'Passwords' ? '' : 'hidden'}"><label>Website<input id="url" value="${esc(x.url)}"></label><label>Username<input id="user" value="${esc(x.username)}" autocomplete="off"></label>
      <label style="grid-column:1/-1">Password <span style="float:right"><a href="#" id="showpw">show</a> · <a href="#" id="genpw">generate</a></span><input id="pass" class="secret" type="password" value="${esc(x.password)}" autocomplete="off"></label></div>
    <label>Expires / renews (optional)<input id="exp" type="date" value="${esc(x.expires)}"></label>
    <label>Notes<textarea id="notes" rows="3">${esc(x.notes)}</textarea></label>
    <div class="files" id="fl"></div>
    <div class="btns">${isNew ? '' : '<button type="button" class="danger left" id="del">Delete</button>'}<button type="button" id="att">Attach files</button><button type="button" class="ghost" data-close>Cancel</button><button class="primary">Save</button></div></form></div>`, (d) => {
    let shown = '';
    const drawFiles = () => {
      const recs = (x.files || []).map(fileOf).filter(Boolean);
      d.classList.toggle('wide', recs.length > 0);
      $('#pvcol', d).classList.toggle('hidden', !recs.length);
      $('#pvsel', d).innerHTML = recs.length > 1 ? `<select id="pvpick">${recs.map((r) => `<option value="${esc(r.id)}" ${r.id === shown ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>` : '';
      if ($('#pvpick', d)) $('#pvpick', d).onchange = (e) => { shown = e.target.value; buildPreview($('#pv', d), fileOf(shown)); };
      if (recs.length && !recs.find((r) => r.id === shown)) { shown = recs[0].id; buildPreview($('#pv', d), recs[0]); }
      $('#fl', d).innerHTML = recs.map((f) => `<a href="${fileUrl(f.id)}" target="_blank" rel="noopener"><span>${esc(f.name)}</span><span class="muted">${fmtSize(f.size)} <span data-rm="${f.id}" style="color:var(--bad)">remove</span></span></a>`).join('');
      $('#fl', d).querySelectorAll('[data-rm]').forEach((s) => (s.onclick = (e) => { e.preventDefault(); e.stopPropagation(); x.files = x.files.filter((i) => i !== s.dataset.rm); drawFiles(); }));
    };
    drawFiles();
    $('#title', d).oninput = () => (touched.title = true);
    $('#cat', d).onchange = () => { touched.cat = true; $('#pwf', d).classList.toggle('hidden', $('#cat', d).value !== 'Passwords'); };
    $('#who', d).onchange = () => (touched.who = true);
    $('#showpw', d).onclick = (e) => { e.preventDefault(); const p = $('#pass', d); p.type = p.type === 'password' ? 'text' : 'password'; e.target.textContent = p.type === 'password' ? 'show' : 'hide'; };
    $('#genpw', d).onclick = (e) => { e.preventDefault(); const p = $('#pass', d); p.value = genPassword(); p.type = 'text'; $('#showpw', d).textContent = 'hide'; };
    $('#att', d).onclick = () => pickFiles(async (list) => {
      for (const f of list) {
        const r = await uploadOne(f); if (!r) continue;
        localFiles.set(r.id, { file: f });
        db.files.push(r); x.files.push(r.id);
        if (!touched.title) { $('#title', d).value = cleanTitle(f.name); touched.title = true; }          // best guesses from the file name
        if (!touched.cat) { $('#cat', d).value = guessCategory(f.name); $('#pwf', d).classList.toggle('hidden', $('#cat', d).value !== 'Passwords'); touched.cat = true; }
        if (!touched.who) { const g = guessPerson(f.name); if (g) { $('#who', d).value = g; touched.who = true; } }
      }
      drawFiles();
    });
    if ($('#del', d)) $('#del', d).onclick = async () => { if (!confirm('Delete this document and its files?')) return; db.items = db.items.filter((i) => i.id !== x.id); db.files = db.files.filter((f) => !x.files.includes(f.id)); await save(); d.close(); render(); };
    $('#f', d).onsubmit = async (e) => {
      e.preventDefault();
      Object.assign(x, { title: $('#title', d).value.trim(), category: $('#cat', d).value, personId: $('#who', d).value, expires: $('#exp', d).value, notes: $('#notes', d).value, reviewed: true });
      if (x.category === 'Passwords') Object.assign(x, { url: $('#url', d).value, username: $('#user', d).value, password: $('#pass', d).value });
      if (isNew) db.items.push(x); else db.items[db.items.findIndex((i) => i.id === x.id)] = x;
      try { await save(); d.close(); render(); toast('Saved'); } catch (err) { toast(err.message); }
    };
  });
}

async function squarePhoto(file) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(bmp.width, bmp.height), c = document.createElement('canvas');
  c.width = c.height = 256;
  c.getContext('2d').drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, 256, 256);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.86));
}

function personDialog(p) {
  const x = p ? { ...p } : { id: uid(), name: '', birthday: '', note: '', photo: '' };
  let pending = null, removePhoto = false;
  dialog(`<h2>${p ? 'Edit' : 'Add'} person</h2><form id="f">
    <div class="photo-edit"><div id="pv"></div><div><button type="button" id="pp">Choose photo</button> <button type="button" class="ghost danger" id="pr">Remove</button><div class="muted" style="font-size:.8em;margin-top:4px">Resized and stored encrypted in your vault.</div></div></div>
    <label>Name<input id="n" value="${esc(x.name)}" required maxlength="60"></label>
    <label>Birthday (optional)<input id="b" type="date" value="${esc(x.birthday)}"></label><label>Note<input id="no" value="${esc(x.note)}" maxlength="120" placeholder="e.g. Allergic to penicillin, SSN card is in the fireproof box"></label>
    <div class="btns">${p ? '<button type="button" class="danger left" id="del">Delete</button>' : ''}<button type="button" class="ghost" data-close>Cancel</button><button class="primary">Save</button></div></form>`, (d) => {
    let blobUrl = null;
    const draw = () => {
      const name = $('#n', d).value || x.name || '?';
      $('#pv', d).innerHTML = `<div class="avatar lg">${blobUrl ? `<img src="${blobUrl}" alt="">` : x.photo && !removePhoto && fileOf(x.photo) ? `<img src="/api/files/${esc(x.photo)}" alt="">` : esc(name[0].toUpperCase())}</div>`;
    };
    draw(); $('#n', d).oninput = draw;
    $('#pp', d).onclick = () => { const pk = $('#photopicker'); pk.value = ''; pk.onchange = async () => {
      if (!pk.files[0]) return;
      try { const blob = await squarePhoto(pk.files[0]); pending = blob; removePhoto = false; if (blobUrl) URL.revokeObjectURL(blobUrl); blobUrl = URL.createObjectURL(blob); draw(); }
      catch { toast('Could not read that image. Try a JPG or PNG.'); }
    }; pk.click(); };
    $('#pr', d).onclick = () => { pending = null; removePhoto = true; if (blobUrl) URL.revokeObjectURL(blobUrl); blobUrl = null; draw(); };
    if ($('#del', d)) $('#del', d).onclick = async () => { if (!confirm('Remove this person? Their documents stay in the vault as “Whole family”.')) return; db.people = db.people.filter((q) => q.id !== x.id); db.items.forEach((i) => { if (i.personId === x.id) i.personId = ''; }); db.files = db.files.filter((f) => f.id !== x.photo); await save(); d.close(); go({ name: 'people' }); };
    $('#f', d).onsubmit = async (e) => {
      e.preventDefault();
      try {
        if (pending) {
          const rec = await uploadOne(new File([pending], 'photo.jpg', { type: 'image/jpeg' }), true);
          if (!rec) return;
          db.files = db.files.filter((f) => f.id !== x.photo); db.files.push(rec); x.photo = rec.id;
        } else if (removePhoto && x.photo) { db.files = db.files.filter((f) => f.id !== x.photo); x.photo = ''; }
        Object.assign(x, { name: $('#n', d).value.trim(), birthday: $('#b', d).value, note: $('#no', d).value });
        if (p) db.people[db.people.findIndex((q) => q.id === x.id)] = x; else db.people.push(x);
        await save(); d.close(); render();
      } catch (err) { toast(err.message); }
    };
  });
}

function contactDialog(c) {
  const x = c || { id: uid(), name: '', role: '', phone: '', email: '', notes: '' };
  dialog(`<h2>${c ? 'Edit' : 'Add'} contact</h2><form id="f"><div class="grid2"><label>Name<input id="n" value="${esc(x.name)}" required></label><label>Role<input id="r" value="${esc(x.role)}" placeholder="Attorney, Doctor…"></label>
    <label>Phone<input id="p" value="${esc(x.phone)}"></label><label>Email<input id="e" type="email" value="${esc(x.email)}"></label></div>
    <label>Notes<textarea id="no" rows="3">${esc(x.notes)}</textarea></label>
    <div class="btns">${c ? '<button type="button" class="danger left" id="del">Delete</button>' : ''}<button type="button" class="ghost" data-close>Cancel</button><button class="primary">Save</button></div></form>`, (d) => {
    if ($('#del', d)) $('#del', d).onclick = async () => { if (!confirm('Delete this contact?')) return; db.contacts = db.contacts.filter((q) => q.id !== x.id); await save(); d.close(); render(); };
    $('#f', d).onsubmit = async (e) => {
      e.preventDefault();
      Object.assign(x, { name: $('#n', d).value.trim(), role: $('#r', d).value, phone: $('#p', d).value, email: $('#e', d).value, notes: $('#no', d).value });
      if (!c) db.contacts.push(x);
      await save(); d.close(); render();
    };
  });
}

const ADDR_RE = /^(bc1[ac-hj-np-z02-9]{11,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/i;
const XPUB_RE = /^[xyz]pub[1-9A-HJ-NP-Za-km-z]{100,112}$/;
function walletDialog(w) {
  const x = w || { id: uid(), label: '', address: '', xpub: '', script: 'wpkh', personId: '', notes: '' };
  dialog(`<h2>${w ? 'Edit' : 'Track a'} wallet</h2><form id="f">
    <label>Label<input id="l" value="${esc(x.label)}" required maxlength="60" placeholder="Trezor, Savings, Kids' fund…"></label>
    <label>Wallet key (xpub / ypub / zpub), recommended<input id="xp" class="secret" value="${esc(x.xpub)}" maxlength="120" placeholder="zpub6r… (shows the whole wallet)" autocomplete="off" spellcheck="false"></label>
    <label id="scr-l" class="${x.xpub && x.xpub.startsWith('xpub') ? '' : 'hidden'}">Address type for this key<select id="scr">${opts([['wpkh', 'Native SegWit (bc1q…), most common'], ['sh-wpkh', 'Nested SegWit (3…)'], ['pkh', 'Legacy (1…)']], x.script || 'wpkh')}</select></label>
    <div class="muted" style="font-size:.85em;margin:-4px 0 10px">…or track a single address instead:</div>
    <label>Public address<input id="a" class="secret" value="${esc(x.address)}" maxlength="100" placeholder="bc1q… or 1… or 3…" autocomplete="off" spellcheck="false"></label>
    <label>Belongs to<select id="who">${opts([['', 'Whole family'], ...db.people.map((p) => [p.id, p.name])], x.personId)}</select></label>
    <label>Notes<textarea id="no" rows="2">${esc(x.notes)}</textarea></label>
    <div class="muted" style="font-size:.85em">Public information only. Never enter a seed phrase or private key (xprv, zprv…). A wallet key lets the lookup server see all of this wallet's addresses, so use your own Mempool node if that matters to you.</div>
    <div class="err muted" id="e"></div>
    <div class="btns">${w ? '<button type="button" class="danger left" id="del">Remove</button>' : ''}<button type="button" class="ghost" data-close>Cancel</button><button class="primary">Save</button></div></form>`, (d) => {
    $('#xp', d).oninput = () => $('#scr-l', d).classList.toggle('hidden', !$('#xp', d).value.trim().startsWith('xpub'));
    if ($('#del', d)) $('#del', d).onclick = async () => { if (!confirm('Stop tracking this wallet?')) return; db.wallets = db.wallets.filter((q) => q.id !== x.id); await save(); d.close(); render(); };
    $('#f', d).onsubmit = async (e) => {
      e.preventDefault();
      const xp = $('#xp', d).value.trim(), ad = $('#a', d).value.trim();
      if (/prv/i.test(xp + ad)) return ($('#e', d).textContent = 'That looks like a private key. Never enter private keys here.');
      if (xp ? !XPUB_RE.test(xp) : !ADDR_RE.test(ad)) return ($('#e', d).textContent = 'Enter a valid wallet key (xpub/ypub/zpub) or Bitcoin address. A seed phrase must never go here.');
      Object.assign(x, { label: $('#l', d).value.trim(), xpub: xp, address: xp ? '' : ad, script: $('#scr', d).value, personId: $('#who', d).value, notes: $('#no', d).value });
      if (!w) db.wallets.push(x);
      try { await save(); d.close(); render(); } catch (err) { $('#e', d).textContent = err.message; }
    };
  });
}

function noteDialog(n) {
  const x = n || { id: uid(), title: '', kind: BTC_KINDS[0], location: '', notes: '' };
  dialog(`<h2>${n ? 'Edit' : 'Add'} Bitcoin instructions</h2><form id="f">
    <label>Title<input id="t" value="${esc(x.title)}" required maxlength="100" placeholder="Ledger Nano, Coinbase account, Seed card #1…"></label>
    <label>Type<select id="k">${opts(BTC_KINDS.map((k) => [k, k]), x.kind)}</select></label>
    <label>Where is it?<input id="w" value="${esc(x.location)}" maxlength="200" placeholder="Fireproof safe in the basement, top shelf"></label>
    <label>Instructions<textarea id="no" rows="5" placeholder="How to find it and what to do. Describe where seed phrases are kept; do not type the words here.">${esc(x.notes)}</textarea></label>
    <div class="btns">${n ? '<button type="button" class="danger left" id="del">Delete</button>' : ''}<button type="button" class="ghost" data-close>Cancel</button><button class="primary">Save</button></div></form>`, (d) => {
    if ($('#del', d)) $('#del', d).onclick = async () => { if (!confirm('Delete these instructions?')) return; db.bitcoin = db.bitcoin.filter((q) => q.id !== x.id); await save(); d.close(); render(); };
    $('#f', d).onsubmit = async (e) => {
      e.preventDefault();
      Object.assign(x, { title: $('#t', d).value.trim(), kind: $('#k', d).value, location: $('#w', d).value, notes: $('#no', d).value });
      if (!n) db.bitcoin.push(x);
      await save(); d.close(); render();
    };
  });
}

function reminderDialog() {
  dialog(`<h2>New reminder</h2><form id="f"><label>What<input id="t" required maxlength="140" placeholder="Renew passports"></label><label>Date<input id="d" type="date" required value="${today()}"></label>
    <div class="btns"><button type="button" class="ghost" data-close>Cancel</button><button class="primary">Save</button></div></form>`, (d) => {
    $('#f', d).onsubmit = async (e) => { e.preventDefault(); db.reminders.push({ id: uid(), title: $('#t', d).value.trim(), date: $('#d', d).value, done: false }); await save(); d.close(); render(); };
  });
}

// ---------- uploads ----------
async function uploadOne(file, avatarFlag) {
  try {
    const r = await fetch('/api/files', { method: 'PUT', body: file, headers: { 'Content-Type': 'application/octet-stream', 'X-FV': '1' } });
    if (r.status === 423) { await boot(); throw new Error('The vault is locked.'); }
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Upload failed.');
    return { id: data.id, name: file.name, type: file.type || 'application/octet-stream', size: file.size, ...(avatarFlag ? { avatar: true } : {}) };
  } catch (e) { toast(`${file.name}: ${e.message}`); return null; }
}
function pickFiles(cb) { const p = $('#picker'); p.value = ''; p.onchange = () => cb([...p.files]); p.click(); }
async function ingest(list, ctx = {}) {
  if (!list.length) return;
  toast(`Encrypting ${list.length} file${list.length > 1 ? 's' : ''}…`);
  for (const f of list) {
    const rec = await uploadOne(f);
    if (!rec) continue;
    db.files.push(rec);
    db.items.push({ id: uid(), title: cleanTitle(f.name), category: ctx.cat || guessCategory(f.name), personId: ctx.personId || guessPerson(f.name), notes: '', expires: '', files: [rec.id], reviewed: !!(ctx.cat || ctx.personId), created: today() });
  }
  try { await save(); } catch (e) { toast(e.message); }
  if (ctx.cat || ctx.personId) render(); else go({ name: 'inbox' });
}
function bindDrop(el, ctx) {
  if (!el) return;
  el.onclick = () => pickFiles((l) => ingest(l, ctx));
  el.ondragover = (e) => { e.preventDefault(); el.classList.add('over'); };
  el.ondragleave = () => el.classList.remove('over');
  el.ondrop = (e) => { e.preventDefault(); el.classList.remove('over'); ingest([...e.dataTransfer.files], ctx); };
}

// ---------- wiring ----------
$('#lock-btn').onclick = async () => { await fetch('/api/lock', { method: 'POST', headers: { 'X-FV': '1' } }); db = null; query = ''; btcSummary = null; thumbCache.clear(); localFiles.clear(); $('#search').value = ''; boot(); };
$('#menu').onclick = () => $('.side').classList.toggle('open');
$('#search').oninput = (e) => { query = e.target.value.trim(); render(); };
$('#add-btn').onclick = () => dialog(`<h2>Add</h2><div class="list">
  <div class="row" id="a1"><span class="th plain">📄</span><div class="grow"><div class="t">Document</div><div class="s">Record with optional files, expiry date and notes</div></div></div>
  <div class="row" id="a2"><span class="th plain">📥</span><div class="grow"><div class="t">Upload files</div><div class="s">They land in the Inbox with a best-guess category and person</div></div></div>
  <div class="row" id="a3"><span class="th plain">🧑</span><div class="grow"><div class="t">Person</div></div></div>
  <div class="row" id="a4"><span class="th plain">📇</span><div class="grow"><div class="t">Contact</div></div></div>
  <div class="row" id="a5"><span class="th plain">⏰</span><div class="grow"><div class="t">Reminder</div></div></div>
  <div class="row" id="a6"><span class="th plain">₿</span><div class="grow"><div class="t">Bitcoin wallet to track</div></div></div></div>
  <div class="btns"><button class="ghost" data-close>Close</button></div>`, (d) => {
  const pre = view.name === 'cat' ? { category: view.cat } : view.name === 'person' ? { personId: view.id } : {};
  $('#a1', d).onclick = () => itemDialog(null, pre);
  $('#a2', d).onclick = () => { d.close(); pickFiles((l) => ingest(l, view.name === 'person' ? { personId: view.id } : view.name === 'cat' ? { cat: view.cat } : {})); };
  $('#a3', d).onclick = () => personDialog();
  $('#a4', d).onclick = () => contactDialog();
  $('#a5', d).onclick = reminderDialog;
  $('#a6', d).onclick = () => walletDialog();
});
boot().catch((e) => { $('#gate').classList.remove('hidden'); $('#gate').innerHTML = `<div class="box"><h1>Can't reach the vault</h1><p class="muted">${esc(e.message)}</p></div>`; });
