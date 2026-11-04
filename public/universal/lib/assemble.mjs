// Builds one output row (the 15 template columns) from scraped records, with all accuracy checks.
// Shared by the browser and the server (no imports except links.js).
import { parseLink, idTimeMs, PLATFORM_LABEL } from './links.mjs';

export const COLUMNS = ['Username', 'Page_name', 'Profile', 'Post_url', 'Published_at', 'Content_type', 'Caption', 'Likes', 'Comments',
  'Shares', 'Views', 'Followers', 'Engagement', 'Duration_seconds', 'Extracted_at'];
export const INPUT_COLUMNS = ['Username', 'Page_name', 'Profile', 'Post_url'];
const NUMERIC = ['Likes', 'Comments', 'Shares', 'Views', 'Followers', 'Engagement', 'Duration_seconds'];
const INVALID = 'INVALID';

export const COLORS = { red: 'F8CBAD', yellow: 'FFE699', grey: 'D9D9D9' };
// red = post / profile not available, yellow = technical failure or failed check, grey = not processed

export const isoUtc = (ms) => (ms == null || !Number.isFinite(ms) ? null : new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00'));
const s = (v) => (v == null ? '' : String(v).trim());
export const cleanOf = (v) => (s(v) ? parseLink(v)?.clean ?? s(v) : null);

// Keys used to look up results (same in pipeline + assemble).
export const postTask = { instagram: 'ig_post', x: 'x_post', facebook: 'fb_post', youtube: 'yt_video' };
export function profileTarget(row, R) {
  // Which account the profile columns describe: the Profile typed in the row, else the post's creator.
  const p = row.prof;
  if (p && p.kind === 'profile') {
    if (p.platform === 'instagram') return { platform: p.platform, task: 'ig_profile', key: p.handle, given: true };
    if (p.platform === 'x') {
      const t = row.post?.platform === 'x' ? R?.x_post?.records?.[row.post.id] : null;
      if (t && t.ownerHandle && t.ownerHandle.toLowerCase() === p.handle) return { platform: 'x', fromPost: true, given: true };
      return { platform: 'x', task: 'x_profile', key: p.handle, given: true };
    }
    if (p.platform === 'facebook') return { platform: 'facebook', task: 'fb_profile', key: p.clean, given: true };
    if (p.platform === 'youtube') {
      const e = row.post?.platform === 'youtube' ? R?.yt_extra?.records?.[row.post.id] : null;
      if (e && ((p.handle && e.channelHandle && p.handle === e.channelHandle.toLowerCase()) || (p.channelId && p.channelId === e.channelId))) {
        return { platform: 'youtube', fromPost: true, given: true };
      }
      return { platform: 'youtube', task: 'yt_profile', key: p.clean, given: true };
    }
    return null;
  }
  if (p && p.kind !== 'profile') return null; // typed Profile is not a usable profile link
  const post = row.post;
  if (!post || post.kind !== 'post') return null;
  if (post.platform === 'instagram') {
    const h = R?.ig_post?.records?.[post.id]?.ownerHandle;
    return h ? { platform: 'instagram', task: 'ig_profile', key: h } : null;
  }
  if (post.platform === 'x') return { platform: 'x', fromPost: true };
  if (post.platform === 'youtube') return { platform: 'youtube', fromPost: true };
  if (post.platform === 'facebook') {
    if (post.directReel) {
      const url = bestFbOwnerUrl(null, R?.fb_reel?.records?.[post.videoId]);
      return url ? { platform: 'facebook', task: 'fb_profile', key: url } : null;
    }
    const fp = R?.fb_post?.records?.[post.id];
    if (!fp) return null;
    const fr = fp.videoId ? R?.fb_reel?.records?.[fp.videoId] : null;
    const url = bestFbOwnerUrl(fp, fr);
    return url ? { platform: 'facebook', task: 'fb_profile', key: url } : null;
  }
  return null;
}
function bestFbOwnerUrl(fp, fr) {
  const real = (u) => u && !/profile\.php\?id=/.test(u);
  if (real(fp?.ownerUrl)) return fp.ownerUrl;
  if (real(fr?.ownerUrl)) return fr.ownerUrl;
  const id = fp?.ownerId || fr?.ownerId;
  return id ? `https://www.facebook.com/profile.php?id=${id}` : null;
}

// Look up a key in a task result: {status:'ok', rec} | {status:'unavailable', reason} | {status:'failed', error} | null
export function look(R, task, key) {
  const t = R?.[task];
  if (!t || key == null) return null;
  if (t.records?.[key]) return { status: 'ok', rec: t.records[key] };
  if (t.unavailable?.[key]) return { status: 'unavailable', reason: t.unavailable[key] };
  if (t.failed?.[key]) return { status: 'failed', error: t.failed[key] };
  return null;
}

// Merge platform records into one post object.
function getPost(row, R) {
  const p = row.post, L = PLATFORM_LABEL[p.platform];
  if (p.platform === 'facebook' && p.directReel) { // /reel/<id> link: the reels scraper alone (its item id must equal the link id)
    const x = look(R, 'fb_reel', p.videoId);
    if (!x) return { status: 'failed', error: 'Facebook: no result (not processed)', task: 'fb_reel' };
    if (x.status !== 'ok') return { ...x, task: 'fb_reel' };
    const fr = x.rec, n = 'Not shown publicly by Facebook for this post';
    return { status: 'ok', problems: [], post: {
      ownerHandle: null, ownerName: fr.ownerName, ownerUrl: bestFbOwnerUrl(null, fr), ownerId: fr.ownerId,
      publishedAt: fr.reelTime, contentType: 'video', caption: fr.caption, likes: null, comments: null, shares: null,
      views: fr.views, duration: fr.duration, notes: { likes: n, comments: n, shares: n },
    } };
  }
  const base = look(R, postTask[p.platform], p.id);
  if (!base) return { status: 'failed', error: `${L}: no result (not processed)`, task: postTask[p.platform] };
  if (base.status !== 'ok') return { ...base, task: postTask[p.platform] };
  const r = base.rec, notes = { ...(r.notes || {}) }, problems = [];
  if (p.platform === 'instagram' || p.platform === 'x') return { status: 'ok', post: { ...r, notes }, problems };
  if (p.platform === 'facebook') {
    let fr = null;
    if (r.videoId) {
      const x = look(R, 'fb_reel', r.videoId);
      if (x?.status === 'ok') fr = x.rec;
      else if (x?.status === 'failed') problems.push({ cols: ['Views', 'Duration_seconds'], color: 'yellow', note: `Facebook reel details failed: ${x.error}`, task: 'fb_reel', error: x.error });
      else problems.push({ cols: ['Views', 'Duration_seconds'], color: 'yellow', note: 'Facebook did not return views/duration for this video' });
    }
    if (fr && fr.ownerId && r.ownerId && fr.ownerId !== r.ownerId) {
      return { status: 'checkfail', error: 'Facebook: the two sources disagree on who posted this video, so nothing was filled' };
    }
    if (r.hiddenCounts) for (const c of ['likes', 'comments', 'shares']) notes[c] = 'Not shown publicly by Facebook for this post';
    return { status: 'ok', problems, post: {
      ownerHandle: null, ownerName: r.ownerName || fr?.ownerName || null, ownerUrl: bestFbOwnerUrl(r, fr), ownerId: r.ownerId || fr?.ownerId,
      publishedAt: fr?.reelTime ?? r.postTime ?? null, contentType: r.contentType, caption: r.caption ?? fr?.caption ?? null,
      likes: r.likes, comments: r.comments, shares: r.shares, views: fr ? fr.views : null, duration: fr ? fr.duration : null, notes,
    } };
  }
  if (p.platform === 'youtube') {
    const x = look(R, 'yt_extra', p.id);
    const e = x?.status === 'ok' ? x.rec : null;
    if (e && r.channelId && e.channelId && e.channelId !== r.channelId) {
      return { status: 'checkfail', error: 'YouTube: the two sources disagree on the channel, so nothing was filled' };
    }
    if (x?.status === 'failed') problems.push({ cols: ['Comments'], color: 'yellow', note: `YouTube comments lookup failed: ${x.error}`, task: 'yt_extra', error: x.error });
    if (e?.commentsOff) notes.comments = 'Comments are turned off on this video';
    return { status: 'ok', problems, post: {
      ownerHandle: e?.channelHandle || null, ownerName: r.channelName || e?.channelName || null,
      ownerUrl: e?.channelUrl || (r.channelId ? `https://www.youtube.com/channel/${r.channelId}` : null),
      ownerFollowers: e ? e.subscribers : null, followersRounded: true,
      publishedAt: r.publishedAt, contentType: 'video', caption: r.title, likes: r.likes, comments: e ? e.comments : null, shares: null,
      views: r.views, duration: r.duration, notes,
    } };
  }
  return { status: 'failed', error: 'Unknown platform' };
}

// Main: one input row -> { r, values, marks, status, failures }
export function assembleRow(row, R, settings, extractedAt) {
  const v = Object.fromEntries(COLUMNS.map((c) => [c, null]));
  const marks = {}; const failures = [];
  const mark = (cols, color, note) => { for (const c of [].concat(cols)) marks[c] = { color, note: marks[c]?.note && note ? `${marks[c].note} | ${note}` : note || marks[c]?.note || null }; };
  const markRow = (color, note, noteCol = 'Post_url') => { for (const c of COLUMNS) marks[c] = { color, note: null }; marks[noteCol] = { color, note }; };
  const typed = { Username: s(row.username) || null, Page_name: s(row.page_name) || null };
  v.Username = typed.Username; v.Page_name = typed.Page_name;
  v.Profile = cleanOf(row.profile); v.Post_url = cleanOf(row.post_url);
  if (!v.Username && !v.Page_name && !v.Profile && !v.Post_url) return { r: row.r, values: v, marks, status: 'empty', failures };

  const platform = row.post?.platform || row.prof?.platform || null;
  const on = (pl) => pl && settings.platforms?.[pl] !== false;
  let status = 'ok', filledSomething = false;

  // ── post part ──
  let post = null;
  if (row.post) {
    if (row.post.kind === 'profile') {
      mark('Post_url', 'grey', 'Post_url is a profile link, not a post: no post data');
      status = 'invalid';
    } else if (row.post.kind !== 'post') {
      markRow('grey', row.post.reason || 'Not a supported post link');
      status = 'invalid';
    } else if (!on(row.post.platform)) {
      markRow('grey', `Skipped: ${PLATFORM_LABEL[row.post.platform]} filling is switched off`);
      return { r: row.r, values: v, marks, status: 'skipped', failures };
    } else {
      const g = getPost(row, R);
      if (g.status === 'ok') {
        post = g.post; filledSomething = true;
        const P = post, idt = idTimeMs(row.post.platform, row.post.id);
        let pub = P.publishedAt;
        if (pub != null && idt != null) {
          const ok = row.post.platform === 'x' ? Math.abs(pub - idt) <= 5000 : pub >= idt - 120000;
          if (!ok) { pub = null; mark('Published_at', 'yellow', 'Publish time did not match the time inside the post id, so it was left blank'); }
        }
        v.Published_at = isoUtc(pub);
        v.Content_type = P.contentType || null;
        v.Caption = P.caption ?? null;
        const put = (col, val, noteKey) => {
          if (val === INVALID) { v[col] = null; mark(col, 'yellow', 'Value from the platform failed the number check, left blank'); return; }
          v[col] = val ?? null;
          if (val == null && P.notes?.[noteKey]) mark(col, null, P.notes[noteKey]);
        };
        put('Likes', P.likes, 'likes'); put('Comments', P.comments, 'comments'); put('Shares', P.shares, 'shares');
        put('Views', P.views, 'views'); put('Duration_seconds', P.duration, 'duration');
        for (const pr of g.problems || []) {
          for (const c of pr.cols) v[c] = null;
          mark(pr.cols, pr.color, pr.note);
          if (pr.error) failures.push({ task: pr.task, error: pr.error, link: v.Post_url });
          status = 'partial';
        }
        const nums = [v.Likes, v.Comments, v.Shares].filter((x) => typeof x === 'number');
        v.Engagement = nums.length ? nums.reduce((a, b) => a + b, 0) : null;
      } else if (g.status === 'unavailable') {
        markRow('red', g.reason || 'Post not available (deleted, private or not public)');
        status = 'unavailable';
      } else { // failed / checkfail
        markRow('yellow', g.error);
        if (g.status === 'failed') failures.push({ task: g.task, error: g.error, link: v.Post_url });
        status = g.status === 'checkfail' ? 'checkfail' : 'failed';
      }
    }
  } else if (row.prof && !on(row.prof.platform)) {
    markRow('grey', `Skipped: ${PLATFORM_LABEL[row.prof.platform] || 'platform'} filling is switched off`, 'Profile');
    return { r: row.r, values: v, marks, status: 'skipped', failures };
  }

  // ── profile part ──
  if (row.prof && row.prof.kind !== 'profile') mark('Profile', 'grey', row.prof.reason || 'Profile is not a profile link: profile details not filled');
  if (settings.profile) {
    const t = profileTarget(row, R);
    if (t && on(t.platform)) {
      let pr = null;
      if (t.fromPost) {
        if (post) {
          pr = { handle: post.ownerHandle, name: post.ownerName, url: post.ownerUrl, followers: post.ownerFollowers ?? null, rounded: post.followersRounded };
        } else if (row.post?.platform === t.platform) {
          const g = getPost(row, R);
          if (g.status === 'ok') pr = { handle: g.post.ownerHandle, name: g.post.ownerName, url: g.post.ownerUrl, followers: g.post.ownerFollowers ?? null, rounded: g.post.followersRounded };
        }
      } else {
        const x = look(R, t.task, t.key);
        if (x?.status === 'ok') pr = { ...x.rec, rounded: x.rec.rounded || t.platform === 'youtube' };
        else if (x?.status === 'failed') { mark('Followers', 'yellow', `Profile lookup failed: ${x.error}`); failures.push({ task: t.task, error: x.error, link: v.Profile || t.key }); if (status === 'ok') status = 'partial'; }
        else if (x?.status === 'unavailable' || !x) {
          mark('Followers', 'red', x?.reason || 'Profile not found, private or not public');
          if (!t.given && post) pr = { handle: post.ownerHandle, name: post.ownerName, url: post.ownerUrl, followers: null };
        }
      }
      if (pr) {
        filledSomething = true;
        v.Username = typed.Username || pr.handle || null;
        v.Page_name = typed.Page_name || pr.name || null;
        v.Profile = v.Profile || pr.url || null;
        if (pr.followers === INVALID) { v.Followers = null; mark('Followers', 'yellow', 'Value from the platform failed the number check, left blank'); }
        else v.Followers = pr.followers ?? null;
        if (v.Followers != null && pr.rounded) mark('Followers', null, 'YouTube shows subscribers rounded (e.g. 9.32K = 9,320)');
        if (v.Followers == null && !marks.Followers && t.platform === 'facebook') mark('Followers', null, 'Facebook does not show followers for this profile');
      }
    }
  }
  if (!row.post && row.prof?.kind === 'profile' && !settings.profile) status = 'as-typed';
  if (!row.post && !row.prof) status = 'as-typed'; // only names typed: nothing to fetch
  if (filledSomething) v.Extracted_at = extractedAt;
  return { r: row.r, values: v, marks, status, failures };
}

// Final guard: every output row must sit on the same row number as its input, with the typed values unchanged.
export function verifyAlignment(inputs, outputs) {
  const errors = [];
  const byR = new Map(outputs.map((o) => [o.r, o]));
  if (byR.size !== outputs.length) errors.push('Duplicate output row numbers');
  for (const i of inputs) {
    const o = byR.get(i.r);
    if (!o) { errors.push(`Row ${i.r}: missing in output`); continue; }
    const exp = { Post_url: cleanOf(i.post_url), Profile: s(i.profile) ? cleanOf(i.profile) : undefined,
      Username: s(i.username) || undefined, Page_name: s(i.page_name) || undefined };
    for (const [k, e] of Object.entries(exp)) {
      if (e === undefined) continue;
      if ((o.values[k] ?? null) !== e) errors.push(`Row ${i.r}: ${k} does not match the input`);
    }
    const empty = !s(i.username) && !s(i.page_name) && !s(i.profile) && !s(i.post_url);
    if (empty && COLUMNS.some((c) => o.values[c] != null)) errors.push(`Row ${i.r}: input row is empty but output has values`);
    for (const c of NUMERIC) {
      const x = o.values[c];
      if (x != null && !(Number.isInteger(x) && x >= 0)) errors.push(`Row ${i.r}: ${c} is not a whole number`);
    }
  }
  const inR = new Set(inputs.map((i) => i.r));
  for (const o of outputs) if (!inR.has(o.r)) errors.push(`Row ${o.r}: output row has no input row`);
  return errors;
}
