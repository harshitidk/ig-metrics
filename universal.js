// ─────────────────────────────────────────────────────────────────────────────
// Universal tab — any mix of Instagram / X / Facebook / YouTube links in, the
// fixed 15-column sheet out (public/universal.html).
//
// The browser does the batching, checks, retries and the Excel file; these
// routes only start Apify runs and hand back parsed results, so every request
// stays short (fits Vercel's time and size limits).
//
// Shared logic lives in public/universal/lib/*.mjs (also loaded by the page).
// server.js wires this in with require('./universal')(app).
// ─────────────────────────────────────────────────────────────────────────────

const { ApifyClient } = require('apify-client');

let tasksModule = null;
const loadTasks = async () => (tasksModule ||= await import('./public/universal/lib/tasks.mjs'));

function client() {
  if (!process.env.APIFY_TOKEN) throw new Error('APIFY_TOKEN is not set');
  return new ApifyClient({ token: process.env.APIFY_TOKEN });
}
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) { res.status(500).json({ error: String((e && e.message) || e).slice(0, 500) }); }
};
const okKeys = (keys) => Array.isArray(keys) && keys.length > 0 && keys.length <= 200 && keys.every((k) => typeof k === 'string' && k.length < 400);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

module.exports = function registerUniversal(app) {
  // Account limits (runs at once, memory, money left) - read before every batch.
  app.get('/api/u/limits', wrap(async (req, res) => {
    const r = await fetch('https://api.apify.com/v2/users/me/limits', { headers: { Authorization: `Bearer ${process.env.APIFY_TOKEN}` } });
    if (!r.ok) throw new Error(`Apify limits HTTP ${r.status}`);
    const { limits = {}, current = {} } = (await r.json()).data || {};
    res.json({
      maxJobs: limits.maxConcurrentActorJobs ?? 5, activeJobs: current.activeActorJobCount ?? 0,
      maxMemMb: Math.round((limits.maxActorMemoryGbytes ?? 16) * 1024), usedMemMb: Math.round((current.actorMemoryGbytes ?? 0) * 1024),
      monthlyLimitUsd: limits.maxMonthlyUsageUsd ?? null, monthlyUsedUsd: current.monthlyUsageUsd ?? null,
    });
  }));

  // Start the Apify run(s) for one task + list of keys.
  app.post('/api/u/task/start', wrap(async (req, res) => {
    const { TASKS } = await loadTasks();
    const { task, keys } = req.body || {};
    const T = TASKS[task];
    if (!T || !okKeys(keys)) return res.status(400).json({ error: 'Bad task request' });
    const c = client();
    const runIds = [];
    for (const r of T.runs(keys)) runIds.push((await c.actor(r.actor).start(r.input, { timeout: 600 })).id);
    res.json({ runIds });
  }));

  // Poll: running / error / done with parsed records (matched by each item's own id).
  app.post('/api/u/task/result', wrap(async (req, res) => {
    const { TASKS } = await loadTasks();
    const { task, keys, runIds } = req.body || {};
    const T = TASKS[task];
    if (!T || !okKeys(keys) || !Array.isArray(runIds) || !runIds.length) return res.status(400).json({ error: 'Bad result request' });
    const c = client();
    const runs = await Promise.all(runIds.map((id) => c.run(id).get()));
    if (runs.some((r) => !r)) return res.json({ state: 'error', error: 'Apify run not found' });
    const bad = runs.find((r) => ['FAILED', 'ABORTED', 'TIMED-OUT', 'TIMING-OUT', 'ABORTING'].includes(r.status));
    if (bad) return res.json({ state: 'error', error: `Apify run ${bad.status}${bad.statusMessage ? ': ' + bad.statusMessage : ''}` });
    if (runs.some((r) => r.status !== 'SUCCEEDED')) return res.json({ state: 'running' });
    const items = [];
    for (const r of runs) {
      for (let offset = 0; ;) {
        const page = await c.dataset(r.defaultDatasetId).listItems({ offset, limit: 1000, clean: true });
        items.push(...page.items);
        offset += page.items.length;
        if (!page.items.length || offset >= page.total) break;
      }
    }
    const parsed = T.parse(items, keys);
    res.json({ state: 'done', ...parsed, cost: runs.reduce((a, r) => a + Number(r.usageTotalUsd || 0), 0), itemCount: items.length });
  }));

  // Email when a long batch finishes or links failed after 3 retries (Resend; skipped if RESEND_API_KEY is not set).
  app.post('/api/u/notify', wrap(async (req, res) => {
    const { failures = [], summary = '', finished = false } = req.body || {};
    if (!failures.length && !finished) return res.json({ sent: false, reason: 'nothing to report' });
    if (!process.env.RESEND_API_KEY) return res.json({ sent: false, reason: 'RESEND_API_KEY is not set' });
    const rows = failures.slice(0, 200).map((f) => `<tr><td>${esc(f.row)}</td><td>${esc(f.platform)}</td><td><a href="${esc(f.link)}">${esc(f.link)}</a></td><td>${esc(f.task)}</td><td>${esc(f.error)}</td></tr>`).join('');
    const html = `<p>${esc(summary)}</p>` + (failures.length
      ? `<p>${failures.length} link(s) failed after 3 retries:</p><table border="1" cellpadding="4" cellspacing="0"><tr><th>Row</th><th>Platform</th><th>Link</th><th>Step</th><th>Error</th></tr>${rows}</table>`
      : '<p>No technical failures. Open the Universal tab to download the Excel.</p>');
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.MAIL_FROM || 'Social Metrics <onboarding@resend.dev>',
        to: [process.env.NOTIFY_EMAIL || 'priyanshu@sarvaa.co.in'],
        subject: failures.length ? `Social Metrics: batch finished, ${failures.length} link(s) failed after 3 retries` : 'Social Metrics: batch finished',
        html,
      }),
    });
    const body = await r.json().catch(() => ({}));
    res.json({ sent: r.ok, reason: r.ok ? null : (body && body.message) || `HTTP ${r.status}` });
  }));
};
