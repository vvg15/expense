import { openDB, getAll, getAllMeta, writeBatch, wipeEverything } from './store.js';
import {
  SCHEMA_VERSION, PALETTE, defaultSettings, migrate, normalizeExpense, normalizeRule, normalizeSettings,
  buildBackup, parseImportText, toCSV,
} from './schema.js';
import { generateDue, nextDue, describe, monthlyEquivalent, occurrences } from './recurring.js';
import { pad, ymOf, isoDate, todayIso, parseIso, daysIn, shiftMonth, monthName, prettyDate, esc, uid, parseAmount, addDays } from './util.js';

const APP_VERSION = self.APP_VERSION || 'dev';
const GREY = '#9a9d94';
const CURRENCIES = [
  ['INR', 'Indian rupee', 'en-IN'], ['USD', 'US dollar', 'en-US'], ['EUR', 'Euro', 'en-IE'], ['GBP', 'British pound', 'en-GB'],
  ['AED', 'UAE dirham', 'en-AE'], ['SGD', 'Singapore dollar', 'en-SG'], ['AUD', 'Australian dollar', 'en-AU'],
  ['CAD', 'Canadian dollar', 'en-CA'], ['JPY', 'Japanese yen', 'ja-JP'], ['SAR', 'Saudi riyal', 'en-SA'],
];

// ─── State ───────────────────────────────────────────────────────────────────
const state = {
  settings: defaultSettings(),
  expenses: [],
  rules: [],
  meta: {},
  month: ymOf(new Date()),
  filterCat: 'all',
  search: '',
  view: 'home',
  editingId: null,
  editingRuleId: null,
  selCat: null,
  selRuleCat: null,
  lastDay: todayIso(),
};
let swReg = null;

const $ = (id) => document.getElementById(id);

// ─── Formatting ──────────────────────────────────────────────────────────────
const fmtCache = {};
function locale() { return (CURRENCIES.find((c) => c[0] === state.settings.currency) || CURRENCIES[0])[2]; }
function money(n, compact) {
  const key = state.settings.currency + (compact ? 'c' : '');
  if (!fmtCache[key]) {
    try {
      fmtCache[key] = new Intl.NumberFormat(locale(), compact
        ? { style: 'currency', currency: state.settings.currency, notation: 'compact', maximumFractionDigits: 1 }
        : { style: 'currency', currency: state.settings.currency, minimumFractionDigits: 0, maximumFractionDigits: 2 });
    } catch { fmtCache[key] = { format: (v) => `${state.settings.currency} ${Number(v).toFixed(2)}` }; }
  }
  return fmtCache[key].format(n || 0);
}
function resetFormats() { for (const k in fmtCache) delete fmtCache[k]; }
function symbolFor(code, loc) {
  try { return new Intl.NumberFormat(loc, { style: 'currency', currency: code }).formatToParts(0).find((p) => p.type === 'currency').value; }
  catch { return code; }
}
const currencySymbol = () => symbolFor(state.settings.currency, locale());
const catColor = (name) => (state.settings.categories.find((c) => c.name === name) || {}).color || GREY;
const sum = (list) => list.reduce((a, e) => a + (Number(e.amount) || 0), 0);
const ruleById = (id) => state.rules.find((r) => r.id === id);
const ruleName = (r) => r.note || r.category;

function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2600);
}

// ─── Generic dialog ──────────────────────────────────────────────────────────
function dialog({ title, html = '', actions = [{ label: 'OK', value: true, kind: 'primary' }], input = null }) {
  return new Promise((resolve) => {
    $('dlgTitle').textContent = title;
    $('dlgBody').innerHTML = html + (input ? `<input id="dlgInput" autocomplete="off" placeholder="${esc(input.placeholder || '')}">` : '');
    const box = $('dlgActions');
    box.innerHTML = '<span class="spacer"></span>';
    const done = (value) => {
      const inputValue = input ? $('dlgInput').value : undefined;
      $('dialog').hidden = true;
      document.removeEventListener('keydown', onKey);
      resolve({ value, inputValue });
    };
    const onKey = (e) => { if (e.key === 'Escape') done(null); };
    document.addEventListener('keydown', onKey);
    actions.forEach((a) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn ' + (a.kind || 'ghost'); b.textContent = a.label;
      b.onclick = () => done(a.value);
      box.appendChild(b);
    });
    $('dialog').onclick = (e) => { if (e.target === $('dialog')) done(null); };
    $('dialog').hidden = false;
    if (input) setTimeout(() => $('dlgInput').focus(), 50);
  });
}

// ─── Persistence helpers ─────────────────────────────────────────────────────
async function persist(batch) {
  try { await writeBatch(batch); return true; }
  catch (e) {
    console.error(e);
    const full = e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''));
    await dialog({ title: 'Couldn’t save', html: `<p>${full ? 'Your phone is out of storage space for this app.' : 'Something went wrong while saving.'}</p><p class="muted small">${esc(e && e.message || '')}</p>` });
    return false;
  }
}
async function saveSettings() {
  if (await persist({ meta: { settings: state.settings } })) { resetFormats(); renderAll(); }
}
function upsertLocal(listName, items) {
  const map = new Map(state[listName].map((x) => [x.id, x]));
  items.forEach((x) => map.set(x.id, x));
  state[listName] = [...map.values()];
}

/** Add any due recurring payments. Returns how many were added. */
async function runRecurring() {
  const { expenses, rules } = generateDue(state.rules);
  if (!rules.length) return 0;
  // Don't resurrect expenses the user has already got under the same id.
  const have = new Set(state.expenses.map((e) => e.id));
  const fresh = expenses.filter((e) => !have.has(e.id));
  if (!(await persist({ expenses: fresh, recurring: rules }))) return 0;
  upsertLocal('expenses', fresh);
  upsertLocal('rules', rules);
  addMissingCategories(fresh.map((e) => e.category));
  return fresh.length;
}

function addMissingCategories(names) {
  const have = new Set(state.settings.categories.map((c) => c.name));
  const missing = [...new Set(names)].filter((n) => n && !have.has(n));
  if (!missing.length) return false;
  const used = new Set(state.settings.categories.map((c) => c.color));
  missing.forEach((name, i) => {
    const color = PALETTE.find((p) => !used.has(p)) || PALETTE[(state.settings.categories.length + i) % PALETTE.length];
    used.add(color);
    state.settings.categories.push({ name, color });
  });
  writeBatch({ meta: { settings: state.settings } }).catch(console.error);
  return true;
}

// ─── Boot ────────────────────────────────────────────────────────────────────
async function boot() {
  try {
    await openDB();
    const [expenses, rules, meta] = await Promise.all([getAll('expenses'), getAll('recurring'), getAllMeta()]);
    state.meta = meta;
    const stored = Number(meta.schemaVersion) || 0;

    if (!stored) {
      // First launch on this device.
      state.settings = normalizeSettings(meta.settings);
      state.expenses = expenses.map(normalizeExpense).filter(Boolean);
      state.rules = rules.map(normalizeRule).filter(Boolean);
      await writeBatch({ meta: { schemaVersion: SCHEMA_VERSION, settings: state.settings, installedAt: Date.now() } });
      state.meta.schemaVersion = SCHEMA_VERSION;
    } else if (stored < SCHEMA_VERSION) {
      // App was updated and the data format changed: upgrade data in place,
      // keeping a safety copy of the old data inside the database.
      const old = { settings: meta.settings, expenses, recurring: rules };
      const up = migrate(old, stored);
      state.settings = normalizeSettings(up.settings);
      state.expenses = (up.expenses || []).map(normalizeExpense).filter(Boolean);
      state.rules = (up.recurring || []).map(normalizeRule).filter(Boolean);
      await writeBatch({
        clear: true, expenses: state.expenses, recurring: state.rules,
        meta: { schemaVersion: SCHEMA_VERSION, settings: state.settings, [`preUpgradeBackup_v${stored}`]: { schemaVersion: stored, savedAt: Date.now(), data: old } },
      });
    } else {
      state.settings = normalizeSettings(meta.settings);
      state.expenses = expenses.map(normalizeExpense).filter(Boolean);
      state.rules = rules.map(normalizeRule).filter(Boolean);
    }

    const added = await runRecurring();
    const quickAdd = location.hash === '#add';
    if (quickAdd) history.replaceState(null, '', '#home');
    route();
    renderAll();
    if (quickAdd) openExpense(null);
    if (added) toast(`Added ${added} recurring payment${added === 1 ? '' : 's'}`);
  } catch (e) {
    console.error(e);
    document.querySelector('.app').innerHTML = `<div class="panel" style="margin-top:40px"><h2>Couldn’t open your data</h2><p class="small" style="margin-top:8px">${esc(e.message || e)}</p><p class="muted small" style="margin-top:8px">If you’re in a private/incognito window, open the app normally instead.</p></div>`;
    return;
  }

  // Ask the browser not to auto-clear our storage.
  try { if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch {}

  // New day while the app stayed open → add recurring payments, refresh "today".
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    if (swReg) swReg.update().catch(() => {});
    if (todayIso() !== state.lastDay) {
      const wasCurrent = state.month === ymOf(parseIso(state.lastDay));
      state.lastDay = todayIso();
      if (wasCurrent) state.month = ymOf(new Date());
      const added = await runRecurring();
      renderAll();
      if (added) toast(`Added ${added} recurring payment${added === 1 ? '' : 's'}`);
    }
  });

  registerSW();
}

// ─── Service worker / updates ────────────────────────────────────────────────
function registerSW() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    swReg = reg;
    reg.update().catch(() => {});
    if (reg.waiting && navigator.serviceWorker.controller) showUpdate();
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w && w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdate(); });
    });
  }).catch(console.error);
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloading) { reloading = true; location.reload(); } });
}
function showUpdate() { $('updateBar').hidden = false; }
$('updateBtn').addEventListener('click', () => {
  if (swReg && swReg.waiting) swReg.waiting.postMessage({ type: 'SKIP_WAITING' });
  else location.reload();
});
$('checkUpdate').addEventListener('click', async () => {
  if (!swReg) { toast('Updates work once the app is installed from its web address'); return; }
  try {
    await swReg.update();
    setTimeout(() => { if (swReg.waiting || swReg.installing) showUpdate(); else toast(`You’re on the latest version (${APP_VERSION})`); }, 1500);
  } catch { toast('Couldn’t check for updates — are you offline?'); }
});

// ─── Routing ─────────────────────────────────────────────────────────────────
function route() {
  const v = (location.hash || '#home').slice(1);
  state.view = ['home', 'recurring', 'settings'].includes(v) ? v : 'home';
  ['home', 'recurring', 'settings'].forEach((n) => ($('view-' + n).hidden = n !== state.view));
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === state.view));
  $('fab').hidden = state.view === 'settings';
  $('fab').setAttribute('aria-label', state.view === 'recurring' ? 'Add recurring payment' : 'Add expense');
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => { route(); renderAll(); });

// ─── Rendering ───────────────────────────────────────────────────────────────
function renderAll() {
  $('logo').textContent = currencySymbol().slice(0, 2);
  document.querySelectorAll('.cur-sym').forEach((el) => (el.textContent = currencySymbol()));
  if (state.view === 'home') renderHome();
  if (state.view === 'recurring') renderRecurring();
  if (state.view === 'settings') renderSettings();
}

const monthExpenses = (ym) => state.expenses.filter((e) => e.date.startsWith(ym));

function renderHome() {
  $('monthLabel').textContent = monthName(state.month);
  renderBackupNudge(); renderCards(); renderCategories(); renderDaily(); renderFilterOptions(); renderList();
}

function daysSince(ts) { return ts ? Math.floor((Date.now() - ts) / 86400000) : Infinity; }

function renderBackupNudge() {
  const el = $('backupNudge');
  const d = daysSince(state.meta.lastBackupAt);
  if (state.expenses.length >= 10 && d > 30) {
    el.innerHTML = `<span>${d === Infinity ? 'You haven’t backed up yet.' : `Last backup was ${d} days ago.`} Your data lives only on this phone.</span><a class="linkish" href="#settings">Back up</a>`;
    el.hidden = false;
  } else el.hidden = true;
}

function renderCards() {
  const ym = state.month, cur = ymOf(new Date());
  const list = monthExpenses(ym);
  const total = sum(list);
  const prevTotal = sum(monthExpenses(shiftMonth(ym, -1)));
  const dim = daysIn(ym);
  const elapsed = ym === cur ? new Date().getDate() : ym < cur ? dim : 0;
  const avg = elapsed ? Math.round(total / elapsed) : 0;
  const budget = state.settings.budget;

  let budgetCard;
  if (budget > 0) {
    const left = budget - total, pct = Math.min(100, (total / budget) * 100);
    const cls = left < 0 ? 'over' : pct >= 85 ? 'warn' : '';
    budgetCard = `<div class="card"><div class="label">${left < 0 ? 'Over budget' : 'Budget left'}</div>
      <div class="value num ${left < 0 ? 'over' : ''}">${money(Math.abs(left))}</div>
      <div class="progress ${cls}"><span style="width:${pct}%"></span></div>
      <div class="sub num">${Math.round((total / budget) * 100)}% of ${money(budget)}</div></div>`;
  } else {
    budgetCard = `<div class="card"><div class="label">Budget</div><div class="value" style="font-size:17px;color:var(--ink-3)">Not set</div>
      <div class="sub"><a class="linkish" href="#settings">Set a budget →</a></div></div>`;
  }

  let paceSub;
  if (ym === cur) {
    const projected = Math.round((elapsed ? total / elapsed : 0) * dim);
    paceSub = `On pace for <b class="num">${money(projected)}</b>`;
    if (budget > 0 && projected > budget && total <= budget) paceSub += ` <span class="up">· over budget</span>`;
  } else paceSub = ym < cur ? `Across ${dim} days` : 'Month hasn’t started';

  let cmp = '—', cmpSub = `Last month ${money(prevTotal)}`;
  if (prevTotal > 0) {
    const d = ((total - prevTotal) / prevTotal) * 100;
    cmp = `<span class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(0)}%</span>`;
  } else if (total > 0) cmpSub = 'Nothing last month';

  $('cards').innerHTML = `
    <div class="card"><div class="label">Spent</div><div class="value num">${money(total)}</div><div class="sub">${list.length} expense${list.length === 1 ? '' : 's'}</div></div>
    ${budgetCard}
    <div class="card"><div class="label">Daily average</div><div class="value num">${money(avg)}</div><div class="sub">${paceSub}</div></div>
    <div class="card"><div class="label">vs last month</div><div class="value num">${cmp}</div><div class="sub num">${cmpSub}</div></div>`;
}

function renderCategories() {
  const list = monthExpenses(state.month);
  if (!list.length) { $('catBreakdown').innerHTML = '<div class="empty">No expenses this month yet.</div>'; return; }
  const total = sum(list), by = {};
  list.forEach((e) => (by[e.category] = (by[e.category] || 0) + Number(e.amount)));
  const rows = Object.entries(by).sort((a, b) => b[1] - a[1]);
  const max = rows[0][1];
  $('catBreakdown').innerHTML = rows.map(([name, amt]) => `
    <button class="cat-row ${state.filterCat === name ? 'active' : ''}" data-cat="${esc(name)}">
      <span class="cat-name"><span class="dot" style="background:${catColor(name)}"></span>${esc(name)}</span>
      <span class="cat-amt num">${money(amt)}<small>${Math.round((amt / total) * 100)}%</small></span>
      <span class="bar"><span style="width:${(amt / max) * 100}%;background:${catColor(name)}"></span></span>
    </button>`).join('');
}

function renderDaily() {
  const ym = state.month, dim = daysIn(ym), cur = ymOf(new Date());
  const list = monthExpenses(ym);
  const days = new Array(dim).fill(0);
  list.forEach((e) => { const d = Number(e.date.slice(8, 10)); if (d >= 1 && d <= dim) days[d - 1] += Number(e.amount); });
  const budget = state.settings.budget, dailyBudget = budget > 0 ? budget / dim : 0;
  const maxDay = Math.max(...days);
  $('dailyHint').textContent = maxDay > 0 ? `Peak ${money(maxDay)} on ${days.indexOf(maxDay) + 1} ${monthName(ym, { month: 'short' })}` : '';
  if (!list.length) { $('dailyChart').innerHTML = '<div class="empty">Your daily spending will show up here.</div>'; return; }

  const W = 620, H = 200, padL = 50, padR = 8, padT = 12, padB = 24, cw = W - padL - padR, ch = H - padT - padB;
  const top = Math.max(maxDay, dailyBudget), yMax = top * 1.12 || 1;
  const step = cw / dim, bw = Math.max(3, step * 0.66);
  const y = (v) => padT + ch - (v / yMax) * ch;
  const todayIdx = ym === cur ? new Date().getDate() - 1 : -1;
  const mon = monthName(ym, { month: 'short' });
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily spending">`;
  [0, 0.5, 1].forEach((t) => {
    const val = top * t, yy = y(val);
    svg += `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}"/><text class="axis" x="${padL - 8}" y="${yy + 4}" text-anchor="end">${esc(money(val, true))}</text>`;
  });
  days.forEach((v, i) => {
    const x = padL + i * step + (step - bw) / 2;
    const future = ym > cur || (ym === cur && i > todayIdx);
    if (v > 0) {
      const h = Math.max(2, (v / yMax) * ch);
      const cls = 'bar-rect' + (i === todayIdx ? ' today' : '') + (dailyBudget && v > dailyBudget ? ' over' : '');
      svg += `<rect class="${cls}" x="${x}" y="${padT + ch - h}" width="${bw}" height="${h}" rx="2"><title>${i + 1} ${esc(mon)}: ${esc(money(v))}</title></rect>`;
    } else if (!future) svg += `<rect class="zero" x="${x}" y="${padT + ch - 2}" width="${bw}" height="2" rx="1"/>`;
    const d = i + 1;
    if (d === 1 || d % 5 === 0) svg += `<text class="axis" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${d}</text>`;
  });
  if (dailyBudget) svg += `<line class="budget-line" x1="${padL}" x2="${W - padR}" y1="${y(dailyBudget)}" y2="${y(dailyBudget)}"/>`;
  svg += '</svg>';
  if (dailyBudget) svg += `<div class="legend"><span><i></i>Daily budget (${esc(money(dailyBudget))})</span></div>`;
  $('dailyChart').innerHTML = svg;
}

function renderFilterOptions() {
  const names = new Set(state.settings.categories.map((c) => c.name));
  monthExpenses(state.month).forEach((e) => names.add(e.category));
  const html = '<option value="all">All categories</option>' + [...names].map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  const sel = $('catFilter');
  if (sel._html !== html) { sel.innerHTML = html; sel._html = html; }
  if (state.filterCat !== 'all' && !names.has(state.filterCat)) state.filterCat = 'all';
  sel.value = state.filterCat;
}

function renderList() {
  const all = monthExpenses(state.month);
  const q = state.search.trim().toLowerCase();
  const rows = all
    .filter((e) => state.filterCat === 'all' || e.category === state.filterCat)
    .filter((e) => !q || [e.note, e.category, e.method, String(e.amount)].some((f) => String(f || '').toLowerCase().includes(q)))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
  const box = $('txList');
  if (!all.length) {
    box.innerHTML = `<div class="empty">No expenses in ${esc(monthName(state.month))}.<br><br><button class="btn primary" data-action="add">+ Add an expense</button></div>`;
    return;
  }
  if (!rows.length) { box.innerHTML = '<div class="empty">Nothing matches your filter. <button class="linkish" data-action="clear">Clear filter</button></div>'; return; }

  const groups = [];
  rows.forEach((e) => { const g = groups[groups.length - 1]; if (g && g.date === e.date) g.items.push(e); else groups.push({ date: e.date, items: [e] }); });
  const t = todayIso(), yd = addDays(t, -1);
  const label = (d) => (d === t ? 'Today' : d === yd ? 'Yesterday' : d > t ? prettyDate(d, { weekday: 'short', day: 'numeric', month: 'short' }) + ' · upcoming' : prettyDate(d, { weekday: 'short', day: 'numeric', month: 'short' }));

  let html = groups.map((g) => `
    <div class="day-group">
      <div class="day-head"><span>${esc(label(g.date))}</span><span class="num">${money(sum(g.items))}</span></div>
      ${g.items.map((e) => {
        const meta = [e.note ? esc(e.category) : '', esc(e.method), e.recurringId ? 'Recurring' : ''].filter(Boolean).join(' · ');
        return `<button class="tx" data-id="${esc(e.id)}">
          <span class="tx-icon" style="background:${catColor(e.category)}">${esc((e.category || '?').slice(0, 1).toUpperCase())}${e.recurringId ? '<span class="rec">↻</span>' : ''}</span>
          <span class="tx-main"><div class="tx-title">${esc(e.note || e.category)}</div><div class="tx-meta">${meta}</div></span>
          <span class="tx-amt num">${money(e.amount)}</span>
        </button>`;
      }).join('')}
    </div>`).join('');
  const filtered = state.filterCat !== 'all' || q;
  html += `<div class="list-foot"><span>${filtered ? `Showing ${rows.length} of ${all.length} <button class="linkish" data-action="clear" style="margin-left:6px">Clear</button>` : `${all.length} expense${all.length === 1 ? '' : 's'}`}</span><b class="num">${money(sum(rows))}</b></div>`;
  box.innerHTML = html;
}

function renderRecurring() {
  const rules = state.rules.slice().sort((a, b) => (b.active - a.active) || (nextDue(a) || '9999').localeCompare(nextDue(b) || '9999'));
  const active = rules.filter((r) => r.active && nextDue(r));
  const monthly = active.reduce((a, r) => a + monthlyEquivalent(r), 0);
  const upcoming = active.map((r) => ({ r, d: nextDue(r) })).filter((x) => x.d <= addDays(todayIso(), 30));
  $('ruleSummary').innerHTML = `
    <div class="card"><div class="label">Per month</div><div class="value num">${money(Math.round(monthly))}</div><div class="sub">${active.length} active payment${active.length === 1 ? '' : 's'}</div></div>
    <div class="card"><div class="label">Next 30 days</div><div class="value num">${money(sum(upcoming.map((x) => x.r)))}</div><div class="sub">${upcoming.length} due</div></div>`;

  if (!rules.length) {
    $('ruleList').innerHTML = '<div class="empty">No recurring payments yet.<br><br><button class="btn primary" data-action="add-rule">+ Add recurring payment</button></div>';
    return;
  }
  $('ruleList').innerHTML = rules.map((r) => {
    const nd = nextDue(r);
    const status = !r.active ? '<span class="badge paused">Paused</span>' : !nd ? '<span class="badge">Ended</span>' : '';
    const sub = [describe(r), r.method].join(' · ');
    const right = nd ? `<small>Next ${esc(prettyDate(nd, { day: 'numeric', month: 'short' }))}</small>` : '';
    return `<button class="tx" data-rule="${esc(r.id)}">
      <span class="tx-icon" style="background:${catColor(r.category)}">${esc(r.category.slice(0, 1).toUpperCase())}</span>
      <span class="tx-main"><div class="tx-title">${esc(ruleName(r))} ${status}</div><div class="tx-meta">${esc(sub)}</div></span>
      <span class="tx-amt num">${money(r.amount)}${right}</span>
    </button>`;
  }).join('');
}

function renderSettings() {
  const sel = $('sCurrency');
  if (!sel.options.length) sel.innerHTML = CURRENCIES.map(([c, n, l]) => `<option value="${c}">${esc(symbolFor(c, l))} · ${esc(n)}</option>`).join('');
  sel.value = state.settings.currency;
  if (document.activeElement !== $('sBudget')) $('sBudget').value = state.settings.budget || '';

  $('sCats').innerHTML = state.settings.categories.map((c, i) => `<span class="cat-pill"><span class="dot" style="background:${c.color}"></span>${esc(c.name)}<button type="button" data-remove-cat="${i}" aria-label="Remove ${esc(c.name)}">×</button></span>`).join('');

  const d = daysSince(state.meta.lastBackupAt);
  $('backupInfo').textContent = d === Infinity ? 'No backup made from this phone yet.' : `Last backup: ${new Date(state.meta.lastBackupAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}${d > 0 ? ` (${d} day${d === 1 ? '' : 's'} ago)` : ''}.`;
  $('shareJson').hidden = !(navigator.canShare && navigator.canShare({ files: [new File(['{}'], 'x.json', { type: 'application/json' })] }));

  $('storageInfo').innerHTML = `${state.expenses.length} expenses · ${state.rules.length} recurring payments, stored on this device.<br><span class="muted" id="persistInfo"></span>`;
  (async () => {
    try {
      const p = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
      const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
      const used = est && est.usage ? ` · using ${(est.usage / 1024 / 1024).toFixed(1)} MB` : '';
      $('persistInfo') && ($('persistInfo').textContent = (p ? 'Protected from automatic clean-up' : 'Install the app to protect data from automatic clean-up') + used + '.');
    } catch {}
  })();
  $('aboutInfo').innerHTML = `Expense Manager <b>v${esc(APP_VERSION)}</b> · data format v${SCHEMA_VERSION}<br><span class="muted">Works offline. Nothing leaves your phone unless you export it.</span>`;
}

// ─── Expense sheet ───────────────────────────────────────────────────────────
function chipsHtml(selected) {
  const cats = state.settings.categories.slice();
  if (selected && !cats.some((c) => c.name === selected)) cats.push({ name: selected, color: GREY });
  return cats.map((c) => `<button type="button" class="chip ${c.name === selected ? 'selected' : ''}" data-chip="${esc(c.name)}"><span class="dot" style="background:${c.color}"></span>${esc(c.name)}</button>`).join('');
}
function methodOptions(selected) {
  const ms = state.settings.methods.slice();
  if (selected && !ms.includes(selected)) ms.push(selected);
  return ms.map((m) => `<option ${m === selected ? 'selected' : ''}>${esc(m)}</option>`).join('');
}
function lastMethod() { try { return localStorage.getItem('em.method') || state.settings.methods[0]; } catch { return state.settings.methods[0]; } }
function rememberMethod(m) { try { localStorage.setItem('em.method', m); } catch {} }
// Sheets push a history entry so Android's back button closes them instead of the app.
const sheetOpen = () => !$('expenseModal').hidden || !$('ruleModal').hidden;
function hideSheets() { $('expenseModal').hidden = true; $('ruleModal').hidden = true; }
function showSheet(id) {
  $(id).hidden = false;
  if (!(history.state && history.state.sheet)) history.pushState({ sheet: true }, '');
}
function closeSheets() {
  const wasOpen = sheetOpen();
  hideSheets();
  if (wasOpen && history.state && history.state.sheet) history.back();
}

function openExpense(id) {
  const e = id ? state.expenses.find((x) => x.id === id) : null;
  state.editingId = e ? e.id : null;
  $('expTitle').textContent = e ? 'Edit expense' : 'Add expense';
  $('fAmount').value = e ? e.amount : '';
  const cur = ymOf(new Date());
  $('fDate').value = e ? e.date : state.month === cur ? todayIso() : state.month < cur ? `${state.month}-${pad(daysIn(state.month))}` : `${state.month}-01`;
  $('fMethod').innerHTML = methodOptions(e ? e.method : lastMethod());
  $('fNote').value = e ? e.note : '';
  state.selCat = e ? e.category : state.filterCat !== 'all' ? state.filterCat : state.settings.categories[0]?.name || 'Other';
  $('fCats').innerHTML = chipsHtml(state.selCat);
  $('fRepeat').value = '';
  $('fRepeatWrap').hidden = !!e;
  const r = e && e.recurringId ? ruleById(e.recurringId) : null;
  $('fRecNote').hidden = !(e && e.recurringId);
  if (e && e.recurringId) {
    $('fRecNote').innerHTML = r
      ? `↻ Added automatically by “${esc(ruleName(r))}”. Changes here affect only this one. <button type="button" class="linkish" data-edit-rule="${esc(r.id)}">Edit the recurring payment</button>`
      : '↻ Added by a recurring payment that has since been deleted.';
  }
  $('fError').textContent = '';
  const del = $('fDelete'); del.hidden = !e; del.classList.remove('armed'); del.textContent = 'Delete';
  hideSheets();
  showSheet('expenseModal');
  if (!e) setTimeout(() => $('fAmount').focus(), 60);
}

$('fCats').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-chip]'); if (!b) return;
  state.selCat = b.dataset.chip; $('fCats').innerHTML = chipsHtml(state.selCat);
});

$('expenseForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const amount = parseAmount($('fAmount').value), date = $('fDate').value;
  if (!(amount > 0)) { $('fError').textContent = 'Enter an amount greater than zero.'; $('fAmount').focus(); return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { $('fError').textContent = 'Pick a date.'; return; }
  const method = $('fMethod').value, note = $('fNote').value.trim().slice(0, 120), category = state.selCat || 'Other';
  rememberMethod(method);
  const repeat = $('fRepeat').value;
  const existing = state.editingId ? state.expenses.find((x) => x.id === state.editingId) : null;

  if (!existing && repeat) {
    // A repeating expense is stored as a rule; the generator creates the dated entries.
    const rule = normalizeRule({ id: uid('r'), amount, category, method, note, frequency: repeat, interval: 1, startDate: date, active: true });
    if (!(await persist({ recurring: [rule] }))) return;
    upsertLocal('rules', [rule]);
    closeSheets();
    const added = await runRecurring();
    if (!date.startsWith(state.month)) state.month = date.slice(0, 7);
    renderAll();
    toast(added ? `Saved · repeats ${repeat === 'weekly' ? 'weekly' : repeat === 'yearly' ? 'yearly' : 'monthly'}` : `Recurring payment set · first on ${prettyDate(date)}`);
    return;
  }

  const now = Date.now();
  const exp = normalizeExpense({ ...(existing || {}), id: existing ? existing.id : uid('e'), amount, date, category, method, note, createdAt: existing ? existing.createdAt : now, updatedAt: now });
  if (!(await persist({ expenses: [exp] }))) return;
  upsertLocal('expenses', [exp]);
  closeSheets();
  if (!date.startsWith(state.month)) state.month = date.slice(0, 7);
  renderAll();
  toast(existing ? 'Expense updated' : `Added ${money(amount)} · ${category}`);
});

$('fDelete').addEventListener('click', async () => {
  const del = $('fDelete');
  if (!del.classList.contains('armed')) { del.classList.add('armed'); del.textContent = 'Tap again to delete'; return; }
  const id = state.editingId;
  if (!(await persist({ deleteExpenses: [id] }))) return;
  state.expenses = state.expenses.filter((e) => e.id !== id);
  closeSheets(); renderAll(); toast('Expense deleted');
});

// ─── Recurring sheet ─────────────────────────────────────────────────────────
const UNIT = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' };

function readRuleForm() {
  return {
    amount: parseAmount($('rAmount').value),
    note: $('rNote').value.trim().slice(0, 120),
    frequency: $('rFreq').value,
    interval: Math.max(1, Math.min(365, parseInt($('rInterval').value, 10) || 1)),
    startDate: $('rStart').value,
    endDate: $('rEnd').value || null,
    method: $('rMethod').value,
    active: $('rActive').value === '1',
    category: state.selRuleCat || 'Other',
  };
}

function updateRulePreview() {
  const f = readRuleForm();
  const n = f.interval;
  $('rUnit').textContent = UNIT[f.frequency] + (n === 1 ? '' : 's');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.startDate)) { $('rPreview').textContent = ''; return; }
  const existing = state.editingRuleId ? ruleById(state.editingRuleId) : null;
  const probe = normalizeRule({ ...f, amount: f.amount > 0 ? f.amount : 1, lastGenerated: existing ? existing.lastGenerated : null });
  if (!probe) { $('rPreview').textContent = ''; return; }
  const parts = [describe(probe)];
  const nd = nextDue(probe);
  if (!existing) {
    const past = occurrences(probe, todayIso()).length;
    if (past) parts.push(`${past} payment${past === 1 ? '' : 's'} up to today will be added`);
    else if (nd) parts.push(`first on ${prettyDate(nd)}`);
  } else if (nd) parts.push(`next on ${prettyDate(nd)}`);
  else if (probe.active) parts.push('no more payments (end date passed)');
  if (f.amount > 0) parts.push(`≈ ${money(Math.round(monthlyEquivalent(probe)))}/month`);
  $('rPreview').textContent = parts.join(' · ');
}

function openRule(id) {
  const r = id ? ruleById(id) : null;
  state.editingRuleId = r ? r.id : null;
  $('ruleTitle').textContent = r ? 'Edit recurring payment' : 'Add recurring payment';
  $('rAmount').value = r ? r.amount : '';
  $('rNote').value = r ? r.note : '';
  $('rFreq').value = r ? r.frequency : 'monthly';
  $('rInterval').value = r ? r.interval : 1;
  $('rStart').value = r ? r.startDate : todayIso();
  $('rStart').disabled = !!(r && r.lastGenerated);
  $('rEnd').value = r && r.endDate ? r.endDate : '';
  $('rMethod').innerHTML = methodOptions(r ? r.method : lastMethod());
  $('rActive').value = !r || r.active ? '1' : '0';
  state.selRuleCat = r ? r.category : 'Bills & utilities';
  if (!state.settings.categories.some((c) => c.name === state.selRuleCat) && !r) state.selRuleCat = state.settings.categories[0]?.name || 'Other';
  $('rCats').innerHTML = chipsHtml(state.selRuleCat);
  $('rError').textContent = '';
  $('rDelete').hidden = !r;
  updateRulePreview();
  hideSheets();
  showSheet('ruleModal');
  if (!r) setTimeout(() => $('rAmount').focus(), 60);
}

['rAmount', 'rFreq', 'rInterval', 'rStart', 'rEnd', 'rActive'].forEach((id) => $(id).addEventListener('input', updateRulePreview));
$('rCats').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-chip]'); if (!b) return;
  state.selRuleCat = b.dataset.chip; $('rCats').innerHTML = chipsHtml(state.selRuleCat);
});

$('ruleForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = readRuleForm();
  if (!(f.amount > 0)) { $('rError').textContent = 'Enter an amount greater than zero.'; return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.startDate)) { $('rError').textContent = 'Pick the date of the first payment.'; return; }
  if (f.endDate && f.endDate < f.startDate) { $('rError').textContent = 'The end date is before the first payment.'; return; }
  const existing = state.editingRuleId ? ruleById(state.editingRuleId) : null;
  const rule = normalizeRule({ ...(existing || {}), ...f, id: existing ? existing.id : uid('r'), lastGenerated: existing ? existing.lastGenerated : null, createdAt: existing ? existing.createdAt : Date.now(), updatedAt: Date.now() });
  rememberMethod(f.method);
  if (!(await persist({ recurring: [rule] }))) return;
  upsertLocal('rules', [rule]);
  closeSheets();
  const added = await runRecurring();
  renderAll();
  toast(existing ? 'Recurring payment updated' : added ? `Saved · added ${added} payment${added === 1 ? '' : 's'} so far` : 'Recurring payment saved');
});

$('rDelete').addEventListener('click', async () => {
  const r = ruleById(state.editingRuleId); if (!r) return;
  const past = state.expenses.filter((e) => e.recurringId === r.id);
  const { value } = await dialog({
    title: `Delete “${ruleName(r)}”?`,
    html: `<p>No more payments will be added.</p>${past.length ? `<p>It has already added <b>${past.length}</b> expense${past.length === 1 ? '' : 's'} (${esc(money(sum(past)))}). Keep them in your history?</p>` : ''}`,
    actions: past.length
      ? [{ label: 'Cancel', value: null }, { label: 'Delete all', value: 'all', kind: 'ghost danger' }, { label: 'Keep history', value: 'keep', kind: 'primary' }]
      : [{ label: 'Cancel', value: null }, { label: 'Delete', value: 'keep', kind: 'danger solid' }],
  });
  if (!value) return;
  const delExp = value === 'all' ? past.map((e) => e.id) : [];
  if (!(await persist({ deleteRecurring: [r.id], deleteExpenses: delExp }))) return;
  state.rules = state.rules.filter((x) => x.id !== r.id);
  if (delExp.length) { const s = new Set(delExp); state.expenses = state.expenses.filter((e) => !s.has(e.id)); }
  closeSheets(); renderAll(); toast('Recurring payment deleted');
});

// ─── Settings actions ────────────────────────────────────────────────────────
$('sCurrency').addEventListener('change', (e) => { state.settings.currency = e.target.value; saveSettings(); });
$('sBudget').addEventListener('change', (e) => {
  const raw = e.target.value.trim(), v = raw ? parseAmount(raw) : 0;
  if (raw && !(v >= 0)) { toast('Enter a valid amount'); return; }
  state.settings.budget = v || 0; saveSettings(); toast(v ? `Budget set to ${money(v)}` : 'Budget removed');
});
$('addCatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('sNewCat').value.trim().slice(0, 30);
  if (!name) return;
  if (state.settings.categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) { toast('That category already exists'); return; }
  const used = new Set(state.settings.categories.map((c) => c.color));
  state.settings.categories.push({ name, color: PALETTE.find((p) => !used.has(p)) || PALETTE[state.settings.categories.length % PALETTE.length] });
  $('sNewCat').value = ''; saveSettings();
});
$('sCats').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-remove-cat]'); if (!b) return;
  if (state.settings.categories.length <= 1) { toast('Keep at least one category'); return; }
  const cat = state.settings.categories[Number(b.dataset.removeCat)];
  const n = state.expenses.filter((x) => x.category === cat.name).length;
  if (n) {
    const { value } = await dialog({ title: `Remove “${cat.name}”?`, html: `<p>${n} expense${n === 1 ? '' : 's'} use this category. They’ll be kept and shown in grey.</p>`, actions: [{ label: 'Cancel', value: false }, { label: 'Remove', value: true, kind: 'danger solid' }] });
    if (!value) return;
  }
  state.settings.categories = state.settings.categories.filter((c) => c !== cat);
  saveSettings();
});

// ─── Export / import ─────────────────────────────────────────────────────────
function stamp() { const d = new Date(); return `${isoDate(d)}_${pad(d.getHours())}${pad(d.getMinutes())}`; }
function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function backupBlob() {
  const data = buildBackup({ settings: state.settings, expenses: state.expenses, recurring: state.rules });
  return new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
}
async function markBackedUp() {
  state.meta.lastBackupAt = Date.now();
  await writeBatch({ meta: { lastBackupAt: state.meta.lastBackupAt } }).catch(console.error);
  renderAll();
}
$('exportJson').addEventListener('click', async () => {
  downloadBlob(backupBlob(), `expenses-backup_${stamp()}.json`);
  await markBackedUp();
  toast('Backup saved to Downloads');
});
$('shareJson').addEventListener('click', async () => {
  const file = new File([backupBlob()], `expenses-backup_${stamp()}.json`, { type: 'application/json' });
  try { await navigator.share({ files: [file], title: 'Expense Manager backup' }); await markBackedUp(); }
  catch (e) { if (e && e.name !== 'AbortError') toast('Sharing isn’t available — use Export instead'); }
});
$('exportCsv').addEventListener('click', () => {
  if (!state.expenses.length) { toast('No expenses to export yet'); return; }
  downloadBlob(new Blob([toCSV(state.expenses, state.settings.currency, state.rules)], { type: 'text/csv' }), `expenses_${stamp()}.csv`);
  toast('Spreadsheet saved to Downloads');
});
$('importBtn').addEventListener('click', () => { $('importFile').value = ''; $('importFile').click(); });
$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0]; if (!file) return;
  let parsed;
  try { parsed = parseImportText(await file.text(), file.name); }
  catch (err) { await dialog({ title: 'Can’t import this file', html: `<p>${esc(err.message)}</p>` }); return; }

  const existingIds = new Set(state.expenses.map((x) => x.id));
  const newOnes = (parsed.source === 'csv' ? dropCsvDuplicates(parsed.expenses) : parsed.expenses).filter((x) => !existingIds.has(x.id)).length;
  const from = parsed.source === 'backup'
    ? `Backup from app v${esc(parsed.appVersion)}${parsed.exportedAt ? `, made ${esc(new Date(parsed.exportedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }))}` : ''}${parsed.fileSchema < SCHEMA_VERSION ? ' — will be upgraded to the current format' : ''}.`
    : 'Spreadsheet (CSV) file.';
  const { value } = await dialog({
    title: `Import ${esc(file.name)}`,
    html: `<p class="muted small">${from}</p>
      <p>Found <b>${parsed.expenses.length}</b> expense${parsed.expenses.length === 1 ? '' : 's'}${parsed.recurring.length ? ` and <b>${parsed.recurring.length}</b> recurring payment${parsed.recurring.length === 1 ? '' : 's'}` : ''}${parsed.skipped ? ` (${parsed.skipped} unreadable row${parsed.skipped === 1 ? '' : 's'} skipped)` : ''}.</p>
      <p><b>Merge</b> adds ${newOnes} new expense${newOnes === 1 ? '' : 's'} and updates matching ones; nothing is removed.<br><b>Replace</b> deletes everything on this phone first${parsed.source === 'backup' ? ' and restores the backup’s settings' : ''}.</p>`,
    actions: [{ label: 'Cancel', value: null }, { label: 'Replace all', value: 'replace', kind: 'ghost danger' }, { label: 'Merge', value: 'merge', kind: 'primary' }],
  });
  if (!value) return;
  if (value === 'replace') {
    const ok = await dialog({ title: 'Replace all data?', html: `<p>This permanently removes the ${state.expenses.length} expenses and ${state.rules.length} recurring payments now on this phone.</p>`, actions: [{ label: 'Cancel', value: false }, { label: 'Replace', value: true, kind: 'danger solid' }] });
    if (!ok.value) return;
  }
  await applyImport(parsed, value);
});

// CSV rows carry no ids, so match them to existing expenses by content
// (date + amount + category + note) to avoid duplicates when merging.
function dropCsvDuplicates(incoming) {
  const sig = (e) => [e.date, Number(e.amount).toFixed(2), e.category.toLowerCase(), (e.note || '').toLowerCase()].join('|');
  const have = {};
  state.expenses.forEach((e) => { const k = sig(e); have[k] = (have[k] || 0) + 1; });
  return incoming.filter((e) => { const k = sig(e); if (have[k] > 0) { have[k]--; return false; } return true; });
}

async function applyImport(parsed, mode) {
  if (mode === 'merge' && parsed.source === 'csv') parsed = { ...parsed, expenses: dropCsvDuplicates(parsed.expenses) };
  const newer = (incoming, current) => !current || (incoming.updatedAt || 0) >= (current.updatedAt || 0);
  let expenses, rules, settings;
  if (mode === 'replace') {
    expenses = parsed.expenses; rules = parsed.recurring;
    settings = parsed.settings || state.settings;
  } else {
    const em = new Map(state.expenses.map((x) => [x.id, x]));
    parsed.expenses.forEach((x) => { if (newer(x, em.get(x.id))) em.set(x.id, x); });
    const rm = new Map(state.rules.map((x) => [x.id, x]));
    parsed.recurring.forEach((x) => {
      const cur = rm.get(x.id);
      if (newer(x, cur)) rm.set(x.id, cur && cur.lastGenerated > (x.lastGenerated || '') ? { ...x, lastGenerated: cur.lastGenerated } : x);
    });
    expenses = [...em.values()]; rules = [...rm.values()];
    settings = { ...state.settings };
    if (parsed.settings) {
      const have = new Set(settings.categories.map((c) => c.name));
      settings.categories = settings.categories.concat(parsed.settings.categories.filter((c) => !have.has(c.name)));
      if (!settings.budget && parsed.settings.budget) settings.budget = parsed.settings.budget;
    }
  }
  if (!(await persist({ clear: true, expenses, recurring: rules, meta: { settings } }))) return;
  state.expenses = expenses; state.rules = rules; state.settings = normalizeSettings(settings);
  addMissingCategories(expenses.map((x) => x.category).concat(rules.map((r) => r.category)));
  resetFormats();
  const added = await runRecurring();
  renderAll();
  toast(`Imported ${parsed.expenses.length} new expense${parsed.expenses.length === 1 ? '' : 's'}${added ? ` · ${added} recurring added` : ''}`);
}

$('wipeBtn').addEventListener('click', async () => {
  const { value, inputValue } = await dialog({
    title: 'Delete all data?',
    html: `<p>This permanently deletes ${state.expenses.length} expenses, ${state.rules.length} recurring payments and your settings from this phone. Export a backup first if you might need them.</p><p>Type <b>DELETE</b> to confirm.</p>`,
    input: { placeholder: 'DELETE' },
    actions: [{ label: 'Cancel', value: false }, { label: 'Delete everything', value: true, kind: 'danger solid' }],
  });
  if (!value) return;
  if ((inputValue || '').trim().toUpperCase() !== 'DELETE') { toast('Not deleted — you didn’t type DELETE'); return; }
  try {
    await wipeEverything();
    state.expenses = []; state.rules = []; state.settings = defaultSettings(); state.meta = { schemaVersion: SCHEMA_VERSION };
    await writeBatch({ meta: { schemaVersion: SCHEMA_VERSION, settings: state.settings } });
    resetFormats(); renderAll(); toast('All data deleted');
  } catch (e) { toast('Couldn’t delete: ' + e.message); }
});

// ─── Global events ───────────────────────────────────────────────────────────
$('prevMonth').addEventListener('click', () => { state.month = shiftMonth(state.month, -1); renderHome(); });
$('nextMonth').addEventListener('click', () => { state.month = shiftMonth(state.month, 1); renderHome(); });
$('thisMonth').addEventListener('click', () => { state.month = ymOf(new Date()); renderHome(); });
$('search').addEventListener('input', (e) => { state.search = e.target.value; renderList(); });
$('catFilter').addEventListener('change', (e) => { state.filterCat = e.target.value; renderCategories(); renderList(); });
$('fab').addEventListener('click', () => (state.view === 'recurring' ? openRule(null) : openExpense(null)));

document.addEventListener('click', (ev) => {
  const t = ev.target;
  if (t.closest('[data-close]')) { closeSheets(); return; }
  if (t.classList && t.classList.contains('overlay') && t.id !== 'dialog') { closeSheets(); return; }
  const er = t.closest('[data-edit-rule]'); if (er) { openRule(er.dataset.editRule); return; }
  const tx = t.closest('.tx[data-id]'); if (tx) { openExpense(tx.dataset.id); return; }
  const rr = t.closest('.tx[data-rule]'); if (rr) { openRule(rr.dataset.rule); return; }
  const cat = t.closest('.cat-row');
  if (cat) { state.filterCat = state.filterCat === cat.dataset.cat ? 'all' : cat.dataset.cat; renderCategories(); renderFilterOptions(); renderList(); return; }
  const act = t.closest('[data-action]');
  if (act) {
    const a = act.dataset.action;
    if (a === 'add') openExpense(null);
    else if (a === 'add-rule') openRule(null);
    else if (a === 'clear') { state.filterCat = 'all'; state.search = ''; $('search').value = ''; renderCategories(); renderFilterOptions(); renderList(); }
  }
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && $('dialog').hidden) closeSheets();
});

// Back button closes an open sheet instead of leaving the app.
window.addEventListener('popstate', () => { if (sheetOpen()) hideSheets(); });

boot();
