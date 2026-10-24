// dashboard/js/app.js — zero-build SPA (D-S4): hash router + all views (bilingual EN/AR + RTL)
import { api } from './api.js';
import { t, state, applyDir, setLang } from './i18n.js';

applyDir();
const $app = document.getElementById('app');
let me = null;

const NAV = [
  ['summary', '#/'], ['invoices', '#/invoices'], ['requests', '#/requests'], ['products', '#/products'],
  ['prices', '#/prices'], ['reports', '#/reports'], ['users', '#/users'], ['branches', '#/branches'],
  ['ais', '#/ai'], ['logs', '#/logs'], ['backup', '#/backup'], ['services', '#/services'],
];

function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
const RM = (v) => v == null ? '—' : `RM ${Number(v).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
function h(html) { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild; }
function toast(msg, ok = true) {
  const el = h(`<div class="msg ${ok ? 'ok' : 'err'}">${esc(msg)}</div>`);
  document.querySelector('main')?.prepend(el);
  setTimeout(() => el.remove(), 5000);
}

async function boot() {
  try { me = await api('/auth/me'); renderShell(); route(); }
  catch {
    const s = await api('/setup/status').catch(() => ({ configured: false }));
    if (!s.configured) renderWizard(); else renderLogin();
  }
}

// ---------- auth ----------
function renderLogin(err = '') {
  applyDir();
  $app.innerHTML = `<div class="auth card"><h2>${t('brand')}</h2>
    ${err ? `<div class="msg err">${esc(err)}</div>` : ''}
    <label class="f">${t('username')}</label><input id="u" autocomplete="username">
    <label class="f">${t('password')}</label><input id="p" type="password">
    <p><button class="btn" id="go">${t('login')}</button></p></div>`;
  document.getElementById('go').onclick = doLogin;
  document.getElementById('p').onkeydown = (e) => e.key === 'Enter' && doLogin();
}
async function doLogin() {
  try {
    me = await api('/auth/login', { method: 'POST', body: { username: u.value, password: p.value } });
    renderShell(); location.hash = '#/'; route();
  } catch (e) { renderLogin(e.message); }
}

// ---------- wizard (first run — D-S16) ----------
function renderWizard(err = '', step = 1) {
  applyDir();
  $app.innerHTML = `<div class="auth card"><h2>${t('wizardTitle')}</h2>
    ${err ? `<div class="msg err">${esc(err)}</div>` : ''}
    <h3>1. ${t('createOwner')}</h3>
    <label class="f">${t('username')}</label><input id="wu">
    <label class="f">${t('password')} (8+)</label><input id="wp" type="password">
    <p><button class="btn" id="wgo">${t('createOwner')}</button></p>
    <h3>2. Integrations <small>(${t('mockNote')})</small></h3>
    <label class="f">${t('botToken')}</label><input id="wtt" placeholder="123:ABC…">
    <label class="f">${t('geminiKey')}</label><input id="wgk" placeholder="AIza…">
    <label class="f">${t('r2Acc')}</label><input id="wra">
    <label class="f">${t('r2Key')}</label><input id="wrk">
    <label class="f">${t('r2Secret')}</label><input id="wrs">
    <label class="f">${t('r2Bucket')}</label><input id="wrb">
    <p><button class="btn sec" data-test="telegram">${t('testConn')} Telegram</button>
       <button class="btn sec" data-test="gemini">${t('testConn')} Gemini</button>
       <button class="btn sec" data-test="r2">${t('testConn')} R2</button></p>
    <p><button class="btn" id="wfin">${t('finish')}</button></p></div>`;
  document.getElementById('wgo').onclick = async () => {
    try { await api('/setup/owner', { method: 'POST', body: { username: wu.value, password: wp.value } }); toast('Owner created ✔'); }
    catch (e) { toast(e.message, false); }
  };
  document.querySelectorAll('[data-test]').forEach((b) => b.onclick = async () => {
    const svc = b.dataset.test;
    const body = svc === 'telegram' ? { token: wtt.value } : svc === 'gemini' ? { apiKey: wgk.value }
      : { accountId: wra.value, accessKeyId: wrk.value, secretAccessKey: wrs.value, bucket: wrb.value };
    try { await api(`/setup/test/${svc}`, { method: 'POST', body }); toast(`${svc} ✔`); } catch (e) { toast(`${svc}: ${e.message}`, false); }
  });
  document.getElementById('wfin').onclick = async () => {
    try {
      await api('/setup/complete', { method: 'POST', body: {
        secrets: {
          telegram_bot_token: wtt.value || undefined,
          gemini_api_key: wgk.value || undefined,
          r2_account_id: wra.value || undefined, r2_access_key_id: wrk.value || undefined,
          r2_secret_access_key: wrs.value || undefined, r2_bucket: wrb.value || undefined,
        },
        settings: { telegram_mode: wtt.value ? 'real' : 'mock', ai_provider: wgk.value ? 'gemini' : 'mock', storage_mode: wrb.value ? 'r2' : 'mock' },
      } });
      location.reload();
    } catch (e) { toast(e.message, false); }
  };
}

// ---------- shell ----------
function renderShell() {
  applyDir();
  $app.innerHTML = `
    <header class="top"><span class="brand">${t('brand')}</span><span class="spacer"></span>
      <button id="langBtn">${t('lang')}</button><button id="outBtn">${t('logout')}</button></header>
    <div class="layout"><nav class="side" id="nav"></nav><main id="main"></main></div>`;
  document.getElementById('langBtn').onclick = () => { setLang(state.lang === 'en' ? 'ar' : 'en'); renderShell(); route(); };
  document.getElementById('outBtn').onclick = async () => { await api('/auth/logout', { method: 'POST' }); location.reload(); };
}
function nav(hash) {
  const nav = document.getElementById('nav');
  if (!nav) return;
  nav.innerHTML = NAV.map(([key, href]) => `<a href="${href}" class="${hash === href || (href === '#/' && hash === '#/') ? 'active' : ''}">${t(key)}</a>`).join('');
}

async function route() {
  const hash = location.hash || '#/';
  nav(hash);
  const main = document.getElementById('main');
  if (!me) return;
  const view = hash.replace('#/', '').split('/')[0] || 'summary';
  main.innerHTML = '<div class="loading">…</div>';
  const V = { summary: vSummary, invoices: vInvoices, requests: vRequests, products: vProducts, prices: vPrices, reports: vReports, users: vUsers, branches: vBranches, ai: vAI, logs: vLogs, backup: vBackup, services: vServices };
  try { await (V[view] ?? vSummary)(main, hash); }
  catch (e) { main.innerHTML = `<div class="msg err">${esc(e.message)}</div>`; if (e.message === 'unauthenticated') { me = null; renderLogin(); } }
}

// ---------- views ----------
async function vSummary(main) {
  const s = await api('/summary');
  main.innerHTML = `<div class="grid g2">
    <div class="card"><div class="kpi">${RM(s.approved_total)}<small>${t('approvedExp')}</small></div></div>
    <div class="card"><div class="kpi">${s.open_requests}<small>${t('openReq')}</small></div></div>
    <div class="card"><div class="kpi">${s.invoices_pending}<small>${t('pendInv')}</small></div></div>
    <div class="card"><div class="kpi">${s.ai_queue.failed}/${s.ai_queue.dead_letter}<small>${t('aiQueue')}</small></div></div>
  </div>
  <div class="card"><b>${t('byBranch')}</b><div class="chartbox"><canvas id="ch"></canvas></div></div>`;
  if (window.Chart && s.by_branch.length) {
    new Chart(document.getElementById('ch'), { type: 'bar', data: { labels: s.by_branch.map((b) => b.name), datasets: [{ label: 'RM', data: s.by_branch.map((b) => Number(b.total)) }] }, options: { maintainAspectRatio: false } });
  }
}

async function vInvoices(main) {
  const data = await api('/invoices?limit=100');
  main.innerHTML = `<div class="card"><table class="tbl"><tr><th>#</th><th>${t('branch')}</th><th>${t('date')}</th><th>${t('total')}</th><th>${t('status')}</th><th>${t('flags')}</th></tr>
    ${data.items.map((i) => `<tr><td><a href="#/invoices/${i.id}">${i.id}</a></td><td>${esc(i.branch_name)}</td><td>${esc(i.invoice_date ?? '')}</td><td>${RM(i.invoice_total)}</td>
    <td><span class="badge ${i.status === 'approved' ? 'ok' : i.status === 'in_review' ? 'warn' : ''}">${t(i.status === 'in_review' ? 'inReview' : i.status)}</span></td>
    <td>${i.duplicate_flag ? `<span class="badge bad">${t('dup')}</span>` : ''} ${i.discrepancy_flag ? `<span class="badge warn">${t('disc')}</span>` : ''}</td></tr>`).join('')}</table></div>`;
  if (location.hash.includes('/')) {
    const id = location.hash.split('/')[2];
    if (id) await vInvoiceDetail(main, id);
  }
}

async function vInvoiceDetail(main, id) {
  const d = await api(`/invoices/${id}`);
  const inv = d.invoice;
  main.appendChild(h(`<div class="card"><h3>🧾 #${inv.id} — ${esc(inv.supplier_name ?? '')} ${esc(inv.invoice_date ?? '')} [${esc(inv.detected_language ?? '—')}]</h3>
    ${inv.duplicate_flag ? `<div class="msg err">⚠ ${t('dup')}</div>` : ''}
    ${inv.discrepancy_flag ? `<div class="msg err">⚠ ${t('disc')}</div><input id="discNote" placeholder="${t('discNote')}" value="${esc(inv.discrepancy_note ?? '')}">` : ''}
    <table class="tbl"><tr><th></th><th>${t('product')}</th><th>${t('qty')}</th><th>${t('price')}</th><th>${t('total')}</th><th>${t('status')}</th><th>${t('actions')}</th></tr>
    ${d.items.map((it) => `<tr><td>${it.review_symbol && it.needs_review ? `<span class="sym">(${it.review_symbol})</span>` : ''}</td>
      <td>${esc(it.name_original)}${it.name_normalized !== it.name_original ? ` <small>→ ${esc(it.name_normalized)}</small>` : ''} ${it.is_new_product ? '<span class="badge warn">NEW</span>' : ''} ${it.is_excess ? '<span class="badge warn">excess</span>' : ''}</td>
      <td>${it.quantity} ${esc(it.unit_text ?? '')}</td><td>${RM(it.unit_price)}</td><td>${RM(it.line_total)}</td>
      <td>${it.needs_review ? `<span class="badge warn">${t('needsReview')} [${it.confidence}]</span>` : `<span class="badge ok">✔</span>`}</td>
      <td>${it.needs_review ? `<button class="btn sec" data-confirm="${it.review_symbol}">${t('confirm')}</button>` : ''}</td></tr>`).join('')}</table>
    ${inv.status === 'in_review' ? `<p><button class="btn" id="ap">${t('approve')}</button> <button class="btn danger" id="rj">${t('reject')}</button></p>` : ''}</div>`));
  main.querySelectorAll('[data-confirm]').forEach((b) => b.onclick = async () => {
    try { await api(`/invoices/${id}/confirm-item`, { method: 'POST', body: { symbol: b.dataset.confirm } }); route(); } catch (e) { toast(e.message, false); }
  });
  const ap = main.querySelector('#ap');
  if (ap) ap.onclick = async () => {
    try { await api(`/invoices/${id}/approve`, { method: 'POST', body: { version: inv.version, discrepancy_note: main.querySelector('#discNote')?.value ?? null } }); toast('Approved ✔'); route(); }
    catch (e) { toast(e.ar ?? e.message, false); }
  };
  const rj = main.querySelector('#rj');
  if (rj) rj.onclick = async () => {
    try { await api(`/invoices/${id}/reject`, { method: 'POST', body: { reason: 'rejected via dashboard' } }); route(); } catch (e) { toast(e.message, false); }
  };
}

async function vRequests(main) {
  const d = await api('/requests');
  main.innerHTML = `<div class="card"><table class="tbl"><tr><th>${t('product')}</th><th>${t('qty')}</th><th>${t('branch')}</th><th>due</th></tr>
    ${d.items.map((r) => `<tr><td>${esc(r.product_name)}</td><td>${r.remaining_qty} / ${r.requested_qty}</td><td>${r.branch_id}</td><td>${esc(r.needed_by ?? '—')}${r.needed_by && r.needed_by < new Date().toISOString().slice(0, 10) ? ' ⚠' : ''}</td></tr>`).join('')}</table></div>`;
}

async function vProducts(main) {
  const q = '';
  const d = await api('/products');
  const cands = await api('/products/match-candidates').catch(() => ({ items: [] }));
  main.innerHTML = `<div class="card"><label class="f">${t('search')}</label><input id="pq" oninput="window.__pq && window.__pq()">
    <table class="tbl"><tr><th>${t('product')}</th><th>local</th><th>aliases</th><th>${t('branch')} category</th></tr>
    ${d.items.map((p) => `<tr><td>${esc(p.name_en)}</td><td>${esc(p.name_local ?? '')}</td><td>${esc((p.aliases ?? []).join(', '))}</td><td>${esc(p.category_name ?? '')}</td></tr>`).join('')}</table></div>
    <div class="card"><h3>Unify candidates</h3>
    ${cands.items.length ? `<table class="tbl"><tr><th>A</th><th>B</th><th>score</th><th></th></tr>${cands.items.map((c) => `<tr><td>${esc(c.aName)} (#${c.a})</td><td>${esc(c.bName)} (#${c.b})</td><td>${c.score}</td><td><button class="btn sec" data-unify="${c.a}:${c.b}">merge →A</button></td></tr>`).join('')}</table>` : '<i>none</i>'}</div>`;
  window.__pq = async () => { /* re-render on search */ };
  main.querySelectorAll('[data-unify]').forEach((b) => b.onclick = async () => {
    const [a, bi] = b.dataset.unify.split(':');
    try { await api('/products/unify', { method: 'POST', body: { keep_id: Number(a), merge_ids: [Number(bi)] } }); toast('unified'); route(); } catch (e) { toast(e.message, false); }
  });
}

async function vPrices(main) {
  const stores = (await api('/stores')).items;
  main.innerHTML = `<div class="card"><h3>${t('store')}s</h3><table class="tbl"><tr><th>name</th><th>trip cost</th><th>threshold</th></tr>
    ${stores.map((s) => `<tr><td>${esc(s.name)}</td><td>${RM(s.trip_cost)}</td><td>${RM(s.min_savings_threshold)}</td></tr>`).join('')}</table></div>
    <div class="card"><h3>Compare stores</h3>
    <label class="f">product ids</label><input id="cp" placeholder="1,2">
    <label class="f">store ids</label><input id="cs" placeholder="1,2">
    <p><button class="btn" id="cgo">Compare</button></p><div id="cout"></div></div>`;
  main.querySelector('#cgo').onclick = async () => {
    try {
      const r = await api(`/prices/compare?products=${cp.value}&stores=${cs.value}`);
      document.getElementById('cout').innerHTML = `<pre class="json">${esc(JSON.stringify(r, null, 1))}</pre>`;
    } catch (e) { toast(e.message, false); }
  };
}

async function vReports(main) {
  main.innerHTML = `<div class="card"><h3>${t('reports')}</h3>
    <label class="f">type</label><select id="rt">${['expenses_by_branch', 'expenses_by_category', 'excess_purchases', 'open_requests', 'quality_notes'].map((x) => `<option>${x}</option>`).join('')}</select>
    <label class="f">from</label><input id="rf" type="date"><label class="f">to</label><input id="rt2" type="date">
    <label class="f">lang</label><select id="rl"><option value="en">EN</option><option value="ar">AR (RTL)</option></select>
    <p><button class="btn sec" id="pv">Preview</button> <button class="btn" id="pdf">Export PDF</button> <button class="btn" id="xls">Export Excel</button></p>
    <div id="pout"></div></div>`;
  main.querySelector('#pv').onclick = async () => {
    const r = await api('/reports/preview', { method: 'POST', body: { type: rt.value, filters: { from: rf.value, to: rt2.value } } });
    document.getElementById('pout').innerHTML = `<pre class="json">${esc(JSON.stringify(r.rows ?? r, null, 1).slice(0, 3000))}</pre>`;
  };
  const exp = (format) => async () => {
    try {
      const r = await api('/reports/export', { method: 'POST', body: { type: rt.value, format, lang: rl.value, filters: { from: rf.value, to: rt2.value } } });
      window.open(r.link, '_blank');
    } catch (e) { toast(e.message, false); }
  };
  main.querySelector('#pdf').onclick = exp('pdf');
  main.querySelector('#xls').onclick = exp('xlsx');
}

async function vUsers(main) {
  const d = await api('/users');
  main.innerHTML = `<div class="card"><table class="tbl"><tr><th>id</th><th>${t('username')}</th><th>name</th><th>role</th><th>${t('branch')}</th><th>telegram</th><th>${t('status')}</th><th></th></tr>
    ${d.items.map((u) => `<tr><td>${u.id}</td><td>${esc(u.username ?? '')}</td><td>${esc(u.full_name)}</td><td>${u.role}</td><td>${u.branch_id ?? '—'}</td>
    <td>${u.telegram_id ? '✓' : `<button class="btn sec" data-pair="${u.id}">pair</button>`}</td>
    <td><span class="badge ${u.is_active ? 'ok' : 'bad'}">${u.is_active ? 'active' : 'inactive'}</span></td>
    <td><button class="btn sec" data-toggle="${u.id}:${u.is_active ? 0 : 1}">${u.is_active ? 'deactivate' : 'activate'}</button></td></tr>`).join('')}</table>
    <h3>${t('add')}</h3>
    <div class="grid g2"><div><label class="f">name</label><input id="nu_name"></div><div><label class="f">${t('username')}</label><input id="nu_user"></div>
    <div><label class="f">${t('password')}</label><input id="nu_pass"></div><div><label class="f">role</label>
    <select id="nu_role">${['owner', 'operations_manager', 'accountant', 'central_purchaser', 'branch_manager', 'employee'].map((r) => `<option>${r}</option>`).join('')}</select></div>
    <div><label class="f">${t('branch')} id</label><input id="nu_branch"></div></div>
    <p><button class="btn" id="nu_go">${t('add')}</button></p></div>`;
  main.querySelectorAll('[data-toggle]').forEach((b) => b.onclick = async () => {
    const [id, active] = b.dataset.toggle.split(':');
    try { await api(`/users/${id}`, { method: 'PATCH', body: { is_active: active === '1' } }); route(); } catch (e) { toast(e.message, false); }
  });
  main.querySelectorAll('[data-pair]').forEach((b) => b.onclick = async () => {
    try { const r = await api(`/users/${b.dataset.pair}/pair-code`, { method: 'POST' }); toast(`PAIR code: ${r.code} — user sends "PAIR ${r.code}" to the bot`); } catch (e) { toast(e.message, false); }
  });
  main.querySelector('#nu_go').onclick = async () => {
    try { await api('/users', { method: 'POST', body: { full_name: nu_name.value, username: nu_user.value || undefined, password: nu_pass.value || undefined, role: nu_role.value, branch_id: nu_branch.value ? Number(nu_branch.value) : null } }); route(); }
    catch (e) { toast(e.message, false); }
  };
}

async function vBranches(main) {
  const d = await api('/branches');
  main.innerHTML = `<div class="card"><table class="tbl"><tr><th>id</th><th>EN</th><th>AR</th><th>${t('status')}</th></tr>
    ${d.items.map((b2) => `<tr><td>${b2.id}</td><td>${esc(b2.name_en)}</td><td>${esc(b2.name_ar)}</td><td>${b2.is_active ? '✔' : '✖'}</td></tr>`).join('')}</table>
    <h3>${t('add')}</h3><div class="grid g2"><div><label class="f">EN</label><input id="bn"></div><div><label class="f">AR</label><input id="ba"></div></div>
    <p><button class="btn" id="bgo">${t('add')}</button></p></div>`;
  main.querySelector('#bgo').onclick = async () => { try { await api('/branches', { method: 'POST', body: { name_en: bn.value, name_ar: ba.value } }); route(); } catch (e) { toast(e.message, false); } };
}

async function vAI(main) {
  const q = await api('/ai/queue');
  const u = await api('/ai/usage');
  const s = await api('/ai/settings');
  main.innerHTML = `<div class="card"><h3>${t('queue')}</h3>
    <p>${t('usage')}: ${u.today}/${u.cap} (${u.pct}%) ⚠@${u.warnPct}% — per model: ${u.per_model.map((m) => `${m.model}:${m.count}`).join(', ') || '—'}</p>
    <table class="tbl"><tr><th>id</th><th>${t('taskType')}</th><th>invoice</th><th>${t('attempts')}</th><th>next</th><th>${t('lastErr')}</th><th>${t('status')}</th><th></th></tr>
    ${q.items.map((x) => `<tr><td>${x.id}</td><td>${x.task_type}</td><td>${x.invoice_id ?? '—'}</td><td>${x.attempts}/${x.max_attempts}</td><td>${esc(String(x.next_attempt_at).slice(0, 19))}</td><td>${esc((x.last_error ?? '').slice(0, 60))}</td>
    <td><span class="badge ${x.status === 'dead_letter' ? 'bad' : x.status === 'failed' ? 'warn' : 'ok'}">${x.status}</span></td>
    <td>${x.status === 'dead_letter' || x.status === 'failed' ? `<button class="btn sec" data-retry="${x.id}">${t('retry')}</button>` : ''}</td></tr>`).join('')}</table></div>
    <div class="card"><h3>${t('provider')}: ${s.provider} (key: ${s.hasKey ? '✓' : 'mock'})</h3>
    <div class="grid g2">
      <div><label class="f">daily global cap</label><input id="c1" value="${s.settings.ai_daily_global_cap}"></div>
      <div><label class="f">per-user cap</label><input id="c2" value="${s.settings.ai_daily_per_user_cap}"></div>
      <div><label class="f">burst/min</label><input id="c3" value="${s.settings.ai_burst_per_min}"></div>
      <div><label class="f">warn %</label><input id="c4" value="${s.settings.ai_warn_threshold_pct}"></div></div>
    <p><button class="btn" id="sv">${t('save')}</button> <button class="btn sec" id="tc">${t('testConn')} Gemini</button></p></div>`;
  main.querySelectorAll('[data-retry]').forEach((b) => b.onclick = async () => { await api(`/ai/queue/${b.dataset.retry}/retry`, { method: 'POST' }); route(); });
  main.querySelector('#sv').onclick = async () => {
    try { await api('/ai/settings', { method: 'PUT', body: { ai_daily_global_cap: Number(c1.value), ai_daily_per_user_cap: Number(c2.value), ai_burst_per_min: Number(c3.value), ai_warn_threshold_pct: Number(c4.value) } }); toast('saved'); }
    catch (e) { toast(e.message, false); }
  };
  main.querySelector('#tc').onclick = async () => { try { await api('/services/gemini/test', { method: 'POST' }); toast('Gemini ✔'); } catch (e) { toast(e.message, false); } };
}

async function vLogs(main) {
  const d = await api('/logs?limit=150');
  main.innerHTML = `<div class="card"><h3>${t('logs')}</h3>
    <table class="tbl"><tr><th>time</th><th>event</th><th>entity</th><th>actor</th><th>action</th></tr>
    ${d.items.map((l) => `<tr><td>${esc(String(l.created_at).slice(0, 19))}</td><td>${esc(l.event_type)}</td><td>${esc(l.entity_type)}#${l.entity_id ?? '—'}</td><td>${l.actor_type}${l.actor_id ? '#' + l.actor_id : ''}</td><td>${esc(l.action)}</td></tr>`).join('')}</table></div>`;
}

async function vBackup(main) {
  const d = await api('/backups');
  main.innerHTML = `<div class="card"><h3>${t('backup')}</h3>
    <p><button class="btn" id="mk">Create backup now</button></p>
    <table class="tbl"><tr><th>${t('date')}</th><th>size</th><th>sha256</th><th>${t('status')}</th><th></th></tr>
    ${d.items.map((b2) => `<tr><td>${esc(String(b2.created_at).slice(0, 19))}</td><td>${(b2.size_bytes / 1024).toFixed(1)} KB</td><td>${esc(String(b2.sha256).slice(0, 12))}…</td><td><span class="badge ok">${b2.status}</span></td><td><a href="/api/v1/backups/${b2.id}/download">download</a></td></tr>`).join('')}</table></div>`;
  main.querySelector('#mk').onclick = async () => { try { await api('/backups', { method: 'POST' }); toast('backup created'); route(); } catch (e) { toast(e.message, false); } };
}

async function vServices(main) {
  main.innerHTML = `<div class="card"><h3>${t('services')} — ${t('testConn')}</h3>
    <p><button class="btn sec" data-s="telegram">Telegram</button> <button class="btn sec" data-s="gemini">Gemini</button>
    <button class="btn sec" data-s="r2">R2</button> <button class="btn sec" data-s="neon">Neon</button></p>
    <p>current modes: <span id="modes"></span></p></div>`;
  const s = await api('/setup/status');
  main.querySelector('#modes').textContent = JSON.stringify(s.modes);
  main.querySelectorAll('[data-s]').forEach((b) => b.onclick = async () => {
    try { const r = await api(`/services/${b.dataset.s}/test`, { method: 'POST' }); toast(`${b.dataset.s}: ${JSON.stringify(r)}`); }
    catch (e) { toast(`${b.dataset.s}: ${e.message}`, false); }
  });
}

window.addEventListener('hashchange', route);
boot();
