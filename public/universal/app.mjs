// Universal tab page. Shared logic: ./lib/*.mjs (the same files the server uses).
import { runBatch, planBatch } from './lib/pipeline.mjs';
import { COLUMNS, INPUT_COLUMNS, verifyAlignment } from './lib/assemble.mjs';
import { readRows, buildWorkbook } from './lib/xlsx.mjs';

const $ = (id) => document.getElementById(id);
const KEYS = ['username', 'page_name', 'profile', 'post_url'];
const GRID_ROWS = 3000;   // rows 2..3001 (more only if a paste/upload needs them)
let data = [];            // data[i] = Excel row i + 2
let last = null;          // last run result
const STATUS_TEXT = { waiting: 'waiting', running: 'working…', ok: 'done', partial: 'done (some gaps)', unavailable: 'not available', failed: 'could not fetch',
  checkfail: 'check failed', skipped: 'skipped', invalid: 'bad link', 'as-typed': 'as typed', empty: '' };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function postJSON(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `HTTP ${r.status}`); }
  return r.json();
}
async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `HTTP ${r.status}`); }
  return r.json();
}

// ── input grid ──
function ensureRows(n) { while (data.length < n) data.push({ username: '', page_name: '', profile: '', post_url: '' }); }
function renderInput() {
  const head = `<thead><tr><th class="rn">1</th>${INPUT_COLUMNS.map((c) => `<th>${c}</th>`).join('')}<th>Status</th></tr></thead>`;
  const body = data.map((d, i) => `<tr><td class="rn">${i + 2}</td>${KEYS.map((k, j) =>
    `<td class="c${k === 'profile' || k === 'post_url' ? ' wide' : ''}"><input data-i="${i}" data-j="${j}" value="${esc(d[k])}" spellcheck="false"></td>`).join('')}<td class="st" id="st${i + 2}"></td></tr>`).join('');
  $('inGrid').innerHTML = head + '<tbody>' + body + '</tbody>';
}
const cellAt = (i, j) => document.querySelector(`#inGrid input[data-i="${i}"][data-j="${j}"]`);
$('inGrid').addEventListener('input', (e) => { const el = e.target; if (el.dataset.i) data[+el.dataset.i][KEYS[+el.dataset.j]] = el.value; });
$('inGrid').addEventListener('keydown', (e) => {
  const el = e.target; if (!el.dataset.i) return;
  const i = +el.dataset.i, j = +el.dataset.j;
  const go = (a, b) => { const n = cellAt(a, b); if (n) { e.preventDefault(); n.focus(); n.select(); } };
  if (e.key === 'Enter' || e.key === 'ArrowDown') go(i + 1, j);
  else if (e.key === 'ArrowUp') go(i - 1, j);
});
// Excel copies cells as tab/newline text; quoted cells may hold newlines. Blank cells and blank rows are kept.
function parseTSV(t) {
  t = t.replace(/\r\n?/g, '\n');
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"' && cell === '') q = true;
    else if (ch === '\t') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
$('inGrid').addEventListener('paste', (e) => {
  const el = e.target; if (!el.dataset.i) return;
  const text = e.clipboardData.getData('text/plain');
  if (!/[\t\n]/.test(text.replace(/\n$/, ''))) return; // single cell: normal paste
  e.preventDefault();
  const grid = parseTSV(text);
  const i0 = +el.dataset.i, j0 = +el.dataset.j;
  ensureRows(i0 + grid.length);
  grid.forEach((cells, a) => cells.forEach((v, b) => { if (j0 + b < KEYS.length) data[i0 + a][KEYS[j0 + b]] = v.trim(); }));
  renderInput();
  cellAt(i0, j0)?.focus();
});
$('clear').onclick = () => { data = []; ensureRows(GRID_ROWS); renderInput(); $('outSec').classList.add('hidden'); $('progress').classList.add('hidden'); last = null; showResumeBanner(); };
$('file').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const j = await readRows(window.ExcelJS, await f.arrayBuffer());
    data = [];
    ensureRows(Math.max(GRID_ROWS, j.rows.length ? j.rows[j.rows.length - 1].r - 1 : 0));
    for (const row of j.rows) for (const k of KEYS) data[row.r - 2][k] = row[k] || '';
    renderInput();
    alert(`Loaded ${j.rows.length} rows from sheet "${j.sheet}".`);
  } catch (err) { console.error(err); alert('Could not read this file. Please check it has a header row with Profile and/or Post_url.'); }
  e.target.value = '';
};

// ── run ──
const settings = () => ({ profile: $('tProfile').checked, platforms: Object.fromEntries([...document.querySelectorAll('[data-pl]')].map((x) => [x.dataset.pl, x.checked])) });
const applySettings = (st) => { $('tProfile').checked = !!st.profile; document.querySelectorAll('[data-pl]').forEach((x) => (x.checked = st.platforms?.[x.dataset.pl] !== false)); };
const setStatus = (r, s) => { const el = $('st' + r); if (el) { el.textContent = STATUS_TEXT[s] ?? s; el.className = 'st ' + s; } };
const money = (x) => '$' + (x < 0.01 ? x.toFixed(4) : x.toFixed(2));
const mins = (sec) => (sec == null ? '…' : sec < 60 ? `${sec}s` : `${Math.round(sec / 60)} min`);
const lock = (on) => document.querySelectorAll('button, .fill-row input, #file').forEach((b) => (b.disabled = on));

// Resume: every scraper run id is saved here the moment it starts. Finished runs are read back for free (kept 7+ days).
const JOB_KEY = 'sm-universal-job';
const loadJob = () => { try { return JSON.parse(localStorage.getItem(JOB_KEY) || 'null'); } catch { return null; } };
let job = null, saveTimer = null;
const saveNow = () => { try { localStorage.setItem(JOB_KEY, JSON.stringify(job)); } catch (e) { console.warn('resume save failed', e); } };
const saveJob = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 300); };
const journalFor = (j) => {
  // every run is remembered by the links it fetched, so Resume reuses it whatever way links get grouped next time
  j.idx ||= {};
  const list = (task, phase) => (j.idx[`${task}|${phase}`] ||= []);
  return {
    find: (task, phase, k) => list(task, phase).find((e) => e.keys.includes(k)) || null,
    add: (task, phase, keys, runIds) => { const e = { task, phase, keys, runIds }; list(task, phase).push(e); saveJob(); return e; },
    drop: (e) => { const l = list(e.task, e.phase); const i = l.findIndex((x) => x.runIds.join() === e.runIds.join()); if (i >= 0) l.splice(i, 1); saveJob(); },
  };
};
function showResumeBanner() {
  const j = loadJob(), b = $('resume');
  if (!j) { b.classList.add('hidden'); return; }
  const when = new Date(j.startedAt).toLocaleString();
  $('resumeText').textContent = j.finished
    ? `Last batch: ${j.rows.length} rows, started ${when}, finished. You can show its output again (no new scraping).`
    : `Unfinished batch: ${j.rows.length} rows, started ${when}. Resume reuses everything already finished and only fetches the rest.`;
  $('resumeBtn').textContent = j.finished ? 'Show output again' : 'Resume';
  b.classList.remove('hidden');
}
$('discardBtn').onclick = () => { if (confirm('Forget the saved batch? Its results can no longer be reloaded.')) { localStorage.removeItem(JOB_KEY); showResumeBanner(); } };
$('resumeBtn').onclick = () => {
  const j = loadJob(); if (!j) return;
  data = []; ensureRows(GRID_ROWS);
  for (const r of j.rows) { ensureRows(r.r - 1); for (const k of KEYS) data[r.r - 2][k] = r[k] || ''; }
  renderInput(); applySettings(j.settings);
  startBatch(j.rows, j.settings, j);
};

$('run').onclick = async () => {
  let lastI = -1;
  data.forEach((d, i) => { if (KEYS.some((k) => (d[k] || '').trim())) lastI = i; });
  if (lastI < 0) return alert('Add some links first.');
  const old = loadJob();
  if (old && !old.finished && !confirm('There is an unfinished batch saved. Start a new batch and forget it?')) return;
  const rows = data.slice(0, lastI + 1).map((d, i) => ({ r: i + 2, ...d }));
  const st = settings();
  // cost check before spending anything
  const plan = planBatch(rows, st);
  let lim = null;
  try { lim = await getJSON('/api/u/limits'); } catch (e) { console.error(e); return alert('Could not connect to the scraping account: ' + ((e && e.message) || 'unknown error') + '. Please try again in a minute.'); }
  const left = lim.monthlyLimitUsd != null && lim.monthlyUsedUsd != null ? lim.monthlyLimitUsd - lim.monthlyUsedUsd : null;
  const parts = [['Instagram', plan.counts.instagram], ['X', plan.counts.x], ['Facebook', plan.counts.facebook], ['YouTube', plan.counts.youtube]].filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ');
  const msg = [`${rows.length} rows${parts ? ` (posts: ${parts})` : ''}.`,
    `Estimated cost: up to ${money(plan.total)}.`,
    left != null ? `Scraping account: ${money(left)} left this month.` : '',
    left != null && plan.total > left ? '\nThis may cost more than what is left this month. Rows after that point will not be filled.' : '',
    '\nStart?'].filter(Boolean).join('\n');
  if (!confirm(msg)) return;
  startBatch(rows, st, { id: Date.now(), startedAt: Date.now(), extractedAt: null, rows, settings: st, idx: {}, finished: false, limits: lim });
};

async function startBatch(rows, st, j) {
  job = j; saveNow();
  let lim = j.limits;
  try { lim = await getJSON('/api/u/limits'); } catch { /* keep the saved one */ }
  // leave 1 slot free on the account, and don't count runs that something else is using right now
  const limits = { maxJobs: Math.max(1, (lim?.maxJobs ?? 5) - 1 - (lim?.activeJobs ?? 0)), maxMemMb: Math.max(4096, (lim?.maxMemMb ?? 16384) - (lim?.usedMemMb ?? 0) - 1024) };
  lock(true);
  $('resume').classList.add('hidden');
  $('progress').classList.remove('hidden'); $('outSec').classList.add('hidden');
  $('log').textContent = '';
  // friendly messages on screen; technical detail only in the browser console (F12)
  const say = (m) => { $('log').textContent += `${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}  ${m}\n`; $('log').scrollTop = 1e9; };
  const told = new Set();
  const once = (k, m) => { if (!told.has(k)) { told.add(k); say(m); } };
  const log = (m) => {
    console.debug('[universal]', m);
    if (/account busy/i.test(m)) once('busy', 'The scraping account is busy, waiting for a free slot…');
    else if (/technical error/i.test(m)) once('retry', 'A connection problem happened. Trying again automatically…');
    else if (/checking them once more/i.test(m)) once('recheck', 'Some links gave no data. Checking them once more to be sure…');
  };
  say(Object.values(j.idx || {}).some((l) => l.length) ? `Resumed ${rows.length} rows. Finished parts are reused, only the rest is fetched.` : `Started ${rows.length} rows.`);
  $('bar').style.width = '0%';
  const STAGE = { posts: 'Getting post details', profiles: 'Getting profile details', done: 'Finishing' };
  let shownPct = 0;
  const onProgress = (p) => {
    shownPct = Math.max(shownPct, p.pct); // never goes backwards
    $('bar').style.width = shownPct + '%';
    if (p.stage === 'profiles') once('prof', 'Post details done. Now getting profile details…');
    if (p.stage !== 'done') $('pSummary').textContent = `${STAGE[p.stage]} · ${shownPct}% done · ${p.etaSeconds == null ? 'working out time left…' : 'about ' + mins(p.etaSeconds) + ' left'}`;
  };
  try {
    const api = {
      start: (task, keys) => postJSON('/api/u/task/start', { task, keys }),
      result: (task, keys, runIds) => postJSON('/api/u/task/result', { task, keys, runIds }),
    };
    if (!j.extractedAt) { j.extractedAt = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00'); saveNow(); }
    last = await runBatch({ rows, settings: st, api, limits, journal: journalFor(j), extractedAt: j.extractedAt, onLog: log, onRow: setStatus, onProgress });
    last.rows = rows;
    j.finished = true; saveNow();
    const c = {}; for (const o of last.outputs) c[o.status] = (c[o.status] || 0) + 1;
    const sum = Object.entries(c).filter(([k]) => k !== 'empty').map(([k, v]) => `${STATUS_TEXT[k] || k}: ${v}`).join(' · ');
    say(`Done in ${mins(last.seconds)}. ${sum}. Cost ${money(last.cost)}.`);
    $('pSummary').textContent = `Done in ${mins(last.seconds)} · cost ${money(last.cost)}`;
    $('bar').style.width = '100%';
    renderOutput(last);
    if (last.failures.length) say(`${last.failures.length} link(s) could not be fetched even after 3 tries. They are marked yellow in the sheet.`);
    if (last.failures.length || last.seconds > 300) {
      try {
        const n = await postJSON('/api/u/notify', { failures: last.failures, finished: true,
          summary: `Batch of ${rows.length} rows finished in ${mins(last.seconds)} (started ${new Date(j.startedAt).toLocaleString()}). ${sum}. Cost ${money(last.cost)}.` });
        console.debug('[universal] email', n);
        say(n.sent ? 'Email sent to priyanshu@sarvaa.co.in.' : 'Email not sent (email is not set up yet).');
      } catch (err) { console.debug('[universal] email error', err); say('Email not sent.'); }
    }
  } catch (err) {
    console.error('[universal] stopped', err);
    say('Stopped because of a problem. Press Resume to continue. Nothing that already finished is lost.');
    $('pSummary').textContent = 'Stopped · press Resume to continue';
  }
  lock(false);
  if (last?.alignErrors?.length) $('download').disabled = true;
  showResumeBanner(); $('resume').classList.toggle('hidden', !!last && job?.finished);
}

// ── output grid ──
function renderOutput(res) {
  $('outSec').classList.remove('hidden');
  $('alignErr').textContent = res.alignErrors.length ? 'Row check failed, so the download is blocked:\n' + res.alignErrors.join('\n') : '';
  const numCols = new Set(['Likes', 'Comments', 'Shares', 'Views', 'Followers', 'Engagement', 'Duration_seconds']);
  const head = `<thead><tr><th class="rn">1</th>${COLUMNS.map((c) => `<th>${c}</th>`).join('')}</tr></thead>`;
  const body = res.outputs.map((o) => `<tr><td class="rn">${o.r}</td>${COLUMNS.map((c) => {
    const v = o.values[c], m = o.marks[c] || {};
    const cls = [numCols.has(c) ? 'num' : '', m.color || '', m.note ? 'noted' : ''].join(' ');
    const title = [v != null ? String(v) : '', m.note ? 'Note: ' + m.note : ''].filter(Boolean).join('\n');
    return `<td class="${cls}" title="${esc(title)}">${esc(v ?? '')}</td>`;
  }).join('')}</tr>`).join('');
  $('outGrid').innerHTML = head + '<tbody>' + body + '</tbody>';
  const filled = res.outputs.filter((o) => o.status === 'ok' || o.status === 'partial').length;
  $('oSummary').textContent = `${res.outputs.length} rows · ${filled} filled`;
}
$('download').onclick = async () => {
  if (!last) return;
  const errs = verifyAlignment(last.rows, last.outputs); // checked again right before writing the file
  if (errs.length) { $('alignErr').textContent = 'Row check failed, so the download is blocked:\n' + errs.join('\n'); return; }
  try {
    const tpl = await (await fetch('/universal/template.xlsx')).arrayBuffer();
    const buf = await buildWorkbook(window.ExcelJS, tpl, last.outputs);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    a.download = `metrics-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.xlsx`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } catch (err) { console.error(err); $('alignErr').textContent = 'Could not build the Excel file. Please try again.'; }
};

ensureRows(GRID_ROWS); renderInput(); showResumeBanner();
