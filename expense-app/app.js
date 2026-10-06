'use strict';

/* ---------- Storage (only this device) ---------- */

const CONFIG_KEY = 'finance-config';
const SESSION_KEY = 'finance-session';
const CACHE_KEY = 'finance-cache';
const PREFS_KEY = 'finance-prefs';
const DEFAULT_URL = 'https://kpmiewijjxcwzfafyskd.supabase.co';

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* storage unavailable */ }
}

let config = load(CONFIG_KEY, null);
let session = load(SESSION_KEY, null);
let prefs = { startDay: 1, ...load(PREFS_KEY, {}) };

/* ---------- Supabase REST ---------- */

const baseUrl = () => config.url.replace(/\/+$/, '');

async function authRequest(params, body) {
  const res = await fetch(`${baseUrl()}/auth/v1/token?grant_type=${params}`, {
    method: 'POST',
    headers: { apikey: config.key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.msg || data.message || `Login fehlgeschlagen (${res.status})`);
  session = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
    email: data.user?.email,
  };
  save(SESSION_KEY, session);
}

const login = (email, password) => authRequest('password', { email, password });
const refreshSession = () => authRequest('refresh_token', { refresh_token: session.refresh_token });

class AuthError extends Error {}

async function token() {
  if (!session) throw new AuthError('Bitte anmelden.');
  if (session.expires_at - 60 < Date.now() / 1000) {
    try { await refreshSession(); } catch { session = null; save(SESSION_KEY, null); throw new AuthError('Anmeldung abgelaufen – bitte neu anmelden.'); }
  }
  return session.access_token;
}

async function fetchTable(table, columns) {
  const pageSize = 1000;
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const url = `${baseUrl()}/rest/v1/${table}?select=${columns}&order=datum.desc,created_at.desc&limit=${pageSize}&offset=${offset}`;
    const res = await fetch(url, {
      headers: { apikey: config.key, Authorization: `Bearer ${await token()}` },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 401) { session = null; save(SESSION_KEY, null); throw new AuthError('Anmeldung abgelaufen – bitte neu anmelden.'); }
      throw new Error(err.message || `Abfrage fehlgeschlagen (${res.status})`);
    }
    const page = await res.json();
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

/* ---------- Normalisation ---------- */

// datum is a Postgres date ("2026-10-05"): build a local date, not UTC midnight
function parseDate(v) {
  const [y, m, d] = String(v).split('-').map(Number);
  return new Date(y, m - 1, d);
}

// kind: 'ausgabe' | 'sparen' | 'einnahme'
function normalise(ausgaben, einnahmen) {
  const out = [];
  for (const r of ausgaben) {
    out.push({
      date: parseDate(r.datum),
      amount: Number(r.betrag),
      kind: r.art === 'Sparen' ? 'sparen' : 'ausgabe',
      category: r.kategorie || 'Sonstiges',
      note: r.beschreibung || '',
    });
  }
  for (const r of einnahmen) {
    out.push({ date: parseDate(r.datum), amount: Number(r.betrag), kind: 'einnahme', category: 'Einnahme', note: r.beschreibung || '' });
  }
  return out.filter(e => !isNaN(e.date) && isFinite(e.amount)).sort((a, b) => b.date - a.date);
}

/* ---------- Formatting ---------- */

const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

const moneyFmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const moneyFmtCompact = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', notation: 'compact', maximumFractionDigits: 1 });
const money = (n) => moneyFmt.format(n).replace('-', '−');
const moneyShort = (n) => (n >= 10000 ? moneyFmtCompact.format(n) : new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(n));
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- State ---------- */

const $ = (id) => document.getElementById(id);
let entries = [];
let expenses = [];   // art = Ausgabe
let savings = [];    // art = Sparen
let income = [];     // einnahmen
const today = new Date();
let view = null;   // { year, month } of the month the current period starts in
let categoryFilter = null;
let kindFilter = 'alle';
let txLimit = 40;

const monthKey = (y, m) => y * 12 + m;
const DAY = 864e5;

/* A "month" is a period that starts on prefs.startDay (1–28) and ends the day before
   that day in the following month. It is named after the month it starts in. */
const periodStart = (y, m) => new Date(y, m, prefs.startDay);
const periodOf = (date) => {
  const shift = date.getDate() < prefs.startDay ? -1 : 0;
  const k = monthKey(date.getFullYear(), date.getMonth()) + shift;
  return { year: Math.floor(k / 12), month: ((k % 12) + 12) % 12 };
};
const periodKeyOf = (date) => { const p = periodOf(date); return monthKey(p.year, p.month); };
const daysInMonth = (y, m) => Math.round((periodStart(y, m + 1) - periodStart(y, m)) / DAY);
const dayOfPeriod = (date, y, m) => Math.round((new Date(date.getFullYear(), date.getMonth(), date.getDate()) - periodStart(y, m)) / DAY) + 1;
const inMonth = (e, y, m) => e.pk === monthKey(y, m);
const fmtDay = (d) => `${d.getDate()}. ${MONTHS_SHORT[d.getMonth()]}`;
function periodLabel(y, m, short = false) {
  if (prefs.startDay === 1) return short ? MONTHS_SHORT[m] : `${MONTHS[m]} ${y}`;
  const end = new Date(periodStart(y, m + 1) - DAY);
  if (short) return MONTHS_SHORT[m];
  return `${fmtDay(periodStart(y, m))} – ${fmtDay(end)}${end.getFullYear() !== today.getFullYear() ? ` ${end.getFullYear()}` : ''}`;
}
function applyPeriods() {
  for (const e of entries) e.pk = periodKeyOf(e.date);
}
const shiftMonth = (y, m, delta) => { const k = monthKey(y, m) + delta; return { year: Math.floor(k / 12), month: ((k % 12) + 12) % 12 }; };
const sum = (list) => list.reduce((s, e) => s + e.amount, 0);

/* ---------- Rendering ---------- */

function render() {
  const { year, month } = view;
  const isCurrent = monthKey(year, month) === periodKeyOf(today);
  $('monthLabel').textContent = periodLabel(year, month);
  $('nextMonth').disabled = monthKey(year, month) >= periodKeyOf(today);

  const cur = expenses.filter(e => inMonth(e, year, month));
  const prev = shiftMonth(year, month, -1);
  const prevList = expenses.filter(e => inMonth(e, prev.year, prev.month));
  const total = sum(cur);
  const prevTotal = sum(prevList);
  const dim = daysInMonth(year, month);
  const elapsed = isCurrent ? dayOfPeriod(today, year, month) : dim;

  // Hero + delta (spending up = bad). For the running month compare like with like:
  // the previous month up to the same day.
  $('heroValue').textContent = money(total);
  const compareTotal = isCurrent ? sum(prevList.filter(e => dayOfPeriod(e.date, prev.year, prev.month) <= elapsed)) : prevTotal;
  const prevName = prefs.startDay === 1 ? MONTHS[prev.month] : 'Vormonat';
  const compareLabel = isCurrent ? `${prevName} bis Tag ${elapsed}` : prevName;
  if (compareTotal > 0) {
    const pct = ((total - compareTotal) / compareTotal) * 100;
    const cls = pct > 0 ? 'up' : 'down';
    const arrow = pct > 0 ? '▲' : '▼';
    $('heroDelta').innerHTML = `<span class="${cls}">${arrow} ${Math.abs(pct).toFixed(0)} %</span> vs. ${compareLabel} (${esc(money(compareTotal))})`;
  } else {
    $('heroDelta').textContent = `Keine Ausgaben im ${compareLabel}`;
  }

  // Tiles
  $('tilePerDay').textContent = money(total / Math.max(1, elapsed));
  $('tileForecastLabel').textContent = isCurrent ? 'Prognose Monatsende' : 'Größte Ausgabe';
  if (isCurrent) $('tileForecast').textContent = money((total / Math.max(1, elapsed)) * dim);
  else $('tileForecast').textContent = cur.length ? money(Math.max(...cur.map(e => e.amount))) : '–';
  $('tileCount').textContent = cur.length;
  const first = entries.length ? entries[entries.length - 1].date : today;
  const span = monthKey(view.year, view.month) - periodKeyOf(first) + 1;
  const last12 = monthsSeries(Math.min(12, Math.max(6, span)));
  $('monthTitle').textContent = `Letzte ${last12.length} Monate`;
  const withData = last12.filter(m => m.total > 0);
  $('tileAvg').textContent = withData.length ? money(sum(withData.map(m => ({ amount: m.total }))) / withData.length) : '–';

  const incList = income.filter(e => inMonth(e, year, month));
  const saveList = savings.filter(e => inMonth(e, year, month));
  renderBalance(sum(incList), total, sum(saveList));
  renderSankey(incList, cur, saveList);
  renderLineChart(cur, prevList, year, month, isCurrent ? elapsed : dim);
  renderCategories(cur, total);
  renderMonthChart(last12);
  renderTransactions(entries.filter(e => inMonth(e, year, month)));

  const cache = load(CACHE_KEY, null);
  $('lastSync').textContent = cache?.at ? `Zuletzt geladen: ${new Date(cache.at).toLocaleString('de-DE')} · Zum Aktualisieren nach unten ziehen` : '';
}

function monthsSeries(n) {
  const list = [];
  for (let i = n - 1; i >= 0; i--) {
    const { year, month } = shiftMonth(view.year, view.month, -i);
    list.push({
      year, month,
      total: sum(expenses.filter(e => inMonth(e, year, month))),
      income: sum(income.filter(e => inMonth(e, year, month))),
      saved: sum(savings.filter(e => inMonth(e, year, month))),
    });
  }
  return list;
}

function niceMax(v) {
  if (v <= 0) return 10;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  for (const f of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (f * exp >= v) return f * exp;
  return 10 * exp;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function el(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

function yAxis(svg, max, x0, x1, yOf) {
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    const y = yOf(v);
    svg.appendChild(el('line', { x1: x0, x2: x1, y1: y, y2: y, class: i === 0 ? 'baseline' : 'grid' }));
    svg.appendChild(el('text', { x: x0 - 6, y: y + 4, 'text-anchor': 'end' }, moneyShort(v)));
  }
}

/* Month balance: where the income went. Rows double as the legend for the split bar. */
function renderBalance(inc, out, saved) {
  const left = inc - out - saved;
  const rows = [
    ['Einnahmen', inc, 'var(--series-income)', ''],
    ['Ausgaben', out, 'var(--series-1)', '−'],
    ['Gespart', saved, 'var(--series-save)', '−'],
  ];
  let html = rows.map(([label, v, color, sign]) =>
    `<div class="bal-row"><span><i style="background:${color}"></i>${label}</span><span>${v ? sign : ''}${esc(money(v))}</span></div>`).join('');
  html += `<div class="bal-row bal-total"><span>Übrig</span><span class="${left < 0 ? 'neg' : ''}">${esc(money(left))}</span></div>`;

  let note;
  if (!inc) note = 'Keine Einnahmen erfasst.';
  else if (left < 0) note = `${money(-left)} mehr ausgegeben als eingenommen.`;
  else note = `Sparquote ${Math.round((saved / inc) * 100)} % · ${Math.round((left / inc) * 100)} % noch frei`;
  html += `<p class="sub bal-note">${esc(note)}</p>`;
  $('balance').innerHTML = html;
}

/* Sankey in four stages: income sources → Einnahmen → Ausgaben / Gespart / Übrig → categories.
   A shortfall enters as "Rücklagen" next to Einnahmen. Adjacent stages hold the same total,
   so each band is the overlap of a source's and a target's slice of it – bands never cross. */
const SANKEY_MAX_CATS = 6;

function topN(list, n, otherLabel) {
  const map = new Map();
  for (const e of list) map.set(e.key, (map.get(e.key) || 0) + e.amount);
  const sorted = [...map].sort((a, b) => b[1] - a[1]);
  if (sorted.length <= n) return sorted;
  const rest = sorted.slice(n - 1).reduce((t, [, v]) => t + v, 0);
  return [...sorted.slice(0, n - 1), [otherLabel, rest]];
}

let measureCtx;
function textWidth(text, size) {
  measureCtx ||= document.createElement('canvas').getContext('2d');
  measureCtx.font = `${size}px ${getComputedStyle(document.body).fontFamily}`;
  return measureCtx.measureText(text).width;
}

function renderSankey(incList, outList, saveList) {
  const box = $('sankey');
  box.innerHTML = '';
  const inc = sum(incList), out = sum(outList), saved = sum(saveList);
  const total = Math.max(inc, out + saved);
  if (!total) { box.innerHTML = '<p class="sub">Keine Buchungen in diesem Zeitraum.</p>'; return; }

  const C = { inc: 'var(--series-income)', out: 'var(--series-1)', save: 'var(--series-save)', left: 'var(--track-strong)', gap: 'var(--critical)' };
  const col0 = topN(incList.map(e => ({ key: e.note || 'Einnahme', amount: e.amount })), 4, 'Weitere')
    .map(([name, v]) => ({ name, v, color: C.inc }));
  const col1 = [{ name: 'Einnahmen', v: inc, color: C.inc }];
  if (out + saved > inc) col1.push({ name: 'Rücklagen', v: out + saved - inc, color: C.gap });
  const col2 = [
    { name: 'Ausgaben', v: out, color: C.out },
    { name: 'Gespart', v: saved, color: C.save },
    { name: 'Übrig', v: Math.max(0, inc - out - saved), color: C.left },
  ];
  const col3 = [
    ...topN(outList.map(e => ({ key: e.category, amount: e.amount })), SANKEY_MAX_CATS, 'Weitere').map(([name, v]) => ({ name, v, color: C.out, parent: 'Ausgaben' })),
    ...topN(saveList.map(e => ({ key: e.category, amount: e.amount })), 3, 'Weiteres').map(([name, v]) => ({ name, v, color: C.save, parent: 'Gespart' })),
  ];
  const cols = [col0, col1, col2, col3].map(c => c.filter(n => n.v > 0));
  const amount = (v) => `${moneyShort(v)} €`;

  // Horizontal layout: every node is labelled on its right with its name over its amount.
  // Each gap gets room for its column's widest label; when the screen is too narrow the
  // income sources are shortened first, the stage labels last.
  const W = Math.max(300, box.clientWidth || 320);
  const nodeW = 8, labelGap = 4, minFlow = 6, FS = 11, FS_VAL = 10;
  const lw = cols.map(c => Math.ceil(Math.max(...c.map(n => Math.max(textWidth(n.name, FS), textWidth(amount(n.v), FS_VAL))))));
  const width = () => 4 * nodeW + 4 * labelGap + 3 * minFlow + lw.reduce((t, w) => t + w, 0);
  const floor = [36, Math.ceil(textWidth('Einnahmen', FS)), Math.ceil(textWidth('Ausgaben', FS)), 44];
  for (const i of [0, 3, 2, 1]) while (width() > W && lw[i] > floor[i]) lw[i]--;
  for (const i of [0, 3, 2, 1]) while (width() > W && lw[i] > 24) lw[i]--;
  const extra = Math.max(0, W - width()) / 3;
  const xs = [0];
  for (let i = 1; i < 4; i++) xs.push(xs[i - 1] + nodeW + labelGap + lw[i - 1] + minFlow + extra);

  // Vertical layout: one scale for all stages so flows are conserved; small nodes get a
  // minimum slot so their label fits.
  const minSlot = 28;
  const pad = 6, top = 4, baseH = 260;
  const k = Math.min(...cols.map(c => (baseH - (c.length - 1) * pad) / c.reduce((t, n) => t + n.v, 0)));
  let H = 0;
  cols.forEach((col, ci) => {
    let y = top;
    for (const n of col) {
      n.x = xs[ci]; n.c = ci; n.h = Math.max(1, n.v * k);
      const slot = Math.max(n.h, minSlot);
      n.y = y + (slot - n.h) / 2;
      y += slot + pad;
    }
    H = Math.max(H, y - pad + top);
  });

  // Overlap of cumulative intervals between two stacked lists → bands
  function link(sources, targets) {
    const bands = [];
    let a = 0;
    const tStarts = []; let b = 0;
    for (const t of targets) { tStarts.push(b); b += t.v; }
    for (const s of sources) {
      const sa = a, sb = a + s.v; a = sb;
      targets.forEach((t, i) => {
        const lo = Math.max(sa, tStarts[i]), hi = Math.min(sb, tStarts[i] + t.v);
        if (hi - lo > 1e-6) bands.push({ s, t, v: hi - lo, sy: s.y + (lo - sa) * k, ty: t.y + (lo - tStarts[i]) * k });
      });
    }
    return bands;
  }
  const [c0, c1, c2, c3] = cols;
  const bands = [
    ...link(c0, c1.filter(n => n.name === 'Einnahmen')),
    ...link(c1, c2),
    ...c2.flatMap(p => link([p], c3.filter(c => c.parent === p.name))),
  ];

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Geldfluss von den Einnahmen zu Ausgaben, Sparen und Kategorien' });
  const tip = (html) => (ev) => {
    const r = svg.getBoundingClientRect();
    showTooltip(html, ev.clientX, Math.max(r.top, ev.clientY - 8));
  };
  const hover = (node, html) => {
    node.addEventListener('pointerenter', tip(html));
    node.addEventListener('pointerdown', tip(html));
    node.addEventListener('pointerleave', hideTooltip);
  };
  for (const l of bands) {
    const x0 = l.s.x + nodeW, x1 = l.t.x, xm = (x0 + x1) / 2, h = l.v * k;
    const d = `M${x0},${l.sy}C${xm},${l.sy} ${xm},${l.ty} ${x1},${l.ty}L${x1},${l.ty + h}C${xm},${l.ty + h} ${xm},${l.sy + h} ${x0},${l.sy + h}Z`;
    // Bands into the Einnahmen stage keep the source colour; later bands take the target's
    const path = el('path', { d, fill: l.t.c === 1 ? l.s.color : l.t.color, class: 'sk-link' });
    hover(path, `<div class="tt-head">${esc(l.s.name)} → ${esc(l.t.name)}</div><div class="tt-row">${esc(money(l.v))}</div>`);
    svg.appendChild(path);
  }
  for (const col of cols) {
    for (const n of col) {
      const rect = el('rect', { x: n.x, y: n.y, width: nodeW, height: n.h, rx: 2, fill: n.color });
      const base = n.c < 3 ? (n.c === 0 ? inc : total) : (n.parent === 'Gespart' ? saved : out);
      hover(rect, `<div class="tt-head">${esc(n.name)}</div><div class="tt-row">${esc(money(n.v))} · ${Math.round((n.v / base) * 100)} %</div>`);
      svg.appendChild(rect);
      const tx = n.x + nodeW + labelGap, cy = n.y + n.h / 2;
      svg.append(
        el('text', { x: tx, y: cy - 1, class: 'sk-label', 'data-w': lw[n.c] }, n.name),
        el('text', { x: tx, y: cy + 11, class: 'sk-value' }, amount(n.v)));
    }
  }
  box.appendChild(svg);
  // Shorten names that would run into the next stage (needs the SVG in the DOM to measure)
  for (const t of svg.querySelectorAll('text[data-w]')) {
    const max = Number(t.dataset.w);
    let name = t.textContent;
    while (t.getComputedTextLength() > max && name.length > 2) {
      name = name.slice(0, -1);
      t.textContent = `${name.trimEnd()}…`;
    }
  }
}

/* Cumulative line: this month vs previous month */
function renderLineChart(cur, prevList, year, month, lastDay) {
  const box = $('lineChart');
  box.innerHTML = '';
  const W = Math.max(280, box.clientWidth || 320), H = 200;
  const m = { l: 48, r: 12, t: 10, b: 24 };
  const dim = daysInMonth(year, month);
  const prev = shiftMonth(year, month, -1);
  const prevDim = daysInMonth(prev.year, prev.month);
  const curName = prefs.startDay === 1 ? MONTHS[month] : 'Dieser Monat';
  const prevName = prefs.startDay === 1 ? MONTHS[prev.month] : 'Vormonat';

  const cumulative = (list, days, upTo, ym) => {
    const perDay = new Array(days + 1).fill(0);
    for (const e of list) { const d = dayOfPeriod(e.date, ...ym); if (d >= 1 && d <= days) perDay[d] += e.amount; }
    const out = [];
    let acc = 0;
    for (let d = 1; d <= upTo; d++) { acc += perDay[d]; out.push({ d, v: acc }); }
    return out;
  };
  const curPts = cumulative(cur, dim, lastDay, [year, month]);
  const prevPts = cumulative(prevList, prevDim, Math.min(prevDim, dim), [prev.year, prev.month]);
  const dateOf = (d) => new Date(periodStart(year, month).getTime() + (d - 1) * DAY + 2 * 3600e3);

  const max = niceMax(Math.max(curPts.at(-1)?.v || 0, prevPts.at(-1)?.v || 0));
  const xOf = (d) => m.l + ((d - 1) / (dim - 1)) * (W - m.l - m.r);
  const yOf = (v) => H - m.b - (v / max) * (H - m.t - m.b);

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Kumulierte Ausgaben im Monat' });
  yAxis(svg, max, m.l, W - m.r, yOf);
  for (const d of [1, 8, 15, 22, dim]) {
    svg.appendChild(el('text', { x: xOf(d), y: H - 6, 'text-anchor': d === 1 ? 'start' : d === dim ? 'end' : 'middle' }, `${dateOf(d).getDate()}.`));
  }

  const path = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${xOf(p.d).toFixed(1)},${yOf(p.v).toFixed(1)}`).join('');
  if (prevPts.length) {
    svg.appendChild(el('path', { d: path(prevPts), fill: 'none', stroke: 'var(--series-compare)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  }
  if (curPts.length) {
    const area = `${path(curPts)}L${xOf(curPts.at(-1).d)},${yOf(0)}L${xOf(1)},${yOf(0)}Z`;
    svg.appendChild(el('path', { d: area, fill: 'var(--wash)' }));
    svg.appendChild(el('path', { d: path(curPts), fill: 'none', stroke: 'var(--series-1)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    const end = curPts.at(-1);
    svg.appendChild(el('circle', { cx: xOf(end.d), cy: yOf(end.v), r: 4, fill: 'var(--series-1)', stroke: 'var(--surface)', 'stroke-width': 2 }));
  }

  // Crosshair
  const cross = el('line', { y1: m.t, y2: H - m.b, stroke: 'var(--axis)', 'stroke-width': 1, visibility: 'hidden' });
  const dotCur = el('circle', { r: 4, fill: 'var(--series-1)', stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' });
  const dotPrev = el('circle', { r: 4, fill: 'var(--series-compare)', stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' });
  svg.append(cross, dotCur, dotPrev);
  const hit = el('rect', { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: 'transparent' });
  svg.appendChild(hit);

  const show = (ev) => {
    const rect = svg.getBoundingClientRect();
    const sx = ((ev.clientX - rect.left) / rect.width) * W;
    const d = Math.min(dim, Math.max(1, Math.round(1 + ((sx - m.l) / (W - m.l - m.r)) * (dim - 1))));
    const c = curPts[d - 1], p = prevPts[d - 1];
    cross.setAttribute('x1', xOf(d)); cross.setAttribute('x2', xOf(d)); cross.setAttribute('visibility', 'visible');
    const place = (dot, pt) => {
      if (pt) { dot.setAttribute('cx', xOf(d)); dot.setAttribute('cy', yOf(pt.v)); dot.setAttribute('visibility', 'visible'); }
      else dot.setAttribute('visibility', 'hidden');
    };
    place(dotCur, c); place(dotPrev, p);
    let html = `<div class="tt-head">Tag ${d} · ${esc(fmtDay(dateOf(d)))}</div>`;
    if (c) html += `<div class="tt-row"><i style="background:var(--series-1)"></i>${esc(curName)}: ${esc(money(c.v))}</div>`;
    if (p) html += `<div class="tt-row"><i style="background:var(--series-compare)"></i>${esc(prevName)}: ${esc(money(p.v))}</div>`;
    showTooltip(html, ev.clientX, rect.top + (m.t / H) * rect.height);
  };
  const hide = () => { [cross, dotCur, dotPrev].forEach(n => n.setAttribute('visibility', 'hidden')); hideTooltip(); };
  hit.addEventListener('pointermove', show);
  hit.addEventListener('pointerdown', show);
  hit.addEventListener('pointerleave', hide);
  hit.addEventListener('pointercancel', hide);

  box.appendChild(svg);
  $('lineLegend').innerHTML =
    `<span><i style="background:var(--series-1)"></i>${esc(curName)}</span>` +
    `<span><i style="background:var(--series-compare)"></i>${esc(prevName)}</span>`;
}

/* Category ranking — horizontal bars, single hue */
function renderCategories(cur, total) {
  const byCat = new Map();
  for (const e of cur) byCat.set(e.category, (byCat.get(e.category) || 0) + e.amount);
  const list = [...byCat].sort((a, b) => b[1] - a[1]);
  const box = $('categoryBars');
  if (!list.length) { box.innerHTML = '<p class="sub">Keine Ausgaben in diesem Monat.</p>'; return; }
  const max = list[0][1];
  box.innerHTML = list.map(([name, v]) => `
    <button class="cat${categoryFilter === name ? ' active' : ''}" data-cat="${esc(name)}">
      <span class="name">${esc(name)}</span>
      <span class="amt">${esc(money(v))}<span class="pct">${Math.round((v / total) * 100)} %</span></span>
      <span class="bar"><i style="width:${Math.max(0.5, (v / max) * 100)}%"></i></span>
    </button>`).join('');
  box.querySelectorAll('.cat').forEach(b => b.addEventListener('click', () => {
    categoryFilter = categoryFilter === b.dataset.cat ? null : b.dataset.cat;
    if (categoryFilter) kindFilter = 'ausgabe';
    txLimit = 40;
    render();
  }));
}

/* Last 12 months — columns, selected month emphasised */
function renderMonthChart(series) {
  const box = $('monthChart');
  box.innerHTML = '';
  const W = Math.max(280, box.clientWidth || 320), H = 180;
  const m = { l: 48, r: 4, t: 10, b: 24 };
  const max = niceMax(Math.max(...series.map(s => Math.max(s.total, s.income))));
  const band = (W - m.l - m.r) / series.length;
  const bw = Math.min(24, band - 6);
  const yOf = (v) => H - m.b - (v / max) * (H - m.t - m.b);

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Ausgaben der letzten 12 Monate' });
  yAxis(svg, max, m.l, W - m.r, yOf);

  series.forEach((s, i) => {
    const cx = m.l + band * i + band / 2;
    const selected = s.year === view.year && s.month === view.month;
    const y = yOf(s.total), h = yOf(0) - y;
    if (h > 0) {
      const r = Math.min(4, h, bw / 2);
      const x = cx - bw / 2, base = yOf(0);
      const d = `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${base}Z`;
      svg.appendChild(el('path', { d, fill: selected ? 'var(--series-1)' : 'var(--series-1-soft)' }));
    }
    svg.appendChild(el('text', { x: cx, y: H - 6, 'text-anchor': 'middle', 'font-weight': selected ? 600 : 400 }, periodLabel(s.year, s.month, true).slice(0, 3)));
    const hit = el('rect', { x: m.l + band * i, y: 0, width: band, height: H, fill: 'transparent', style: 'cursor:pointer' });
    hit.addEventListener('pointerenter', (ev) => {
      const rect = svg.getBoundingClientRect();
      showTooltip(`<div class="tt-head">${esc(periodLabel(s.year, s.month))}</div>` +
        `<div class="tt-row"><i style="background:var(--series-income)"></i>Einnahmen: ${esc(money(s.income))}</div>` +
        `<div class="tt-row"><i style="background:var(--series-1)"></i>Ausgaben: ${esc(money(s.total))}</div>` +
        `<div class="tt-row"><i style="background:var(--series-save)"></i>Gespart: ${esc(money(s.saved))}</div>`,
        rect.left + (cx / W) * rect.width, rect.top + (Math.min(y, yOf(s.income)) / H) * rect.height);
    });
    hit.addEventListener('pointerleave', hideTooltip);
    hit.addEventListener('click', () => {
      hideTooltip();
      view = { year: s.year, month: s.month };
      categoryFilter = null; txLimit = 40;
      render();
    });
    svg.appendChild(hit);
  });

  // Income as a line with markers over the columns; months without income break the line
  const pts = series.map((s, i) => ({ x: m.l + band * i + band / 2, y: yOf(s.income), s }));
  if (series.some(s => s.income > 0)) {
    const d = pts.map((p, i) => (p.s.income > 0 ? `${i && pts[i - 1].s.income > 0 ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}` : '')).join('');
    const line = el('path', { d, fill: 'none', stroke: 'var(--series-income)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'pointer-events': 'none' });
    svg.appendChild(line);
    for (const p of pts) {
      if (p.s.income > 0) svg.appendChild(el('circle', { cx: p.x, cy: p.y, r: 4, fill: 'var(--series-income)', stroke: 'var(--surface)', 'stroke-width': 2, 'pointer-events': 'none' }));
    }
  }
  box.appendChild(svg);
  $('monthLegend').innerHTML =
    '<span><i class="sw-bar" style="background:var(--series-1)"></i>Ausgaben</span>' +
    '<span><i style="background:var(--series-income)"></i>Einnahmen</span>';
}

const KIND_LABEL = { ausgabe: 'Ausgabe', sparen: 'Sparen', einnahme: 'Einnahme' };

function renderTransactions(monthEntries) {
  let list = monthEntries;
  if (kindFilter !== 'alle') list = list.filter(e => e.kind === kindFilter);
  if (categoryFilter) list = list.filter(e => e.kind === 'ausgabe' && e.category === categoryFilter);

  document.querySelectorAll('#kindFilter button').forEach(b => b.classList.toggle('active', b.dataset.kind === kindFilter));
  const chip = $('clearFilter');
  chip.hidden = !categoryFilter;
  if (categoryFilter) chip.textContent = `${categoryFilter} ✕`;

  if (!list.length) { $('txList').innerHTML = '<p class="sub">Keine Buchungen.</p>'; return; }
  const shown = list.slice(0, txLimit);
  const days = new Map();
  for (const e of shown) {
    const k = e.date.toDateString();
    if (!days.has(k)) days.set(k, []);
    days.get(k).push(e);
  }
  let html = '';
  for (const [, items] of days) {
    const d = items[0].date;
    html += `<div class="day"><div class="day-head"><span>${d.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short' })}</span></div>`;
    for (const e of items) {
      const meta = e.kind === 'ausgabe' ? e.category : e.kind === 'sparen' ? `Sparen · ${e.category}` : 'Einnahme';
      const amt = e.kind === 'einnahme' ? `<span class="pos">+${esc(money(e.amount))}</span>` : `−${esc(money(e.amount))}`;
      html += `<div class="tx"><div class="t-main"><div class="t-note">${esc(e.note || KIND_LABEL[e.kind])}</div>` +
        `<div class="t-cat">${esc(meta)}</div></div><div class="t-amt">${amt}</div></div>`;
    }
    html += '</div>';
  }
  if (list.length > txLimit) html += `<button class="btn more" id="moreTx">Weitere ${list.length - txLimit} anzeigen</button>`;
  $('txList').innerHTML = html;
  $('moreTx')?.addEventListener('click', () => { txLimit += 100; render(); });
}

/* ---------- Tooltip & status ---------- */

function showTooltip(html, x, y) {
  const tt = $('tooltip');
  tt.innerHTML = html;
  tt.hidden = false;
  const w = tt.offsetWidth, h = tt.offsetHeight;
  tt.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, x - w / 2))}px`;
  tt.style.top = `${Math.max(8, y - h - 10)}px`;
}
function hideTooltip() { $('tooltip').hidden = true; }

let statusTimer;
function status(msg, ms = 2500) {
  const s = $('status');
  clearTimeout(statusTimer);
  if (!msg) { s.hidden = true; return; }
  s.textContent = msg;
  s.hidden = false;
  if (ms) statusTimer = setTimeout(() => { s.hidden = true; }, ms);
}

/* ---------- Data loading ---------- */

function applyData(data) {
  entries = normalise(data.ausgaben, data.einnahmen);
  expenses = entries.filter(e => e.kind === 'ausgabe');
  savings = entries.filter(e => e.kind === 'sparen');
  income = entries.filter(e => e.kind === 'einnahme');
  applyPeriods();
}

async function refresh() {
  if (!config) return;
  if (!session) { openSettings(); return; }
  status('Lade Daten …', 0);
  try {
    const [ausgaben, einnahmen] = await Promise.all([
      fetchTable('ausgaben', 'datum,betrag,art,kategorie,beschreibung'),
      fetchTable('einnahmen', 'datum,betrag,beschreibung'),
    ]);
    const data = { at: Date.now(), ausgaben, einnahmen };
    applyData(data);
    save(CACHE_KEY, data);
    showDashboard();
    status(`${ausgaben.length + einnahmen.length} Buchungen geladen`, 1500);
  } catch (e) {
    if (e instanceof AuthError) {
      status(null);
      openSettings();
      $('formError').textContent = e.message;
      $('formError').hidden = false;
    } else {
      status(e.message, 6000);
    }
  }
}

function showDashboard() {
  $('empty').hidden = true;
  $('dashboard').hidden = false;
  render();
}

/* ---------- Settings ---------- */

function openSettings() {
  const f = $('settingsForm');
  f.url.value = config?.url || DEFAULT_URL;
  f.key.value = config?.key || '';
  f.email.value = session?.email || f.email.value || '';
  f.password.value = '';
  $('formError').hidden = true;
  $('connDetails').open = !f.key.value;
  f.startDay.value = String(prefs.startDay);
  updateAuthState();
  if (!$('settings').open) $('settings').showModal();
}

function updateAuthState() {
  $('authState').textContent = session ? `Angemeldet als ${session.email || 'Benutzer'}.` : 'Nicht angemeldet.';
  $('logoutBtn').hidden = !session;
  $('submitBtn').textContent = session ? 'Speichern & laden' : 'Anmelden & laden';
  }

function logout() {
  session = null;
  save(SESSION_KEY, null);
  save(CACHE_KEY, null);   // keep no financial data on the device after logging out
  entries = expenses = savings = income = [];
  $('dashboard').hidden = true;
  $('empty').hidden = false;
  updateAuthState();
  status('Abgemeldet');
}

/* ---------- Pull to refresh ---------- */

function setupPullToRefresh() {
  let startY = null;
  window.addEventListener('touchstart', (e) => { startY = window.scrollY === 0 ? e.touches[0].clientY : null; }, { passive: true });
  window.addEventListener('touchend', (e) => {
    if (startY != null && e.changedTouches[0].clientY - startY > 90 && !$('settings').open) refresh();
    startY = null;
  }, { passive: true });
}

/* ---------- Init ---------- */

function init() {
  view = periodOf(today);
  $('prevMonth').addEventListener('click', () => { view = shiftMonth(view.year, view.month, -1); categoryFilter = null; txLimit = 40; render(); });
  $('nextMonth').addEventListener('click', () => { view = shiftMonth(view.year, view.month, 1); categoryFilter = null; txLimit = 40; render(); });
  $('clearFilter').addEventListener('click', () => { categoryFilter = null; render(); });
  document.querySelectorAll('#kindFilter button').forEach(b => b.addEventListener('click', () => {
    kindFilter = b.dataset.kind;
    if (kindFilter !== 'ausgabe') categoryFilter = null;
    txLimit = 40;
    render();
  }));
  $('openSettings').addEventListener('click', openSettings);
  $('emptySetup').addEventListener('click', openSettings);
  $('closeSettings').addEventListener('click', () => $('settings').close());

  $('settingsForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = $('settingsForm');
    const fail = (msg, field) => {
      $('formError').textContent = msg;
      $('formError').hidden = false;
      if (field) {
        if (field.closest('details')) field.closest('details').open = true;
        field.focus();
      }
    };
    $('formError').hidden = true;

    const url = (f.url.value.trim() || DEFAULT_URL).replace(/\/+$/, '');
    const key = f.key.value.trim();
    const email = f.email.value.trim();
    if (!/^https:\/\/.+/.test(url)) return fail('Bitte eine gültige Projekt-URL eintragen (https://…supabase.co).', f.url);
    if (!key) return fail('Bitte den Publishable Key unter „Supabase-Verbindung“ eintragen.', f.key);
    if (!email) return fail('Bitte E-Mail eintragen.', f.email);
    if (!session && !f.password.value) return fail('Bitte Passwort eintragen.', f.password);

    config = { url, key };
    save(CONFIG_KEY, config);
    if (f.password.value) {
      const btn = $('submitBtn');
      btn.disabled = true;
      btn.textContent = 'Anmelden …';
      try {
        await login(email, f.password.value);
      } catch (e) {
        const msg = e.message === 'Invalid login credentials' ? 'E-Mail oder Passwort falsch.'
          : /api key/i.test(e.message) ? 'Der Key passt nicht zum Projekt. Bitte prüfen.'
          : e.message === 'Failed to fetch' ? 'Keine Verbindung zu Supabase. Projekt-URL und Internet prüfen.'
          : e.message;
        return fail(msg);
      } finally {
        btn.disabled = false;
        updateAuthState();
      }
    }
    f.password.value = '';
    $('settings').close();
    refresh();
  });
  $('logoutBtn').addEventListener('click', () => { $('settings').close(); logout(); });
  const startSel = $('settingsForm').startDay;
  for (let d = 1; d <= 28; d++) startSel.add(new Option(d === 1 ? '1. (Kalendermonat)' : `${d}.`, String(d)));
  startSel.addEventListener('change', () => {
    prefs.startDay = Number(startSel.value);
    save(PREFS_KEY, prefs);
    view = periodOf(today);
    applyPeriods();
    if (!$('dashboard').hidden) render();
  });

  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (!$('dashboard').hidden) render(); }, 150); });
  document.addEventListener('scroll', hideTooltip, { passive: true });
  setupPullToRefresh();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  if (!config || !session) { $('empty').hidden = false; return; }

  // Show cached data immediately, then refresh in the background
  const cache = load(CACHE_KEY, null);
  if (cache?.ausgaben) { applyData(cache); showDashboard(); }
  refresh();
}

init();
