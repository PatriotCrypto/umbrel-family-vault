'use strict';
const CATS = ['Family','Finance','Property','Passwords','Insurance','Tax','Legal','Business','Employment','Family Resources'];
const HINTS = {
  Finance:['bank','statement','invoice','loan','mortgage','401k','ira','investment','credit'],
  Property:['deed','title','lease','rent','hoa','property','vehicle','registration','home'],
  Insurance:['insurance','policy','claim','coverage','premium'],
  Tax:['tax','1040','w-2','w2','1099','irs','return'],
  Legal:['will','trust','power of attorney','poa','contract','court','agreement','divorce'],
  Business:['llc','business','incorporation','ein','corp'],
  Employment:['resume','offer','payroll','paystub','employment','benefits'],
  Family:['birth','passport','license','social','marriage','certificate','vaccin','medical','id'],
};
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
const today = () => new Date().toISOString().slice(0, 10);
const daysUntil = (d) => Math.round((new Date(d + 'T00:00:00') - new Date(today() + 'T00:00:00')) / 864e5);
const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const fmtDate = (d) => (d ? new Date(d + 'T00:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');

let db = null, view = { name: 'home' }, query = '';
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600); }

async function api(url, opts = {}) {
  const o = { method: opts.method || 'GET', headers: {} };
  if (opts.json !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(opts.json); }
  if (opts.body) o.body = opts.body;
  const r = await fetch(url, o);
  if (r.status === 423) { await boot(); throw new Error('The vault is locked.'); }
  let data = null; try { data = await r.json(); } catch {}
  if (!r.ok) throw new Error((data && data.error) || 'Something went wrong.');
  return data;
}
async function save() {
  const r = await api('/api/db', { method: 'PUT', json: db });
  db.rev = r.rev;
}

// ---------- gate (setup / unlock) ----------
async function boot() {
  const st = await api('/api/status');
  if (st.unlocked) {
    db = await api('/api/db');
    $('#gate').classList.add('hidden'); $('#app').classList.remove('hidden');
    render();
    return;
  }
  $('#app').classList.add('hidden');
  const g = $('#gate'); g.classList.remove('hidden');
  if (!st.initialized) {
    g.innerHTML = `<form class="box" id="gf"><img src="icon.svg" alt=""><h1>Create your vault</h1>
      <p class="muted">Choose a passphrase. Everything you store is encrypted with it, and it is never saved anywhere.
      <b>If you forget it, nobody can recover your documents</b>, so write it down and keep it somewhere safe.</p>
      <label>Passphrase (8+ characters)<input id="p1" type="password" autocomplete="new-password" required></label>
      <label>Type it again<input id="p2" type="password" autocomplete="new-password" required></label>
      <div class="err" id="ge"></div><button class="primary" style="width:100%">Create vault</button></form>`;
    $('#gf').onsubmit = async (e) => {
      e.preventDefault();
      if ($('#p1').value !== $('#p2').value) return ($('#ge').textContent = 'The two passphrases do not match.');
      try { await api('/api/setup', { method: 'POST', json: { passphrase: $('#p1').value } }); boot(); }
      catch (x) { $('#ge').textContent = x.message; }
    };
  } else {
    g.innerHTML = `<form class="box" id="gf"><img src="icon.svg" alt=""><h1>Family Vault</h1>
      <p class="muted">Enter your passphrase to unlock.</p>
      <label>Passphrase<input id="p1" type="password" autocomplete="current-password" required autofocus></label>
      <div class="err" id="ge"></div><button class="primary" style="width:100%">Unlock</button></form>`;
    $('#gf').onsubmit = async (e) => {
      e.preventDefault();
      try { await api('/api/unlock', { method: 'POST', json: { passphrase: $('#p1').value } }); boot(); }
      catch (x) { $('#ge').textContent = x.message; }
    };
  }
  setTimeout(() => $('#p1') && $('#p1').focus(), 50);
}

// ---------- data helpers ----------
const person = (id) => db.people.find((p) => p.id === id);
const fileOf = (id) => db.files.find((f) => f.id === id);
const inbox = () => db.items.filter((i) => !i.reviewed);
function suggest(name) {
  const n = name.toLowerCase();
  for (const [c, words] of Object.entries(HINTS)) if (words.some((w) => n.includes(w))) return c;
  return 'Family Resources';
}
function upcoming() {
  const out = [];
  for (const i of db.items) if (i.expires && i.reviewed !== false) out.push({ kind: 'item', id: i.id, title: i.title + ' expires', date: i.expires });
  for (const r of db.reminders) if (!r.done) out.push({ kind: 'rem', id: r.id, title: r.title, date: r.date });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
const dueBadge = (d) => {
  const n = daysUntil(d);
  if (n < 0) return `<span class="pill bad">${-n}d overdue</span>`;
  if (n <= 30) return `<span class="pill warn">in ${n}d</span>`;
  return `<span class="pill">${fmtDate(d)}</span>`;
};

// ---------- nav / render ----------
function go(v) { view = v; $('.side').classList.remove('open'); render(); }
function renderNav() {
  const n = inbox().length, soon = upcoming().filter((u) => daysUntil(u.date) <= 30).length;
  const b = (name, label, extra = '', arg) => `<button data-v="${name}" ${arg ? `data-a="${esc(arg)}"` : ''} class="${view.name === name && (!arg || view.cat === arg || view.id === arg) ? 'on' : ''}"><span>${label}</span>${extra}</button>`;
  $('#nav').innerHTML =
    b('home', 'Home') + b('inbox', 'Inbox', n ? `<span class="count">${n}</span>` : '') + b('reminders', 'Reminders', soon ? `<span class="count">${soon}</span>` : '') +
    `<div class="sep">Categories</div>` + CATS.map((c) => b('cat', esc(c), '', c)).join('') + b('contacts', 'Contacts') +
    `<div class="sep">Family</div>` + b('people', 'People &amp; pets') + b('settings', 'Settings');
  for (const el of $('#nav').querySelectorAll('button')) el.onclick = () => {
    const v = el.dataset.v; go(v === 'cat' ? { name: 'cat', cat: el.dataset.a } : { name: v });
  };
}
function render() {
  renderNav();
  const v = $('#view');
  if (query) return renderSearch(v);
  ({ home: renderHome, inbox: renderInbox, reminders: renderReminders, cat: renderCat, contacts: renderContacts, people: renderPeople, person: renderPerson, settings: renderSettings }[view.name] || renderHome)(v);
}

// ---------- views ----------
function itemRow(i) {
  const p = person(i.personId);
  return `<div class="row" data-item="${i.id}"><div class="grow"><div class="t">${esc(i.title)}</div>
    <div class="s">${esc(i.category)}${p ? ' · ' + esc(p.name) : ''}${i.files && i.files.length ? ' · ' + i.files.length + ' file' + (i.files.length > 1 ? 's' : '') : ''}</div></div>${i.expires ? dueBadge(i.expires) : ''}</div>`;
}
function bindItems(root) { root.querySelectorAll('[data-item]').forEach((e) => (e.onclick = () => itemDialog(db.items.find((i) => i.id === e.dataset.item)))); }

function renderHome(v) {
  const up = upcoming().slice(0, 5), n = inbox().length;
  const recent = db.items.filter((i) => i.reviewed !== false).slice().sort((a, b) => (b.created || '').localeCompare(a.created || '')).slice(0, 6);
  v.innerHTML = `<div class="head"><div><h2>Welcome home</h2><div class="muted">${db.items.length} items · ${db.files.length} files · all encrypted</div></div></div>
    ${n ? `<div class="suggest"><div class="grow"><b>${n} new file${n > 1 ? 's' : ''} to review</b><div class="muted">Check the suggested category and accept.</div></div><button class="primary" id="gi">Review</button></div>` : ''}
    <div class="drop" id="drop">Drop files here or click to upload</div>
    <h3>Coming up</h3><div class="list">${up.length ? up.map((u) => `<div class="row"><div class="grow"><div class="t">${esc(u.title)}</div></div>${dueBadge(u.date)}</div>`).join('') : '<div class="empty">Nothing due. Add an expiry date to a document or create a reminder.</div>'}</div>
    <h3>People &amp; pets</h3><div class="cards">${db.people.map(personCard).join('')}<div class="card" id="addp" style="display:flex;align-items:center;justify-content:center;color:var(--mute)">+ Add person or pet</div></div>
    <h3>Recently added</h3><div class="list">${recent.length ? recent.map(itemRow).join('') : '<div class="empty">No documents yet.</div>'}</div>`;
  if ($('#gi')) $('#gi').onclick = () => go({ name: 'inbox' });
  $('#addp').onclick = () => personDialog();
  bindPersonCards(v); bindItems(v); bindDrop($('#drop'));
}
const personCard = (p) => `<div class="card" data-person="${p.id}"><div class="avatar ${p.kind === 'pet' ? 'pet' : ''}">${esc((p.name || '?')[0].toUpperCase())}</div><div class="t">${esc(p.name)}</div><div class="muted">${p.kind === 'pet' ? 'Pet' : 'Person'} · ${db.items.filter((i) => i.personId === p.id).length} items</div></div>`;
function bindPersonCards(r) { r.querySelectorAll('[data-person]').forEach((e) => (e.onclick = () => go({ name: 'person', id: e.dataset.person }))); }

function renderCat(v) {
  const items = db.items.filter((i) => i.category === view.cat && i.reviewed !== false);
  v.innerHTML = `<div class="head"><h2>${esc(view.cat)}</h2><button class="primary" id="a">+ Add to ${esc(view.cat)}</button></div>
    ${view.cat === 'Passwords' ? '<div class="muted">Logins are stored inside the encrypted vault.</div>' : ''}
    <div class="drop" id="drop" style="margin-top:12px">Drop files here to add to ${esc(view.cat)}</div>
    <div class="list">${items.length ? items.map(itemRow).join('') : '<div class="empty">Nothing here yet.</div>'}</div>`;
  $('#a').onclick = () => itemDialog(null, { category: view.cat });
  bindItems(v); bindDrop($('#drop'), view.cat);
}

function renderInbox(v) {
  const items = inbox();
  v.innerHTML = `<div class="head"><div><h2>Inbox</h2><div class="muted">New uploads wait here until you confirm where they belong.</div></div>${items.length > 1 ? '<button class="primary" id="all">Accept all</button>' : ''}</div>
    <div class="drop" id="drop">Drop files here or click to upload</div>
    ${items.length ? items.map((i) => `<div class="suggest" data-id="${i.id}"><div class="grow"><b>${esc(i.title)}</b><div class="muted">Suggested: ${esc(i.category)}${i.files && i.files[0] && fileOf(i.files[0]) ? ' · ' + fmtSize(fileOf(i.files[0]).size) : ''}</div></div><button class="primary acc">Accept</button><button class="rev">Review</button></div>`).join('') : '<div class="empty">Inbox is empty.</div>'}`;
  bindDrop($('#drop'));
  v.querySelectorAll('.suggest').forEach((el) => {
    const it = db.items.find((i) => i.id === el.dataset.id);
    el.querySelector('.acc').onclick = async () => { it.reviewed = true; await save(); render(); };
    el.querySelector('.rev').onclick = () => itemDialog(it);
  });
  if ($('#all')) $('#all').onclick = async () => { items.forEach((i) => (i.reviewed = true)); await save(); render(); };
}

function renderReminders(v) {
  const up = upcoming(), done = db.reminders.filter((r) => r.done);
  v.innerHTML = `<div class="head"><h2>Reminders</h2><button class="primary" id="a">+ New reminder</button></div>
    <div class="list">${up.length ? up.map((u) => `<div class="row" data-k="${u.kind}" data-id="${u.id}"><div class="grow"><div class="t">${esc(u.title)}</div><div class="s">${u.kind === 'item' ? 'From a document expiry date' : 'Reminder'}</div></div>${dueBadge(u.date)}${u.kind === 'rem' ? '<button class="small chk">Done</button>' : ''}</div>`).join('') : '<div class="empty">No reminders.</div>'}</div>
    ${done.length ? `<h3>Done</h3><div class="list">${done.map((r) => `<div class="row"><div class="grow s">${esc(r.title)} · ${fmtDate(r.date)}</div><button class="small danger del" data-id="${r.id}">Delete</button></div>`).join('')}</div>` : ''}`;
  $('#a').onclick = reminderDialog;
  v.querySelectorAll('.row[data-k]').forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest('.chk')) return;
      if (el.dataset.k === 'item') itemDialog(db.items.find((i) => i.id === el.dataset.id));
    };
    const c = el.querySelector('.chk');
    if (c) c.onclick = async () => { db.reminders.find((r) => r.id === el.dataset.id).done = true; await save(); render(); };
  });
  v.querySelectorAll('.del').forEach((b) => (b.onclick = async () => { db.reminders = db.reminders.filter((r) => r.id !== b.dataset.id); await save(); render(); }));
}

function renderContacts(v) {
  v.innerHTML = `<div class="head"><h2>Contacts</h2><button class="primary" id="a">+ Add contact</button></div>
    <div class="muted">Doctors, lawyers, accountants, agents: the people you call when it matters.</div><div class="list" style="margin-top:12px">${db.contacts.length ? db.contacts.slice().sort((a, b) => a.name.localeCompare(b.name)).map((c) => `<div class="row" data-c="${c.id}"><div class="grow"><div class="t">${esc(c.name)}</div><div class="s">${esc([c.role, c.phone, c.email].filter(Boolean).join(' · '))}</div></div></div>`).join('') : '<div class="empty">No contacts yet.</div>'}</div>`;
  $('#a').onclick = () => contactDialog();
  v.querySelectorAll('[data-c]').forEach((e) => (e.onclick = () => contactDialog(db.contacts.find((c) => c.id === e.dataset.c))));
}

function renderPeople(v) {
  v.innerHTML = `<div class="head"><h2>People &amp; pets</h2><button class="primary" id="a">+ Add</button></div>
    <div class="cards" style="margin-top:12px">${db.people.map(personCard).join('') || '<div class="empty">Add the people and pets whose documents you keep here.</div>'}</div>`;
  $('#a').onclick = () => personDialog(); bindPersonCards(v);
}
function renderPerson(v) {
  const p = person(view.id); if (!p) return go({ name: 'people' });
  const items = db.items.filter((i) => i.personId === p.id && i.reviewed !== false);
  v.innerHTML = `<div class="head"><div><h2>${esc(p.name)}</h2><div class="muted">${p.kind === 'pet' ? 'Pet' : 'Person'}${p.birthday ? ' · born ' + fmtDate(p.birthday) : ''}${p.note ? ' · ' + esc(p.note) : ''}</div></div><div><button id="e">Edit</button> <button class="primary" id="a">+ Add document</button></div></div>
    <div class="list" style="margin-top:12px">${items.length ? items.map(itemRow).join('') : '<div class="empty">No documents filed for ' + esc(p.name) + ' yet.</div>'}</div>`;
  $('#e').onclick = () => personDialog(p); $('#a').onclick = () => itemDialog(null, { personId: p.id });
  bindItems(v);
}

function renderSearch(v) {
  const q = query.toLowerCase();
  const hit = (...s) => s.some((x) => String(x || '').toLowerCase().includes(q));
  const items = db.items.filter((i) => hit(i.title, i.notes, i.category, i.username, i.url, (i.files || []).map((f) => (fileOf(f) || {}).name).join(' ')));
  const ppl = db.people.filter((p) => hit(p.name, p.note));
  const cons = db.contacts.filter((c) => hit(c.name, c.role, c.email, c.phone, c.notes));
  v.innerHTML = `<h2>Results for “${esc(query)}”</h2>
    ${ppl.length ? `<h3>People &amp; pets</h3><div class="cards">${ppl.map(personCard).join('')}</div>` : ''}
    <h3>Documents</h3><div class="list">${items.length ? items.map(itemRow).join('') : '<div class="empty">No matching documents.</div>'}</div>
    ${cons.length ? `<h3>Contacts</h3><div class="list">${cons.map((c) => `<div class="row" data-c="${c.id}"><div class="grow"><div class="t">${esc(c.name)}</div><div class="s">${esc([c.role, c.phone, c.email].filter(Boolean).join(' · '))}</div></div></div>`).join('')}</div>` : ''}`;
  bindItems(v); bindPersonCards(v);
  v.querySelectorAll('[data-c]').forEach((e) => (e.onclick = () => contactDialog(db.contacts.find((c) => c.id === e.dataset.c))));
}

function renderSettings(v) {
  v.innerHTML = `<h2>Settings</h2>
  <h3>Security</h3><div class="list"><div class="row" style="cursor:default"><div class="grow"><div class="t">Auto-lock</div><div class="s">Lock the vault after this much inactivity.</div></div>
    <select id="al" style="width:auto"><option value="5">5 minutes</option><option value="15">15 minutes</option><option value="30">30 minutes</option><option value="60">1 hour</option><option value="240">4 hours</option><option value="0">Never</option></select></div>
    <div class="row" id="cp"><div class="grow"><div class="t">Change passphrase</div><div class="s">Re-encrypts every file with the new passphrase.</div></div></div></div>
  <h3>Backup</h3><div class="list"><div class="row" style="cursor:default"><div class="grow"><div class="t">Download encrypted backup</div><div class="s">A ZIP of your encrypted vault. It is useless without your passphrase, so you can keep it anywhere.</div></div><a href="/api/backup"><button>Download</button></a></div></div>
  <h3>About</h3><p class="muted">Family Vault stores everything on your own Umbrel, encrypted with AES-256-GCM using a key derived from your passphrase (scrypt). The key is held in memory only while the vault is unlocked. Free and open source (MIT).</p>`;
  api('/api/status').then((s) => ($('#al').value = String(s.autoLockMin)));
  $('#al').onchange = async () => { try { await api('/api/settings', { method: 'POST', json: { autoLockMin: +$('#al').value } }); toast('Saved'); } catch (e) { toast(e.message); } };
  $('#cp').onclick = () => dialog(`<h2>Change passphrase</h2><form id="f"><label>Current passphrase<input id="o" type="password" required></label><label>New passphrase (8+ characters)<input id="n" type="password" required></label><label>New passphrase again<input id="n2" type="password" required></label><div class="err muted" id="e"></div><div class="btns"><button type="button" class="ghost" data-close>Cancel</button><button class="primary">Change</button></div></form>`, (d) => {
    d.querySelector('#f').onsubmit = async (e) => {
      e.preventDefault();
      if ($('#n', d).value !== $('#n2', d).value) return ($('#e', d).textContent = 'The new passphrases do not match.');
      $('#e', d).textContent = 'Re-encrypting…';
      try { await api('/api/change-passphrase', { method: 'POST', json: { oldPassphrase: $('#o', d).value, newPassphrase: $('#n', d).value } }); d.close(); toast('Passphrase changed'); }
      catch (x) { $('#e', d).textContent = x.message; }
    };
  });
}

// ---------- dialogs ----------
function dialog(html, bind) {
  const d = $('#dlg'); d.innerHTML = `<div class="dlg">${html}</div>`;
  d.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => d.close()));
  if (!d.open) d.showModal();
  bind && bind(d);
  return d;
}
const opts = (list, sel) => list.map(([v, l]) => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(l)}</option>`).join('');

function itemDialog(it, pre = {}) {
  const isNew = !it;
  const x = it || { id: uid(), title: '', category: pre.category || 'Family Resources', personId: pre.personId || '', notes: '', expires: '', files: [], reviewed: true, created: today(), ...pre };
  const pw = () => $('#cat', $('#dlg')).value === 'Passwords';
  dialog(`<h2>${isNew ? 'Add document' : 'Edit document'}</h2><form id="f">
    <label>Title<input id="title" value="${esc(x.title)}" required maxlength="140"></label>
    <div class="grid2"><label>Category<select id="cat">${opts(CATS.map((c) => [c, c]), x.category)}</select></label>
    <label>Belongs to<select id="who">${opts([['', 'Whole family'], ...db.people.map((p) => [p.id, p.name])], x.personId)}</select></label></div>
    <div id="pwf" class="grid2 ${x.category === 'Passwords' ? '' : 'hidden'}"><label>Website<input id="url" value="${esc(x.url)}"></label><label>Username<input id="user" value="${esc(x.username)}" autocomplete="off"></label>
      <label style="grid-column:1/-1">Password <span style="float:right"><a href="#" id="showpw">show</a></span><input id="pass" class="secret" type="password" value="${esc(x.password)}" autocomplete="off"></label></div>
    <label>Expires / renews (optional)<input id="exp" type="date" value="${esc(x.expires)}"></label>
    <label>Notes<textarea id="notes" rows="3">${esc(x.notes)}</textarea></label>
    <div class="files" id="fl"></div>
    <div class="btns">${isNew ? '' : '<button type="button" class="danger left" id="del">Delete</button>'}<button type="button" id="att">Attach files</button><button type="button" class="ghost" data-close>Cancel</button><button class="primary">Save</button></div></form>`, (d) => {
    const drawFiles = () => {
      $('#fl', d).innerHTML = (x.files || []).map((id) => { const f = fileOf(id); return f ? `<a href="/api/files/${id}" target="_blank" rel="noopener"><span>${esc(f.name)}</span><span class="muted">${fmtSize(f.size)} <span data-rm="${id}" style="color:var(--bad)">remove</span></span></a>` : ''; }).join('');
      $('#fl', d).querySelectorAll('[data-rm]').forEach((s) => (s.onclick = (e) => { e.preventDefault(); e.stopPropagation(); x.files = x.files.filter((i) => i !== s.dataset.rm); drawFiles(); }));
    };
    drawFiles();
    $('#cat', d).onchange = () => $('#pwf', d).classList.toggle('hidden', !pw());
    $('#showpw', d).onclick = (e) => { e.preventDefault(); const p = $('#pass', d); p.type = p.type === 'password' ? 'text' : 'password'; e.target.textContent = p.type === 'password' ? 'show' : 'hide'; };
    $('#att', d).onclick = () => pickFiles(async (list) => { for (const f of list) { const r = await uploadOne(f); if (r) x.files.push(r.id); } drawFiles(); });
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

function personDialog(p) {
  const x = p || { id: uid(), name: '', kind: 'person', birthday: '', note: '' };
  dialog(`<h2>${p ? 'Edit' : 'Add'} person or pet</h2><form id="f"><div class="grid2"><label>Name<input id="n" value="${esc(x.name)}" required maxlength="60"></label>
    <label>Type<select id="k">${opts([['person', 'Person'], ['pet', 'Pet']], x.kind)}</select></label></div>
    <label>Birthday (optional)<input id="b" type="date" value="${esc(x.birthday)}"></label><label>Note<input id="no" value="${esc(x.note)}" maxlength="120" placeholder="e.g. Golden retriever, Dr. Lee is the vet"></label>
    <div class="btns">${p ? '<button type="button" class="danger left" id="del">Delete</button>' : ''}<button type="button" class="ghost" data-close>Cancel</button><button class="primary">Save</button></div></form>`, (d) => {
    if ($('#del', d)) $('#del', d).onclick = async () => { if (!confirm('Remove this entry? Their documents stay in the vault as “Whole family”.')) return; db.people = db.people.filter((q) => q.id !== x.id); db.items.forEach((i) => { if (i.personId === x.id) i.personId = ''; }); await save(); d.close(); go({ name: 'people' }); };
    $('#f', d).onsubmit = async (e) => {
      e.preventDefault();
      Object.assign(x, { name: $('#n', d).value.trim(), kind: $('#k', d).value, birthday: $('#b', d).value, note: $('#no', d).value });
      if (!p) db.people.push(x);
      await save(); d.close(); render();
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

function reminderDialog() {
  dialog(`<h2>New reminder</h2><form id="f"><label>What<input id="t" required maxlength="140" placeholder="Renew passports"></label><label>Date<input id="d" type="date" required value="${today()}"></label>
    <div class="btns"><button type="button" class="ghost" data-close>Cancel</button><button class="primary">Save</button></div></form>`, (d) => {
    $('#f', d).onsubmit = async (e) => { e.preventDefault(); db.reminders.push({ id: uid(), title: $('#t', d).value.trim(), date: $('#d', d).value, done: false }); await save(); d.close(); render(); };
  });
}

// ---------- uploads ----------
async function uploadOne(file) {
  try {
    const r = await fetch('/api/files', { method: 'PUT', body: file, headers: { 'Content-Type': 'application/octet-stream' } });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Upload failed.');
    const rec = { id: data.id, name: file.name, type: file.type || 'application/octet-stream', size: file.size };
    db.files.push(rec);
    return rec;
  } catch (e) { toast(`${file.name}: ${e.message}`); return null; }
}
function pickFiles(cb) {
  const p = $('#picker'); p.value = '';
  p.onchange = () => cb([...p.files]);
  p.click();
}
function bindDrop(el, cat) {
  if (!el) return;
  const take = async (list) => {
    if (!list.length) return;
    toast(`Encrypting ${list.length} file${list.length > 1 ? 's' : ''}…`);
    for (const f of list) {
      const rec = await uploadOne(f);
      if (!rec) continue;
      db.items.push({ id: uid(), title: f.name.replace(/\.[^.]+$/, ''), category: cat || suggest(f.name), personId: '', notes: '', expires: '', files: [rec.id], reviewed: !!cat, created: today() });
    }
    try { await save(); } catch (e) { toast(e.message); }
    if (!cat) go({ name: 'inbox' }); else render();
  };
  el.onclick = () => pickFiles(take);
  el.ondragover = (e) => { e.preventDefault(); el.classList.add('over'); };
  el.ondragleave = () => el.classList.remove('over');
  el.ondrop = (e) => { e.preventDefault(); el.classList.remove('over'); take([...e.dataTransfer.files]); };
}

// ---------- wiring ----------
$('#lock-btn').onclick = async () => { await fetch('/api/lock', { method: 'POST' }); db = null; query = ''; $('#search').value = ''; boot(); };
$('#menu').onclick = () => $('.side').classList.toggle('open');
$('#search').oninput = (e) => { query = e.target.value.trim(); render(); };
$('#add-btn').onclick = () => dialog(`<h2>Add</h2><div class="list">
  <div class="row" id="a1"><div class="grow"><div class="t">Document</div><div class="s">Record with optional files, expiry date and notes</div></div></div>
  <div class="row" id="a2"><div class="grow"><div class="t">Upload files</div><div class="s">They land in the Inbox for review</div></div></div>
  <div class="row" id="a3"><div class="grow"><div class="t">Person or pet</div></div></div>
  <div class="row" id="a4"><div class="grow"><div class="t">Contact</div></div></div>
  <div class="row" id="a5"><div class="grow"><div class="t">Reminder</div></div></div></div>
  <div class="btns"><button class="ghost" data-close>Close</button></div>`, (d) => {
  const pre = view.name === 'cat' ? { category: view.cat } : view.name === 'person' ? { personId: view.id } : {};
  $('#a1', d).onclick = () => itemDialog(null, pre);
  $('#a2', d).onclick = () => { d.close(); bindDrop(document.createElement('div')); pickFiles(async (list) => { for (const f of list) { const r = await uploadOne(f); if (r) db.items.push({ id: uid(), title: f.name.replace(/\.[^.]+$/, ''), category: suggest(f.name), personId: '', notes: '', expires: '', files: [r.id], reviewed: false, created: today() }); } await save(); go({ name: 'inbox' }); }); };
  $('#a3', d).onclick = () => personDialog();
  $('#a4', d).onclick = () => contactDialog();
  $('#a5', d).onclick = reminderDialog;
});
boot().catch((e) => { $('#gate').classList.remove('hidden'); $('#gate').innerHTML = `<div class="box"><h1>Can't reach the vault</h1><p class="muted">${esc(e.message)}</p></div>`; });
