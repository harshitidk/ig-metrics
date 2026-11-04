// Batch runner (browser + Node). Talks to the server through `api`:
//   api.start(task, keys)              -> { runIds }
//   api.result(task, keys, runIds)     -> { state: 'running' } | { state: 'error', error } | { state: 'done', records, unavailable, cost }
// journal (optional) remembers every run by the links it fetched, so a resumed batch reuses finished (or still running) runs
// for any link it already asked for - whatever way the links get grouped this time:
//   find(task, phase, key) -> entry | null      add(task, phase, keys, runIds) -> entry      drop(entry)
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
export const IG_MAX_PARALLEL = 4;                       // Instagram blocks bursts; default max Instagram runs at once (limits.igMax overrides)
export const RETRY_WAITS_MS = [20000, 60000, 120000];   // 3 retries after the first try
const POLL_MS = 2000, POLL_FAIL_MAX = 30, BUSY_WAIT_MS = 30000, BUSY_MAX = 60, RUN_GUARD_MS = 60 * 60 * 1000;
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
export function memoryJournal() {
  const idx = new Map();
  return {
    find: (task, phase, k) => (idx.get(`${task}|${phase}`) || []).find((e) => e.keys.includes(k)) || null,
    add: (task, phase, keys, runIds) => { const e = { task, phase, keys, runIds }; const l = idx.get(`${task}|${phase}`) || []; l.push(e); idx.set(`${task}|${phase}`, l); return e; },
    drop: (e) => { const l = idx.get(`${e.task}|${e.phase}`) || []; const i = l.indexOf(e); if (i >= 0) l.splice(i, 1); },
  };
}

// One shared queue for every Apify run: never more runs / memory than the account allows, limited Instagram.
export function makeQueue({ maxJobs, maxMemMb, igMax = IG_MAX_PARALLEL }) {
  let jobs = 0, mem = 0, ig = 0, peakJobs = 0, peakIg = 0, peakMem = 0;
  const waiters = [];
  const fits = (t) => jobs < maxJobs && (mem + TASK_MEM_MB[t] <= maxMemMb || jobs === 0) && (!IG_TASKS.has(t) || ig < igMax);
  const take = (t) => {
    jobs++; mem += TASK_MEM_MB[t]; if (IG_TASKS.has(t)) ig++;
    peakJobs = Math.max(peakJobs, jobs); peakIg = Math.max(peakIg, ig); peakMem = Math.max(peakMem, mem);
  };
  // waiters are kept in priority order (posts first, then profiles), first come first served inside a priority
  const pump = () => { for (let i = 0; i < waiters.length;) { if (fits(waiters[i].t)) { const w = waiters.splice(i, 1)[0]; take(w.t); w.res(); } else i++; } };
  return {
    acquire: (t, prio = 0) => new Promise((res) => {
      if (!waiters.some((w) => w.prio <= prio) && fits(t)) { take(t); res(); return; }
      const at = waiters.findIndex((w) => w.prio > prio);
      waiters.splice(at < 0 ? waiters.length : at, 0, { t, prio, res });
    }),
    release: (t) => { jobs--; mem -= TASK_MEM_MB[t]; if (IG_TASKS.has(t)) ig--; pump(); },
    stats: () => ({ jobs, mem, ig, waiting: waiters.length, peakJobs, peakIg, peakMem, maxJobs, maxMemMb, igMax }),
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
  const fbCount = u.fb_post.size + [...u.fb_reel].filter((x) => !x.startsWith('?')).length;
  return { posts, profiles, total: posts + profiles, postCount: u.ig_post.size + u.x_post.size + fbCount + u.yt_video.size,
    counts: { instagram: u.ig_post.size, x: u.x_post.size, facebook: fbCount, youtube: u.yt_video.size } };
}

export async function runBatch({ rows, settings, api, limits = { maxJobs: 4, maxMemMb: 15360 }, journal = memoryJournal(), extractedAt = null,
  onLog = () => {}, onRow = () => {}, onProgress = () => {}, sleep = defaultSleep, retryWaits = RETRY_WAITS_MS }) {
  const startedAt = Date.now();
  extractedAt = extractedAt || isoUtc(startedAt);
  let cost = 0;
  const R = {};   // task -> { records, unavailable, failed }  (filled chunk by chunk)
  const on = (pl) => pl && settings.platforms?.[pl] !== false;
  const queue = makeQueue(limits);

  // ── progress: one figure for the whole batch, never goes backwards ──
  const prog = { stage: 'posts', total: 0, registered: 0, done: 0, pct: 0 };
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

  // ── one Apify run: queue slot, start (or reuse a saved run), poll ──
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
  const PROFILE_TASKS = new Set(['ig_profile', 'x_profile', 'fb_profile', 'yt_profile']);
  async function runOnce(task, phase, keys, entry) {
    await queue.acquire(task, PROFILE_TASKS.has(task) ? 1 : 0);
    report();
    try {
      if (!entry) entry = journal.add(task, phase, keys, await startRun(task, keys));
      const t0 = Date.now();
      let pollFails = 0;
      for (;;) {
        await sleep(POLL_MS);
        let res;
        try { res = await api.result(task, entry.keys, entry.runIds); pollFails = 0; }
        catch (e) { // network gone (laptop asleep, wifi): the Apify run keeps going, so keep waiting for it
          if (++pollFails >= POLL_FAIL_MAX) throw e;
          await sleep(Math.min(60000, 3000 * pollFails)); continue;
        }
        if (res.state === 'done') { cost += Number(res.cost || 0); return res; }
        if (res.state === 'error') { journal.drop(entry); throw new Error(res.error || 'Apify run failed'); }
        if (Date.now() - t0 > RUN_GUARD_MS) { journal.drop(entry); throw new Error('Run did not finish within 60 minutes'); }
      }
    } finally { queue.release(task); }
  }
  // Fetch `keys`: links already in a saved run are read back from that run (no cost); only the rest start a new run.
  async function fetchKeys(task, phase, keys) {
    const want = new Set(keys), saved = new Map(), fresh = [];
    for (const k of keys) {
      const e = journal.find(task, phase, k);
      if (e) { if (!saved.has(e)) saved.set(e, []); saved.get(e).push(k); } else fresh.push(k);
    }
    const parts = await Promise.all([...[...saved.keys()].map((e) => runOnce(task, phase, e.keys, e)), fresh.length ? runOnce(task, phase, fresh, null) : null]);
    const out = { records: {}, unavailable: {} };
    for (const p of parts) {
      if (!p) continue;
      for (const [k, v] of Object.entries(p.records || {})) if (want.has(k)) out.records[k] = v;
      for (const [k, v] of Object.entries(p.unavailable || {})) if (want.has(k)) out.unavailable[k] = v;
    }
    return out;
  }
  async function runChunk(task, keys) {
    const out = { records: {}, unavailable: {}, failed: {} };
    let pending = [...keys], retries = 0, phase = 'main';
    for (;;) {
      let res;
      try { res = await fetchKeys(task, phase, pending); }
      catch (e) {
        const msg = String(e?.message || e).slice(0, 300);
        if (retries >= retryWaits.length) { for (const k of pending) out.failed[k] = `${msg} (after ${retries + 1} tries)`; break; }
        onLog(`${task}: technical error "${msg}" - retry ${retries + 1}/${retryWaits.length} in ${Math.round(retryWaits[retries] / 1000)}s`);
        await sleep(retryWaits[retries]); retries++;
        continue;
      }
      Object.assign(out.records, res.records);
      Object.assign(out.unavailable, res.unavailable);
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
  // Results go into R chunk by chunk, so later steps can start as soon as their input is ready.
  async function runTask(task, keys, onChunk) {
    keys = [...new Set(keys.filter((k) => k != null && k !== ''))];
    if (!keys.length) return;
    const merged = (R[task] ||= { records: {}, unavailable: {}, failed: {} });
    keys = keys.filter((k) => !merged.records[k] && !merged.unavailable[k] && !merged.failed[k]);
    if (!keys.length) return;
    prog.registered += keys.length; if (prog.registered > prog.total) prog.total = prog.registered;
    const size = CHUNK[task] || 20, chunks = [];
    for (let i = 0; i < keys.length; i += size) chunks.push(keys.slice(i, i + size));
    report();
    onLog(`${task}: ${keys.length} item(s) in ${chunks.length} run(s)`);
    await Promise.all(chunks.map(async (c) => {   // the shared queue decides how many run at once
      const p = await runChunk(task, c);
      Object.assign(merged.records, p.records); Object.assign(merged.unavailable, p.unavailable); Object.assign(merged.failed, p.failed);
      if (onChunk) await onChunk(c, p);
    }));
    onLog(`${task}: ok ${Object.keys(merged.records).length}, not available ${Object.keys(merged.unavailable).length}, failed ${Object.keys(merged.failed).length}`);
  }

  // ── profiles: started as soon as the account behind a row is known (each profile fetched once) ──
  // Profiles are collected and started only in full batches while posts are still running (so there are no extra,
  // smaller runs); whatever is left starts when the posts are done.
  const asked = {};          // task -> Set of keys already asked for
  const waiting = {};        // task -> keys collected, not started yet
  const profJobs = [];
  function flushProfiles(all) {
    for (const [task, keys] of Object.entries(waiting)) {
      const size = CHUNK[task] || 20;
      while (keys.length >= size || (all && keys.length)) profJobs.push(runTask(task, keys.splice(0, size)));
    }
  }
  function requestProfiles(rowsList) {
    if (!settings.profile) return;
    for (const w of rowsList) {
      const pl = w.prof?.platform || w.post?.platform;
      if (!on(pl)) continue;
      const t = profileTarget(w, R);
      if (!t || !t.task || !on(t.platform)) continue;
      const s = (asked[t.task] ||= new Set());
      if (!s.has(t.key)) { s.add(t.key); (waiting[t.task] ||= []).push(t.key); }
    }
    flushProfiles(false);
  }
  // a typed profile can start right away, unless it may turn out to be the post's own author (X / YouTube give that for free with the post)
  const startsNow = (w) => w.prof?.kind === 'profile' && on(w.prof.platform) &&
    (['instagram', 'facebook'].includes(w.prof.platform) || w.post?.kind !== 'post' || w.post.platform !== w.prof.platform || !on(w.post.platform));
  const rowsOf = (pl, keyOf) => { const m = new Map(); for (const w of work) if (w.post?.kind === 'post' && w.post.platform === pl) { const k = keyOf(w.post); if (!m.has(k)) m.set(k, []); m.get(k).push(w); } return m; };
  const byChunk = (m) => (c) => requestProfiles(c.flatMap((k) => m.get(k) || []));

  // ── 2. post data (profiles start alongside) ──
  const posts = work.filter((w) => w.post?.kind === 'post' && on(w.post.platform));
  { // estimate of all work, so the bar has one fixed end from the start
    const uniq = (pl) => new Set(posts.filter((w) => w.post.platform === pl).map((w) => w.post.id)).size;
    const profileGuess = settings.profile ? new Set(work.map((w) => (w.prof?.kind === 'profile' && on(w.prof.platform) ? w.prof.id
      : w.post?.kind === 'post' && on(w.post.platform) && ['instagram', 'facebook'].includes(w.post.platform) ? 'p:' + w.post.id : null)).filter(Boolean)).size : 0;
    prog.total = uniq('instagram') + uniq('x') + 2 * uniq('facebook') + 2 * uniq('youtube') + profileGuess;
  }
  for (const w of posts) onRow(w.r, 'running');
  for (const w of work) if (w.prof?.kind === 'profile' && on(w.prof.platform)) onRow(w.r, 'running');
  requestProfiles(work.filter(startsNow));
  const ids = (pl, f = () => true) => posts.filter((w) => w.post.platform === pl && f(w.post)).map((w) => w.post.id);
  const igRows = rowsOf('instagram', (p) => p.id), xRows = rowsOf('x', (p) => p.id), ytRows = rowsOf('youtube', (p) => p.id), fbRows = rowsOf('facebook', (p) => p.id);
  await Promise.all([
    runTask('ig_post', ids('instagram'), byChunk(igRows)),
    runTask('x_post', ids('x'), byChunk(xRows)),
    (async () => {
      // direct /reel/ links go straight to the reels scraper (cheaper); share and other links are opened by the posts scraper first.
      // Each reel lookup starts as soon as its own posts-scraper batch is done.
      const reelRows = new Map(), reelJobs = [];
      const addReel = (vid, w) => { if (!reelRows.has(vid)) reelRows.set(vid, []); reelRows.get(vid).push(w); };
      for (const w of posts) if (w.post.platform === 'facebook' && w.post.directReel) addReel(w.post.videoId, w);
      const reelChunk = (c) => requestProfiles(c.flatMap((v) => reelRows.get(v) || []));
      reelJobs.push(runTask('fb_reel', [...reelRows.keys()], reelChunk));
      await runTask('fb_post', ids('facebook', (p) => !p.directReel), (c, p) => {
        const vids = [];
        for (const k of c) {
          const rec = p.records[k];
          if (rec?.videoId) {
            if (!reelRows.has(rec.videoId)) vids.push(rec.videoId); // same reel from two links: fetched once
            for (const w of fbRows.get(k) || []) addReel(rec.videoId, w);
          }
          else requestProfiles(fbRows.get(k) || []); // not a video: the owner is known now
        }
        if (vids.length) reelJobs.push(runTask('fb_reel', vids, reelChunk));
      });
      for (let i = 0; i < reelJobs.length; i++) await reelJobs[i];
    })(),
    runTask('yt_video', ids('youtube')),
    runTask('yt_extra', ids('youtube'), byChunk(ytRows)),
  ]);

  // ── 3. any profile not started yet (e.g. a source failed), then wait for all of them ──
  if (settings.profile) {
    prog.stage = 'profiles';
    requestProfiles(work);
    flushProfiles(true);
    prog.total = prog.registered; // now exact
    report();
    for (let i = 0; i < profJobs.length; i++) await profJobs[i];
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
