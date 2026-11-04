// Server side: one entry per scraping task.
//   runs(keys)            -> [{ actor, input }]   (Apify runs to start)
//   parse(items, keys)    -> { records: {key: rec}, unavailable: {key: reason} }
// Keys not in records or unavailable = "no data returned" (the pipeline re-checks them once).
// Every record is keyed by an id read from the item itself (or the input the actor echoes back),
// never by item order.
import { parseLink } from './links.mjs';

const INVALID = 'INVALID';
export function num(v) {
  if (v === null || v === undefined || v === '' || v === 'None' || v === 'null') return null;
  const n = Number(String(v).replace(/,/g, ''));
  if (!Number.isFinite(n) || n < 0) return INVALID;
  return Math.round(n);
}
export function isoUtc(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');
}
const epochMs = (v) => (v == null || v === '' || v === 'None' ? null : Number(v) * 1000);
const isoMs = (v) => { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };
const text = (v) => (v == null || v === '' || v === 'None' ? null : String(v));
const trimName = (v) => (text(v) ? String(v).trim() : null);
function xDateMs(s) { // "Sun Oct 11 05:44:10 +0000 2026"
  const m = String(s || '').match(/^\w{3} (\w{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) ([+-]\d{4}) (\d{4})$/);
  if (!m) return null;
  const mon = 'JanFebMarAprMayJunJulAugSepOctNovDec'.indexOf(m[1]) / 3;
  const off = (m[6][0] === '-' ? -1 : 1) * (Number(m[6].slice(1, 3)) * 60 + Number(m[6].slice(3))) * 60000;
  return Date.UTC(Number(m[7]), mon, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])) - off;
}
const list = (v) => (Array.isArray(v) ? v : []);
// X sends short posts with &, <, > coded as &amp; &lt; &gt; (long posts come plain). Decode once, &amp; last.
const xText = (v) => (text(v) == null ? null : String(v).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'));

export const TASKS = {
  // ── Instagram post: data-slayer/instagram-post-details (same actor Harshit's site uses) ──
  ig_post: {
    chunk: 25,
    runs: (keys) => [{ actor: 'data-slayer/instagram-post-details', input: { postUrls: keys.map((c) => `https://www.instagram.com/p/${c}/`) } }],
    parse(items, keys) {
      const records = {}, unavailable = {};
      for (const it of items) {
        if (!it.code) continue; // error items ("failed_to_fetch_post_details") stay "no data" and are re-checked
        const u = it.user || {}, m = it.metrics || {};
        const mt = Number(it.media_type);
        const hidden = it.like_and_view_counts_disabled === true || it.like_and_view_counts_disabled === 'True';
        records[it.code] = {
          id: it.code,
          ownerHandle: text(u.username)?.toLowerCase() || null,
          ownerName: trimName(u.full_name),
          ownerUrl: u.username ? `https://www.instagram.com/${String(u.username).toLowerCase()}/` : null,
          publishedAt: epochMs(it.taken_at),
          contentType: mt === 8 ? 'carousel' : mt === 2 ? 'video' : mt === 1 ? 'image' : null,
          caption: text(it.caption?.text),
          likes: hidden && (m.like_count == null) ? null : num(m.like_count),
          comments: num(m.comment_count),
          shares: num(m.share_count),
          views: mt === 2 ? num(m.play_count) : null,
          duration: it.video_duration != null && mt === 2 ? num(it.video_duration) : null,
          notes: hidden && m.like_count == null ? { likes: 'Likes hidden by creator' } : {},
        };
      }
      return { records, unavailable };
    },
  },

  // ── Instagram profile: apify/instagram-profile-scraper ──
  ig_profile: {
    chunk: 50,
    runs: (keys) => [{ actor: 'apify/instagram-profile-scraper', input: { usernames: keys } }],
    parse(items) {
      const records = {}, unavailable = {};
      for (const it of items) {
        const h = text(it.username)?.toLowerCase();
        if (!h) continue;
        records[h] = { key: h, handle: h, name: trimName(it.fullName), followers: num(it.followersCount), url: `https://www.instagram.com/${h}/` };
      }
      return { records, unavailable };
    },
  },

  // ── X post: scrape.badger/twitter-tweets-scraper ──
  x_post: {
    chunk: 50,
    runs: (keys) => [{ actor: 'scrape.badger/twitter-tweets-scraper', input: { mode: 'Get a Few Tweets', tweets: keys.join(',') } }],
    parse(items) {
      const records = {}, unavailable = {};
      for (const it of items) {
        const id = text(it.id);
        if (!id || !/^\d+$/.test(id)) continue;
        const media = list(it.media);
        const types = media.map((m) => m && m.type);
        const vid = media.find((m) => m && (m.type === 'video' || m.type === 'animated_gif'));
        const rp = num(it.retweet_count), qt = num(it.quote_count);
        records[id] = {
          id,
          ownerHandle: text(it.username),
          ownerName: trimName(xText(it.user_name)),
          ownerUrl: it.username ? `https://x.com/${it.username}` : null,
          ownerFollowers: num(it.user_followers_count),
          publishedAt: xDateMs(it.created_at),
          contentType: vid ? 'video' : types.length > 1 ? 'carousel' : types.length === 1 ? 'image' : 'text',
          caption: xText(it.full_text) ?? xText(it.text),
          likes: num(it.favorite_count),
          comments: num(it.reply_count),
          shares: rp === INVALID || qt === INVALID ? INVALID : rp == null && qt == null ? null : (rp || 0) + (qt || 0),
          views: num(it.view_count),
          duration: vid && vid.duration_ms != null ? num(Number(vid.duration_ms) / 1000) : null,
          notes: {},
        };
      }
      return { records, unavailable };
    },
  },

  // ── X profile: scrape.badger/twitter-user-scraper (one run per username) ──
  x_profile: {
    chunk: 10,
    runs: (keys) => keys.map((k) => ({ actor: 'scrape.badger/twitter-user-scraper', input: { mode: 'Get User by Username', username: k } })),
    parse(items) {
      const records = {}, unavailable = {};
      for (const it of items) {
        const h = text(it.username)?.toLowerCase();
        if (!h) continue;
        records[h] = { key: h, handle: it.username, name: trimName(xText(it.name)), followers: num(it.followers_count), url: `https://x.com/${it.username}` };
      }
      return { records, unavailable };
    },
  },

  // ── Facebook post: apify/facebook-posts-scraper (opens share links, gives owner + page-post counts) ──
  fb_post: {
    chunk: 20,
    runs: (keys) => [{ actor: 'apify/facebook-posts-scraper', input: { startUrls: keys.map((url) => ({ url })), resultsLimit: 1 } }],
    parse(items, keys) {
      const records = {}, unavailable = {};
      const keyOf = (u) => {
        if (!u) return null;
        if (keys.includes(u)) return u;
        const p = parseLink(u);
        return p && keys.includes(p.clean) ? p.clean : null;
      };
      for (const it of items) {
        const k = keyOf(it.facebookUrl) || keyOf(it.inputUrl);
        if (!k || records[k]) continue;
        if (it.error) { if (/not.?found|unavailable|removed|deleted/i.test(String(it.error))) unavailable[k] = 'Facebook: post not found or not public'; continue; }
        let videoId = null, ownerId = null, ownerName = null, ownerUrl = null, t = null, rec = {};
        if (it.postId) { // normal post shape (pages / public posts)
          const m = String(it.url || '').match(/\/(?:reel|videos)\/(?:[^/]+\/)?(\d+)|[?&]v=(\d+)/);
          videoId = m ? m[1] || m[2] : null;
          ownerId = text(it.user?.id); ownerName = trimName(it.user?.name); ownerUrl = text(it.user?.profileUrl);
          t = isoMs(it.time) ?? epochMs(it.timestamp);
          const media = list(it.media);
          rec = { caption: text(it.text), likes: num(it.likes), comments: num(it.comments), shares: num(it.shares),
            contentType: it.isVideo === true || it.isVideo === 'True' || videoId ? 'video' : media.length > 1 ? 'carousel' : media.length === 1 ? 'image' : 'text' };
        } else if (it.__typename === 'Video' || it.videoId) { // reel shared from a personal profile
          videoId = text(it.videoId) || text(it.id);
          ownerId = text(it.owner?.id);
          t = epochMs(it.publish_time);
          rec = { caption: null, likes: null, comments: null, shares: null, contentType: 'video', hiddenCounts: true };
        } else if (it.id) { // encoded id "S:_I<owner>:VK:<video>"
          let dec = '';
          try { dec = typeof atob === 'function' ? atob(it.id) : Buffer.from(String(it.id), 'base64').toString('utf8'); } catch { dec = ''; }
          const m = dec.match(/^S:_I(\d+):VK:(\d+)$/);
          if (!m) continue;
          ownerId = m[1]; videoId = m[2];
          const vo = it.short_form_video_context?.video_owner || {};
          if (vo.id && String(vo.id) !== ownerId) continue; // owner disagrees inside one item: do not trust it
          ownerName = trimName(vo.name); ownerUrl = text(vo.url);
          t = epochMs(it.creation_time);
          rec = { caption: null, likes: null, comments: null, shares: null, contentType: 'video', hiddenCounts: true };
        } else continue;
        records[k] = { id: k, videoId, ownerId, ownerName, ownerUrl: ownerUrl || (ownerId ? `https://www.facebook.com/profile.php?id=${ownerId}` : null),
          ownerHandle: null, postTime: t, ...rec };
      }
      return { records, unavailable };
    },
  },

  // ── Facebook reel/video: apify/facebook-reels-scraper (views, duration, upload time) ──
  fb_reel: {
    chunk: 20,
    runs: (keys) => [{ actor: 'apify/facebook-reels-scraper', input: { startUrls: keys.map((id) => ({ url: `https://www.facebook.com/reel/${id}/` })), resultsLimit: 1 } }],
    parse(items, keys) {
      const records = {}, unavailable = {};
      for (const it of items) {
        const k = String(it.inputUrl || it.facebookUrl || '').match(/\/reel\/(\d+)/)?.[1];
        if (!k || !keys.includes(k) || records[k]) continue;
        const vidId = text(it.video?.id);
        if (vidId && vidId !== k) continue; // item is a different reel than asked for
        const vo = it.video_owner || {};
        records[k] = { id: k, views: num(it.play_count), reelTime: isoMs(it.time), caption: text(it.text),
          duration: it.video?.playable_duration_in_ms != null ? num(Number(it.video.playable_duration_in_ms) / 1000) : null,
          ownerId: text(vo.id), ownerName: trimName(vo.name), ownerUrl: text(vo.url) };
      }
      return { records, unavailable };
    },
  },

  // ── Facebook profile/page: apify/facebook-pages-scraper (followers, page name) ──
  fb_profile: {
    chunk: 20,
    runs: (keys) => [{ actor: 'apify/facebook-pages-scraper', input: { startUrls: keys.map((url) => ({ url })) } }],
    parse(items, keys) {
      const records = {}, unavailable = {};
      for (const it of items) {
        const k = keys.includes(it.facebookUrl) ? it.facebookUrl : keys.includes(it.inputUrl) ? it.inputUrl : null;
        if (!k || records[k]) continue;
        if (it.error) continue;
        const handle = text(it.pageName);
        records[k] = { key: k, id: text(it.facebookId) || text(it.pageId), handle: handle && !/^\d+$/.test(handle) && !/\/people\//.test(k) ? handle : null, // /people/<name>/<id> pages have no username, pageName is only the name in the link
          name: trimName(it.title), followers: num(it.followers), url: k };
      }
      return { records, unavailable };
    },
  },

  // ── YouTube video: thenetaji/youtube-video-details-scraper (exact views/likes, duration, time) ──
  yt_video: {
    chunk: 50,
    runs: (keys) => [{ actor: 'thenetaji/youtube-video-details-scraper', input: { videoIds: keys.map((id) => `https://www.youtube.com/watch?v=${id}`) } }],
    parse(items) {
      const records = {}, unavailable = {};
      for (const it of items) {
        const id = text(it.id);
        if (!id) continue;
        records[id] = { id, title: text(it.title), views: num(it.viewCount), likes: num(it.likeCount), duration: num(it.lengthSeconds),
          publishedAt: isoMs(it.publishDate || it.publishedAt), channelId: text(it.channelId), channelName: trimName(it.channelTitle),
          isPrivate: it.isPrivate === true };
      }
      return { records, unavailable };
    },
  },

  // ── YouTube extra: streamers/youtube-scraper (comments, subscribers, channel handle) ──
  yt_extra: {
    chunk: 30,
    runs: (keys) => [{ actor: 'streamers/youtube-scraper', input: { startUrls: keys.map((id) => ({ url: `https://www.youtube.com/watch?v=${id}` })), maxResults: 0, maxResultsShorts: 0, maxResultStreams: 0 } }],
    parse(items) {
      const records = {}, unavailable = {};
      for (const it of items) {
        const id = text(it.id);
        if (!id) continue;
        records[id] = { id, comments: it.commentsTurnedOff === true ? null : num(it.commentsCount), commentsOff: it.commentsTurnedOff === true,
          subscribers: num(it.numberOfSubscribers), channelHandle: text(it.channelUsername), channelUrl: text(it.channelUrl),
          channelId: text(it.channelId), channelName: trimName(it.channelName), views: num(it.viewCount) };
      }
      return { records, unavailable };
    },
  },

  // ── YouTube channel (given channel link): streamers/youtube-scraper, 1 video from the channel ──
  yt_profile: {
    chunk: 10,
    runs: (keys) => [{ actor: 'streamers/youtube-scraper', input: { startUrls: keys.map((url) => ({ url })), maxResults: 1, maxResultsShorts: 1, maxResultStreams: 0 } }],
    parse(items, keys) {
      const records = {}, unavailable = {};
      for (const it of items) {
        const inp = typeof it.input === 'string' ? it.input : it.input?.url || it.inputUrl;
        let k = keys.includes(inp) ? inp : null;
        if (!k) { // match by handle / channel id when the input is not echoed
          k = keys.find((key) => {
            const p = parseLink(key);
            return (p?.handle && it.channelUsername && p.handle === String(it.channelUsername).toLowerCase()) ||
              (p?.channelId && p.channelId === it.channelId);
          }) || null;
        }
        if (!k || records[k]) continue;
        const p = parseLink(k);
        if (p?.handle && it.channelUsername && p.handle !== String(it.channelUsername).toLowerCase()) continue; // different channel
        if (p?.channelId && it.channelId && p.channelId !== it.channelId) continue;
        records[k] = { key: k, handle: text(it.channelUsername), name: trimName(it.channelName), followers: num(it.numberOfSubscribers),
          id: text(it.channelId), url: k, rounded: true };
      }
      return { records, unavailable };
    },
  },
};
export const TASK_NAMES = Object.keys(TASKS);
