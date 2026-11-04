// Batch runner (browser + Node). Talks to the server through `api`:
//   api.start(task, keys)              -> { runIds }
//   api.result(task, keys, runIds)     -> { state: 'running' } | { state: 'error', error } | { state: 'done', records, unavailable, cost }
// journal (optional): { get(sig) -> runIds|undefined, set(sig, runIds), del(sig) }  - lets a batch resume without paying twice.
import { parseLink, PLATFORM_LABEL } from './links.mjs';
import { assembleRow, profileTarget, verifyAlignment, isoUtc } from './assemble.mjs';

// Links per Apify run. x_profile: the actor takes one username per run.
export const CHUNK = { ig_post: 25, ig_profile: 50, x_post: 50, x_profile: 1, fb_post: 20, fb_reel: 20, fb_profile: 20, yt_video: 50, yt_extra: 30, yt_profile: 10 };
// Default memory of each actor (MB) - Apify counts this against the account memory limit.
export const TASK_MEM_MB = { ig_post: 1024, ig_profile: 1024, x_post: 512, x_profile: 256, fb_post: 4096, fb_reel: 4096, fb_profile: 1024, yt_video: 256, yt_extra: 1024, yt_profile: 1024 };
// Price on the Apify FREE tier (USD) - only for the estimate shown before a run; paid plans are cheaper.
export const PRICE = { ig_post: { item: 0.0025, run: 0.002 }, ig_profile: { item: 0.0026 }, x_post: { item: 0.00015 }, x_profile: { item: 0.00015 },
  fb_post: { item: 0.005, run: 0.001 }, fb_reel: { item: 0.005 }, fb_profile: { item: 0.012 }, yt_video: { item: 0.0001 }, yt_extra: { item: 0.004 }, yt_profile: { item: 0.008 } };
const IG_TASKS = new Set(['ig_post', 'ig_profile']);
export const IG_MAX_PARALLEL = 4;                       // Instagram blocks bursts; never more than 4 Instagram runs at once
export const RETRY_WAITS_MS = [20000, 60000, 120000];   // 3 retries after the first try
const POLL_MS = 4000, POLL_FAIL_MAX = 30, BUSY_WAIT_MS = 30000, BUSY_MAX = 60, RUN_GUARD_MS = 60 * 60 * 1000;
const NO_DATA = {
  ig_post: 'Instagram: no data after 2 checks (post deleted, private or not public)',
  x_post: 'X: no data after 2 checks (post deleted, protected or not public)',
  fb_post: 'Facebook: no data after 2 checks (post deleted, private or not public)',
  fb_reel: 'Facebook: no data after 2 checks (reel deleted, private or not public)',
  yt_video: 'YouTube: no data after 2 checks (video deleted, private or not public)',
  yt_extra: 'YouTube: comments/subscribers not available',
  ig_profile: 'Instagram profile not found or private',
  x_profile: 'X profile not found or suspended',
  fb_profile: 'Facebook profile/page not found or not public',
  yt_profile: 'YouTube channel not found',
};
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const memoryJournal = () => { const m = new Map(); return { get: (s) => m.get(s), set: (s, v) => m.set(s, v), del: (s) => m.delete(s) }; };

// One shared queue for every Apify run: never more runs / memory than the account allows, max 4 Instagram.
export function makeQueue({ maxJobs, maxMemMb }) {
  let jobs = 0, mem = 0, ig = 0, peakJobs = 0, peakIg = 0, peakMem = 0;
  const waiters = [];
  const fits = (t) => jobs < maxJobs && (mem + TASK_MEM_MB[t] <= maxMemMb || jobs === 0) && (!IG_TASKS.has(t) || ig < IG_MAX_PARALLEL);
  const take = (t) => {
    jobs++; mem += TASK_MEM_MB[t]; if (IG_TASKS.has(t)) ig++;
    peakJobs = Math.max(peakJobs, jobs); peakIg = Math.max(peakIg, ig); peakMem = Math.max(peakMem, mem);
  };
  const pump = () => { for (let i = 0; i < waiters.length;) { if (fits(waiters[i].t)) { const w = waiters.splice(i, 1)[0]; take(w.t); w.res(); } else i++; } };
  return {
    acquire: (t) => new Promise((res) => { if (!waiters.length && fits(t)) { take(t); res(); } else waiters.push({ t, res }); }),
    release: (t) => { jobs--; mem -= TASK_MEM_MB[t]; if (IG_TASKS.has(t)) ig--; pump(); },
    stats: () => ({ jobs, mem, ig, waiting: waiters.length, peakJobs, peakIg, peakMem, maxJobs, maxMemMb }),
  };
}

// What a batch will need (for the cost estimate before Run).
export function planBatch(rows, settings) {
  const on = (pl) => pl && settings.platforms?.[pl] !== false;
  const u = { ig_post: new Set(), x_post: new Set(), fb_post: new Set(), fb_reel: new Set(), yt_video: new Set(), prof: { instagram: new Set(), x: new Set(), facebook: new Set(), youtube: new Set() } };
  for (const r of rows) {
    const p = parseLink(r.post_url), q = parseLink(r.profile);
    if (p?.kind === 'post' && on(p.platform)) {
      if (p.platform === 'instagram') u.ig_post.add(p.id);
      if (p.platform === 'x') u.x_post.add(p.id);
      if (p.platform === 'facebook') { if (p.directReel) u.fb_reel.add(p.videoId); else { u.fb_post.add(p.id); u.fb_reel.add('?' + p.id); } }
      if (p.platform === 'youtube') u.yt_video.add(p.id);
    }
    if (settings.profile) {
      if (q?.kind === 'profile' && on(q.platform)) u.prof[q.platform].add(q.id);
      else if (p?.kind === 'post' && on(p.platform) && (p.platform === 'instagram' || p.platform === 'facebook')) u.prof[p.platform].add('post:' + p.id);
    }
  }
  const n = (t, k) => k * (PRICE[t].item || 0) + Math.ceil(k / CHUNK[t]) * (PRICE[t].run || 0);
  const posts = n('ig_post', u.ig_post.size) + n('x_post', u.x_post.size) + n('fb_post', u.fb_post.size) + n('fb_reel', u.fb_reel.size)
    + n('yt_video', u.yt_video.size) + n('yt_extra', u.yt_video.size);
  // profiles: upper bound (X/YouTube creators come free with the post; typed X/YouTube profiles may need a lookup)
  const profiles = n('ig_profile', u.prof.instagram.size) + n('fb_profile', u.prof.facebook.size) + n('x_profile', u.prof.x.size) + n('yt_profile', u.prof.youtube.size);
  const postCount = u.ig_post.size + u.x_post.size + u.fb_post.size + [...u.fb_reel].filter((x) => !x.startsWith('?')).length + u.yt_video.size;
  return { posts, profiles, total: posts + profiles, postCount, counts: { instagram: u.ig_post.size, x: u.x_post.size, facebook: u.fb_post.size + [...u.fb_reel].filter((x) => !x.startsWith('?')).length, youtube: u.yt_video.size } };
}

export async function runBatch({ rows, settings, api, limits = { maxJobs: 4, maxMemMb: 15360 }, journal = memoryJournal(), extractedAt = null,
  onLog = () => {}, onRow = () => {}, onProgress = () => {}, sleep = defaultSleep, retryWaits = RETRY_WAITS_MS }) {
  const startedAt = Date.now();
  extractedAt = extractedAt || isoUtc(startedAt);
  let cost = 0;
  const R = {};   // task -> { records, unavailable, failed }
  const on = (pl) => pl && settings.platforms?.[pl] !== false;
  const queue = makeQueue(limits);

  // ── progress (per stage: posts, then profiles) ──
  // One progress figure for the whole batch. total = estimate made at the start (posts + profiles), made exact when the
  // profile step starts; pct never goes backwards.
  const prog = { stage: 'posts', total: 0, done: 0, pct: 0 };
  const report = () => {
    const el = (Date.now() - startedAt) / 1000;
    const total = Math.max(prog.total, prog.done, 1);
    prog.pct = prog.stage === 'done' ? 100 : Math.max(prog.pct, Math.min(99, Math.floor((100 * prog.done) / total)));
    const eta = prog.stage === 'done' ? 0 : prog.done > 0 ? Math.round((el / prog.done) * Math.max(0, total - prog.done)) : null;
    onProgress({ stage: prog.stage, pct: prog.pct, done: prog.done, total, etaSeconds: eta, elapsed: Math.round(el), cost, queue: queue.stats() });
  };

  // ── 1. read every row ──
  const work = rows.map((x) => ({ ...x, post: parseLink(x.post_url), prof: parseLink(x.profile) }));
  const typedName = (w) => String(w.username || '').trim() || String(w.page_name || '').trim();
  for (const w of work) onRow(w.r, w.post || w.prof || typedName(w) ? 'waiting' : 'empty');

  // ── one Apify run: queue slot, start (or reuse from journal), poll ──
  async function startRun(task, keys) {
    for (let busy = 0; ; busy++) {
      try { return (await api.start(task, keys)).runIds; }
      catch (e) {
        const m = String(e?.message || e);
        if (/monthly|usage limit|payment|credit|balance|plan/i.test(m)) throw e;          // account out of money: real failure
        if (busy < BUSY_MAX && /memory limit|concurrent|too many|exceed/i.test(m)) {      // account busy (e.g. other runs): wait, not a retry
          onLog(`${task}: Apify account busy, waiting ${BUSY_WAIT_MS / 1000}s`); await sleep(BUSY_WAIT_MS); continue;
        }
        throw e;
      }
    }
  }
  async function runOnce(task, keys, sig) {
    await queue.acquire(task);
    report();
    try {
      let runIds = journal.get(sig);
      if (!runIds) { runIds = await startRun(task, keys); journal.set(sig, runIds); }
      const t0 = Date.now();
      let pollFails = 0;
      for (;;) {
        await sleep(POLL_MS);
        let res;
        try { res = await api.result(task, keys, runIds); pollFails = 0; }
        catch (e) { // network gone (laptop asleep, wifi): the Apify run keeps going, so keep waiting for it
          if (++pollFails >= POLL_FAIL_MAX) throw e;
          await sleep(Math.min(60000, 3000 * pollFails)); continue;
        }
        if (res.state === 'done') { cost += Number(res.cost || 0); return res; }
        if (res.state === 'error') { journal.del(sig); throw new Error(res.error || 'Apify run failed'); }
        if (Date.now() - t0 > RUN_GUARD_MS) { journal.del(sig); throw new Error('Run did not finish within 60 minutes'); }
      }
    } finally { queue.release(task); }
  }
  async function runChunk(task, keys) {
    const out = { records: {}, unavailable: {}, failed: {} };
    let pending = [...keys], retries = 0, phase = 'main';
    for (;;) {
      let res;
      const sig = `${task}|${phase}|${pending.join(',')}`;
      try { res = await runOnce(task, pending, sig); }
      catch (e) {
        const msg = String(e?.message || e).slice(0, 300);
        if (retries >= retryWaits.length) { for (const k of pending) out.failed[k] = `${msg} (after ${retries + 1} tries)`; break; }
        onLog(`${task}: technical error "${msg}" - retry ${retries + 1}/${retryWaits.length} in ${Math.round(retryWaits[retries] / 1000)}s`);
        await sleep(retryWaits[retries]); retries++;
        continue;
      }
      Object.assign(out.records, res.records || {});
      Object.assign(out.unavailable, res.unavailable || {});
      const missing = pending.filter((k) => !out.records[k] && !out.unavailable[k]);
      if (missing.length && phase === 'main') { // an empty result can mean "overloaded", so check once more before calling it unavailable
        phase = 'recheck'; pending = missing;
        onLog(`${task}: ${missing.length} returned no data - checking them once more`);
        continue;
      }
      for (const k of missing) out.unavailable[k] = NO_DATA[task] || 'Not available';
      break;
    }
    prog.done += keys.length; report();
    return out;
  }
  async function runTask(task, keys) {
    keys = [...new Set(keys.filter((k) => k != null && k !== ''))];
    if (!keys.length) return;
    const size = CHUNK[task] || 20, chunks = [];
    for (let i = 0; i < keys.length; i += size) chunks.push(keys.slice(i, i + size));
    report();
    onLog(`${task}: ${keys.length} item(s) in ${chunks.length} run(s)`);
    const parts = await Promise.all(chunks.map((c) => runChunk(task, c)));   // the shared queue decides how many run at once
    const merged = R[task] || { records: {}, unavailable: {}, failed: {} };
    for (const p of parts) { Object.assign(merged.records, p.records); Object.assign(merged.unavailable, p.unavailable); Object.assign(merged.failed, p.failed); }
    R[task] = merged;
    onLog(`${task}: ok ${Object.keys(merged.records).length}, not available ${Object.keys(merged.unavailable).length}, failed ${Object.keys(merged.failed).length}`);
  }

  // ── 2. post data ──
  const posts = work.filter((w) => w.post?.kind === 'post' && on(w.post.platform));
  { // estimate of all work, so the bar has one fixed end from the start
    const uniq = (pl) => new Set(posts.filter((w) => w.post.platform === pl).map((w) => w.post.id)).size;
    const profileGuess = settings.profile ? new Set(work.map((w) => (w.prof?.kind === 'profile' && on(w.prof.platform) ? w.prof.id
      : w.post?.kind === 'post' && on(w.post.platform) && ['instagram', 'facebook'].includes(w.post.platform) ? 'p:' + w.post.id : null)).filter(Boolean)).size : 0;
    prog.total = uniq('instagram') + uniq('x') + 2 * uniq('facebook') + 2 * uniq('youtube') + profileGuess;
  }
  for (const w of posts) onRow(w.r, 'running');
  const ids = (pl, f = () => true) => posts.filter((w) => w.post.platform === pl && f(w.post)).map((w) => w.post.id);
  await Promise.all([
    runTask('ig_post', ids('instagram')),
    runTask('x_post', ids('x')),
    (async () => {
      // direct /reel/ links go straight to the reels scraper (cheaper); share and other links are opened by the posts scraper first
      const direct = posts.filter((w) => w.post.platform === 'facebook' && w.post.directReel).map((w) => w.post.videoId);
      await runTask('fb_post', ids('facebook', (p) => !p.directReel));
      const vids = Object.values(R.fb_post?.records || {}).map((r) => r.videoId).filter(Boolean);
      await runTask('fb_reel', [...direct, ...vids]);
    })(),
    runTask('yt_video', ids('youtube')),
    runTask('yt_extra', ids('youtube')),
  ]);

  // ── 3. profile data (only when the toggle is on) ──
  if (settings.profile) {
    const need = {};
    for (const w of work) {
      const pl = w.prof?.platform || w.post?.platform;
      if (!on(pl)) continue;
      const t = profileTarget(w, R);
      if (t && t.task && on(t.platform)) (need[t.task] ||= []).push(t.key);
    }
    prog.stage = 'profiles';
    prog.total = prog.done + Object.values(need).reduce((a, k) => a + new Set(k).size, 0); // now exact
    report();
    for (const w of work) if (w.prof?.kind === 'profile' && on(w.prof.platform)) onRow(w.r, 'running');
    await Promise.all(Object.entries(need).map(([task, keys]) => runTask(task, keys)));
  }

  // ── 4. build rows + final row check ──
  const outputs = work.map((w) => assembleRow(w, R, settings, extractedAt));
  for (const o of outputs) onRow(o.r, o.status);
  const alignErrors = verifyAlignment(rows, outputs);
  const failures = [];
  for (const o of outputs) for (const f of o.failures) failures.push({ row: o.r, ...f, platform: PLATFORM_LABEL[(parseLink(f.link) || {}).platform] || '' });
  prog.stage = 'done'; report();
  return { outputs, failures, alignErrors, cost, extractedAt, seconds: Math.round((Date.now() - startedAt) / 1000), results: R, queue: queue.stats() };
}
