// Link parsing: works in the browser and in Node (no imports).
// parseLink(text) -> null (empty) or
//   { platform: 'instagram'|'x'|'facebook'|'youtube'|null,
//     kind: 'post'|'profile'|'unsupported'|'invalid',
//     id,      // post: shortcode / tweet id / FB clean url / YT video id ; profile: lookup key
//     clean,   // cleaned link written to the output
//     reason } // only for unsupported / invalid

export const PLATFORMS = ['instagram', 'x', 'facebook', 'youtube'];
export const PLATFORM_LABEL = { instagram: 'Instagram', x: 'X', facebook: 'Facebook', youtube: 'YouTube' };

const IG_RESERVED = new Set(['p', 'reel', 'reels', 'tv', 'stories', 'explore', 'accounts', 'direct', 'about', 'developer', 'legal', 's', 'share', 'web', 'api']);
const X_RESERVED = new Set(['i', 'home', 'search', 'hashtag', 'intent', 'explore', 'notifications', 'messages', 'settings', 'share', 'compose', 'login', 'signup', 'tos', 'privacy']);
const FB_RESERVED = new Set(['share', 'reel', 'reels', 'watch', 'videos', 'story.php', 'permalink.php', 'photo', 'photo.php', 'photos', 'groups', 'events',
  'marketplace', 'login', 'login.php', 'people', 'profile.php', 'hashtag', 'pages', 'gaming', 'help', 'policies', 'privacy', 'search', 'home.php']);

export function normalizeInput(s) {
  if (s == null) return '';
  let t = String(s).trim().replace(/\s+/g, '');
  if (!t) return '';
  if (!/^[a-z]+:\/\//i.test(t)) t = 'https://' + t.replace(/^\/+/, '');
  return t;
}

const bad = (raw, platform, kind, reason) => ({ raw, platform, kind, id: null, clean: String(raw).trim(), reason });

export function parseLink(raw) {
  const s = normalizeInput(raw);
  if (!s) return null;
  let u;
  try { u = new URL(s); } catch { return bad(raw, null, 'invalid', 'Not a valid link'); }
  const host = u.hostname.toLowerCase().replace(/^(www\.|m\.|mobile\.|web\.|mbasic\.|touch\.)/, '');
  const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const low = parts.map((p) => p.toLowerCase());

  // ── Instagram ──
  if (host === 'instagram.com' || host === 'instagr.am') {
    const i = low.findIndex((p) => ['p', 'reel', 'reels', 'tv'].includes(p));
    if (i >= 0 && parts[i + 1]) {
      let code = parts[i + 1];
      if (!/^[A-Za-z0-9_-]+$/.test(code)) return bad(raw, 'instagram', 'invalid', 'Instagram post code is not valid');
      if (code.length >= 28) code = code.slice(0, 11); // private-share links carry a long code; the post code is the first 11 characters
      const type = low[i] === 'reels' ? 'reel' : low[i];
      return { raw, platform: 'instagram', kind: 'post', id: code, clean: `https://www.instagram.com/${type}/${code}/` };
    }
    if (low[0] === 'stories') return bad(raw, 'instagram', 'unsupported', 'Instagram story links are not supported (stories expire)');
    if (low[0] === 'share') return bad(raw, 'instagram', 'unsupported', 'Instagram share link: open it and copy the full post link');
    if (parts[0] && !IG_RESERVED.has(low[0]) && /^[A-Za-z0-9._]{1,30}$/.test(parts[0])) {
      const h = low[0];
      return { raw, platform: 'instagram', kind: 'profile', id: h, handle: h, clean: `https://www.instagram.com/${h}/` };
    }
    return bad(raw, 'instagram', 'invalid', 'Not an Instagram post or profile link');
  }

  // ── X / Twitter ──
  if (host === 'x.com' || host === 'twitter.com') {
    const i = low.findIndex((p) => p === 'status' || p === 'statuses');
    if (i >= 0) {
      const id = (parts[i + 1] || '').match(/^\d+/)?.[0];
      if (!id) return bad(raw, 'x', 'invalid', 'X post link has no post id');
      const user = i > 0 && !['i', 'web'].includes(low[0]) ? parts[0] : 'i';
      return { raw, platform: 'x', kind: 'post', id, clean: `https://x.com/${user}/status/${id}` };
    }
    if (parts[0] && !X_RESERVED.has(low[0]) && /^[A-Za-z0-9_]{1,15}$/.test(parts[0])) {
      return { raw, platform: 'x', kind: 'profile', id: low[0], handle: low[0], clean: `https://x.com/${parts[0]}` };
    }
    return bad(raw, 'x', 'invalid', 'Not an X post or profile link');
  }

  // ── Facebook ──
  if (host === 'facebook.com' || host === 'fb.com' || host === 'fb.watch') {
    const q = u.searchParams;
    const post = (clean, videoId = null) => ({ raw, platform: 'facebook', kind: 'post', id: clean, videoId, clean });
    if (host === 'fb.watch') return parts[0] ? post(`https://fb.watch/${parts[0]}/`) : bad(raw, 'facebook', 'invalid', 'Not a Facebook link');
    if (low[0] === 'share' && parts[1]) {
      if (/^[a-z]$/.test(low[1]) && parts[2]) return post(`https://www.facebook.com/share/${low[1]}/${parts[2]}/`);
      return post(`https://www.facebook.com/share/${parts[1]}/`);
    }
    if ((low[0] === 'reel' || low[0] === 'reels') && /^\d+$/.test(parts[1] || '')) return { ...post(`https://www.facebook.com/reel/${parts[1]}/`, parts[1]), directReel: true };
    if (low[0] === 'watch' && /^\d+$/.test(q.get('v') || '')) return post(`https://www.facebook.com/watch/?v=${q.get('v')}`, q.get('v'));
    const vi = low.indexOf('videos');
    if (vi >= 0) {
      const vid = [...parts.slice(vi + 1)].reverse().find((p) => /^\d+$/.test(p));
      if (vid) return post(`https://www.facebook.com/${parts.slice(0, vi + 1).join('/')}/${vid}/`.replace('/videos/videos/', '/videos/'), vid);
    }
    if (low.includes('posts') || low.includes('permalink')) return post(`https://www.facebook.com/${parts.join('/')}/`);
    if (['story.php', 'permalink.php'].includes(low[0]) && q.get('story_fbid')) {
      return post(`https://www.facebook.com/${low[0]}?story_fbid=${q.get('story_fbid')}&id=${q.get('id') || ''}`);
    }
    if (['photo', 'photo.php'].includes(low[0]) && q.get('fbid')) return post(`https://www.facebook.com/photo/?fbid=${q.get('fbid')}`);
    if (low[0] === 'profile.php' && /^\d+$/.test(q.get('id') || '')) {
      const id = q.get('id');
      return { raw, platform: 'facebook', kind: 'profile', id: `id:${id}`, fbId: id, clean: `https://www.facebook.com/profile.php?id=${id}` };
    }
    if (low[0] === 'people' && parts[1] && /^\d+$/.test(parts[2] || '')) {
      return { raw, platform: 'facebook', kind: 'profile', id: `id:${parts[2]}`, fbId: parts[2], clean: `https://www.facebook.com/people/${parts[1]}/${parts[2]}/` };
    }
    if (parts.length === 1 && !FB_RESERVED.has(low[0]) && /^[A-Za-z0-9.\-]{2,}$/.test(parts[0])) {
      return { raw, platform: 'facebook', kind: 'profile', id: `v:${low[0]}`, handle: low[0], clean: `https://www.facebook.com/${parts[0]}` };
    }
    return bad(raw, 'facebook', 'unsupported', 'This kind of Facebook link is not supported');
  }

  // ── YouTube ──
  if (host === 'youtube.com' || host === 'youtu.be' || host === 'music.youtube.com') {
    const ok = (v) => /^[A-Za-z0-9_-]{11}$/.test(v || '');
    let vid = null, shorts = false;
    if (host === 'youtu.be') vid = parts[0];
    else if (low[0] === 'shorts') { vid = parts[1]; shorts = true; }
    else if (['live', 'embed', 'v'].includes(low[0])) vid = parts[1];
    else if (low[0] === 'watch') vid = u.searchParams.get('v');
    if (vid != null) {
      if (!ok(vid)) return bad(raw, 'youtube', 'invalid', 'YouTube video id is not valid');
      return { raw, platform: 'youtube', kind: 'post', id: vid, clean: shorts ? `https://www.youtube.com/shorts/${vid}` : `https://www.youtube.com/watch?v=${vid}` };
    }
    if (parts[0] && parts[0].startsWith('@')) {
      const h = parts[0].slice(1).toLowerCase();
      return { raw, platform: 'youtube', kind: 'profile', id: `@${h}`, handle: h, clean: `https://www.youtube.com/@${parts[0].slice(1)}` };
    }
    if (low[0] === 'channel' && /^UC[A-Za-z0-9_-]{22}$/.test(parts[1] || '')) {
      return { raw, platform: 'youtube', kind: 'profile', id: `ch:${parts[1]}`, channelId: parts[1], clean: `https://www.youtube.com/channel/${parts[1]}` };
    }
    if ((low[0] === 'c' || low[0] === 'user') && parts[1]) {
      return { raw, platform: 'youtube', kind: 'profile', id: `${low[0]}:${parts[1].toLowerCase()}`, clean: `https://www.youtube.com/${low[0]}/${parts[1]}` };
    }
    return bad(raw, 'youtube', 'invalid', 'Not a YouTube video or channel link');
  }

  return bad(raw, null, 'unsupported', 'Platform not supported (only Instagram, X, Facebook, YouTube)');
}

// Time encoded inside the post id (used to cross-check Published_at).
const A64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export function idTimeMs(platform, id) {
  try {
    if (platform === 'instagram') {
      let n = 0n;
      for (const ch of id) { const v = A64.indexOf(ch); if (v < 0) return null; n = n * 64n + BigInt(v); }
      return Number((n >> 23n) + 1314220021721n);
    }
    if (platform === 'x') return Number((BigInt(id) >> 22n) + 1288834974657n);
  } catch { /* fall through */ }
  return null;
}
