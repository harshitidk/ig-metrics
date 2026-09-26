const path = require('path');
require('dotenv').config();
const express = require('express');
const { ApifyClient } = require('apify-client');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
//
// Everything site-specific lives here (actor IDs, input keys, output format).
// Edit this block — nothing else in the file needs to change when you swap an
// actor or tweak the output shape.
// ─────────────────────────────────────────────────────────────────────────────
const CONFIG = {
  // ── Actor IDs (find on each actor's Apify page → "API" tab, or the store URL
  //    slug "owner~actor-name") ──
  // PRIMARY = the 128-field Instagram post scraper (Doc 1). Takes an ARRAY of
  // post/reel/tv URLs in one run, returns the widest set of fields. Default
  // source for almost everything.
  PRIMARY_ACTOR_ID: 'data-slayer/instagram-post-details',
  PRIMARY_INPUT_KEY: 'postUrls', // verified against live input schema — the bulk array field is `postUrls` (legacy single field is `postCode`)

  // FALLBACK = Instagram Reel Scraper (Doc 2). Adds reel-only fields (comment
  // detail, transcript, pinned, display/audio URLs, plays…) and gap-fills
  // values the primary hides (e.g. views == -1).
  FALLBACK_ACTOR_ID: 'apify/instagram-reel-scraper', // verified slug
  FALLBACK_INPUT_KEY: 'username', // verified against live input schema — the array field accepting reel URLs is `username`
  FALLBACK_ENABLED: true, // false = primary only

  // Results are matched to inputs by shortcode (actors reorder and normalise
  // /reel/ ↔ /p/). These are the keys we look at first on each actor's items;
  // if absent we extract the shortcode from the item's url field instead.
  PRIMARY_MATCH_KEY: 'code', // primary returns the shortcode as `code`
  FALLBACK_MATCH_KEY: 'shortCode',

  TIMEZONE: 'Asia/Kolkata', // IST, for datetime columns
  DATETIME_FORMAT: 'YYYY-MM-DD HH:MM', // 24h; informational — the formatter uses Intl 'en-CA' (see formatDatetime)
  BOOL_TRUE: 'Yes',
  BOOL_FALSE: 'No',
};

// ─────────────────────────────────────────────────────────────────────────────
// FIELD CATALOG — the single source of truth.
//
// Every column the app can output is one entry here. The UI checklist, the
// column order, and the extraction all derive from this array — add a field
// later = add one entry.
//
//   key      internal id (also the key sent by the frontend in `selected`)
//   label    checkbox label AND output column header
//   group    category (for grouping in the UI)
//   type     number | datetime | text | list | bool | url | comments
//   default  checked on load? (only the core four are true)
//   primary  field/path in the primary actor's item (or null if it doesn't provide it)
//   fallback field/path in the fallback actor's item (or null)
//   sub      for arrays of objects, the subkey to pull from each element (e.g. "username")
//
// Paths are dot-separated ("musicInfo.artist_name", "location.lat").
// Several keys below come from Doc 1's prose rather than its sample and may
// differ — they're marked `// verify key`. If one comes back always-blank, fix
// that single line here.
// ─────────────────────────────────────────────────────────────────────────────
// NOTE: the primary actor returns the RAW Instagram web-info JSON (358 keys),
// NOT the clean names its README claims. Every `primary` path below has been
// verified against a live run of a real reel. The fallback (reel scraper)
// returns clean names and its paths were verified against its sample output.
const FIELD_CATALOG = [
  // ── Engagement (numbers) ─────────────────────────────────────────────
  { key: 'likes',        label: 'Likes',              group: 'Engagement', type: 'number',  default: true,  primary: 'metrics.like_count',    fallback: 'likesCount' },
  { key: 'comments',     label: 'Comments',           group: 'Engagement', type: 'number',  default: true,  primary: 'metrics.comment_count', fallback: 'commentsCount' },
  { key: 'views',        label: 'Views',              group: 'Engagement', type: 'number',  default: true,  primary: 'metrics.view_count',    fallback: 'videoViewCount' }, // reels report plays, not views → often blank; tick Plays for reels
  { key: 'plays',        label: 'Plays',              group: 'Engagement', type: 'number',  default: false, primary: 'metrics.play_count',    fallback: 'videoPlayCount' },
  { key: 'shares',       label: 'Shares',             group: 'Engagement', type: 'number',  default: false, primary: 'metrics.share_count',   fallback: null },
  { key: 'saves',        label: 'Saves',              group: 'Engagement', type: 'number',  default: false, primary: 'metrics.save_count',    fallback: null },
  { key: 'reposts',      label: 'Reposts',            group: 'Engagement', type: 'number',  default: false, primary: 'metrics.repost_count',  fallback: null },

  // ── Timing ───────────────────────────────────────────────────────────
  { key: 'postedAt',     label: 'Posted time',        group: 'Timing',     type: 'datetime', default: true,  primary: 'taken_at',        fallback: 'timestamp' }, // unix epoch seconds
  { key: 'takenAt',      label: 'Taken at',           group: 'Timing',     type: 'datetime', default: false, primary: 'taken_at_date',   fallback: null }, // ISO string

  // ── Post / meta ──────────────────────────────────────────────────────
  { key: 'postUrl',      label: 'Post URL',           group: 'Post',       type: 'url',     default: false, primary: null,              fallback: 'url' },
  { key: 'shortcode',    label: 'Shortcode',          group: 'Post',       type: 'text',    default: false, primary: 'code',             fallback: 'shortCode' },
  { key: 'postId',       label: 'Post ID',            group: 'Post',       type: 'text',    default: false, primary: 'id',               fallback: 'id' },
  { key: 'postType',     label: 'Post type',          group: 'Post',       type: 'text',    default: false, primary: 'media_name',       fallback: 'type' }, // "reel" / "video" / "image" …
  { key: 'productType',  label: 'Product type',       group: 'Post',       type: 'text',    default: false, primary: 'product_type',     fallback: 'productType' }, // "clips" / "feed" / "igtv" …
  { key: 'caption',      label: 'Caption',            group: 'Post',       type: 'text',    default: false, primary: 'caption.text',     fallback: 'caption' }, // SANITIZE newlines
  { key: 'hashtags',     label: 'Hashtags',           group: 'Post',       type: 'list',    default: false, primary: 'caption.hashtags', fallback: 'hashtags' },
  { key: 'mentions',     label: 'Mentions',           group: 'Post',       type: 'list',    default: false, primary: 'caption.mentions', fallback: 'mentions' },
  { key: 'paidPartner',  label: 'Paid partnership',   group: 'Post',       type: 'bool',    default: false, primary: 'is_paid_partnership', fallback: 'paidPartnership' },
  { key: 'sponsors',     label: 'Sponsors',           group: 'Post',       type: 'list',    default: false, primary: 'sponsor_tags',   sub: 'sponsor.username', fallback: null },
  { key: 'taggedUsers',  label: 'Tagged users',       group: 'Post',       type: 'list',    default: false, primary: 'tagged_users',   sub: 'username',         fallback: 'taggedUsers' },
  { key: 'productTags',  label: 'Product tags',       group: 'Post',       type: 'list',    default: false, primary: 'featured_products', fallback: null }, // verify shape; rarely populated
  { key: 'isPinned',     label: 'Pinned',             group: 'Post',       type: 'bool',    default: false, primary: 'is_pinned',       fallback: 'isPinned' },
  { key: 'canReshare',   label: 'Can reshare',        group: 'Post',       type: 'bool',    default: false, primary: 'can_reshare',     fallback: null },
  { key: 'filterType',   label: 'Filter type',        group: 'Post',       type: 'text',    default: false, primary: 'filter_type',     fallback: null }, // numeric filter id (0 = none)
  { key: 'commentsOff',  label: 'Comments disabled',  group: 'Post',       type: 'bool',    default: false, primary: 'comments_disabled', fallback: 'isCommentsDisabled' },
  { key: 'altText',      label: 'Alt text',           group: 'Post',       type: 'text',    default: false, primary: 'accessibility_caption', fallback: 'alt' },

  // ── Creator / owner ──────────────────────────────────────────────────
  { key: 'ownerUsername',  label: 'Owner username',         group: 'Creator', type: 'text',   default: false, primary: 'user.username',           fallback: 'ownerUsername' },
  { key: 'ownerFullName',  label: 'Owner full name',        group: 'Creator', type: 'text',   default: false, primary: 'user.full_name',           fallback: 'ownerFullName' },
  { key: 'ownerId',        label: 'Owner ID',               group: 'Creator', type: 'text',   default: false, primary: 'user.id',                  fallback: 'ownerId' },
  { key: 'ownerVerified',  label: 'Owner verified',         group: 'Creator', type: 'bool',   default: false, primary: 'user.is_verified',          fallback: null },
  { key: 'ownerFollowers', label: 'Owner followers',        group: 'Creator', type: 'number', default: false, primary: 'metrics.user_follower_count', fallback: null }, // often null (primary rarely fetches it)
  { key: 'ownerBio',       label: 'Owner bio',              group: 'Creator', type: 'text',   default: false, primary: null,                fallback: null }, // not in either actor's output
  { key: 'ownerExtUrl',    label: 'Owner external URL',     group: 'Creator', type: 'url',    default: false, primary: null,                fallback: null }, // not in either actor's output
  { key: 'ownerCategory',  label: 'Owner business category',group: 'Creator', type: 'text',   default: false, primary: null,                fallback: null }, // not in either actor's output
  { key: 'ownerPic',       label: 'Owner profile pic',      group: 'Creator', type: 'url',    default: false, primary: 'user.profile_pic_url',     fallback: null },

  // ── Audio / music ────────────────────────────────────────────────────
  { key: 'audioTitle',   label: 'Audio title',        group: 'Audio',      type: 'text',    default: false, primary: 'clips_metadata.original_sound_info.original_audio_title', fallback: 'musicInfo.song_name' },
  { key: 'audioArtist',  label: 'Audio artist',       group: 'Audio',      type: 'text',    default: false, primary: 'clips_metadata.original_sound_info.ig_artist.full_name', fallback: 'musicInfo.artist_name' },
  { key: 'audioId',      label: 'Audio ID',           group: 'Audio',      type: 'text',    default: false, primary: 'clips_metadata.original_sound_info.audio_id', fallback: 'musicInfo.audio_id' },
  { key: 'origAudio',    label: 'Original audio',     group: 'Audio',      type: 'bool',    default: false, primary: null,              fallback: 'musicInfo.uses_original_audio' }, // primary has no clean boolean
  { key: 'musicGenre',   label: 'Music genre',        group: 'Audio',      type: 'text',    default: false, primary: null,              fallback: null }, // not in either actor's output
  { key: 'audioUrl',     label: 'Audio URL',          group: 'Audio',      type: 'url',     default: false, primary: 'clips_metadata.original_sound_info.progressive_download_url', fallback: 'audioUrl' },

  // ── Media / technical ────────────────────────────────────────────────
  { key: 'mediaUrl',      label: 'Media / video URL', group: 'Media',      type: 'url',     default: false, primary: 'video_url',      fallback: 'videoUrl' }, // blank on photos (expected)
  { key: 'thumbnailUrl',  label: 'Thumbnail URL',     group: 'Media',      type: 'url',     default: false, primary: 'thumbnail_url',  fallback: null },
  { key: 'displayUrl',    label: 'Display image URL', group: 'Media',      type: 'url',     default: false, primary: null,             fallback: 'displayUrl' },
  { key: 'images',        label: 'Image URLs',        group: 'Media',      type: 'list',    default: false, primary: 'image_versions.items', sub: 'url', fallback: 'images' },
  { key: 'videoDuration', label: 'Video duration (s)',group: 'Media',      type: 'number',  default: false, primary: 'video_duration', fallback: 'videoDuration' },
  { key: 'width',         label: 'Width',             group: 'Media',      type: 'number',  default: false, primary: 'original_width', fallback: 'dimensionsWidth' },
  { key: 'height',        label: 'Height',            group: 'Media',      type: 'number',  default: false, primary: 'original_height', fallback: 'dimensionsHeight' },
  { key: 'carouselCount', label: 'Carousel items',    group: 'Media',      type: 'number',  default: false, primary: null,             fallback: 'childPosts' }, // output = childPosts.length
  { key: 'transcript',    label: 'Transcript',        group: 'Media',      type: 'text',    default: false, primary: null,             fallback: 'transcript' }, // SANITIZE; reel-scraper only

  // ── Location ─────────────────────────────────────────────────────────
  { key: 'locationName', label: 'Location name',      group: 'Location',   type: 'text',    default: false, primary: 'location.name',    fallback: 'locationName' },
  { key: 'locationId',   label: 'Location ID',        group: 'Location',   type: 'text',    default: false, primary: 'location.pk',      fallback: 'locationId' },
  { key: 'locationLat',  label: 'Location lat',       group: 'Location',   type: 'number',  default: false, primary: 'location.lat',     fallback: null },
  { key: 'locationLng',  label: 'Location lng',       group: 'Location',   type: 'number',  default: false, primary: 'location.lng',     fallback: null },
  { key: 'locationAddr', label: 'Location address',   group: 'Location',   type: 'text',    default: false, primary: 'location.address', fallback: null },

  // ── Comments detail (reel scraper) ───────────────────────────────────
  { key: 'firstComment',  label: 'First comment',     group: 'Comments',   type: 'text',     default: false, primary: null, fallback: 'firstComment' }, // SANITIZE
  { key: 'latestComments',label: 'Latest comments',   group: 'Comments',   type: 'comments', default: false, primary: null, fallback: 'latestComments' }, // join "user: text | ..."; SANITIZE
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — path extraction + defensive value formatting.
// Every cell must end up free of tabs and newlines so the TSV paste spreads
// across Google Sheets cells instead of breaking rows.
// ─────────────────────────────────────────────────────────────────────────────

function extractShortcode(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
  return m ? m[1] : null;
}

// Dot-path getter that never throws on missing keys.
function getPath(obj, p) {
  if (obj == null || p == null) return undefined;
  const parts = String(p).split('.');
  let cur = obj;
  for (const part of parts) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

// Strip \r \n \t, collapse whitespace, trim.
function sanitize(v) {
  if (v == null) return '';
  return String(v)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

// Missing value detection (treat empty arrays as missing so a gap-fill can try).
function isMissing(v) {
  if (v == null || v === '') return true;
  if (Array.isArray(v) && v.length === 0) return true;
  return false;
}

// True when the primary actor's value for this field should fall through to
// the fallback actor (absent, empty, or Instagram's hidden-count sentinel -1).
function isPrimaryGap(field, v) {
  if (isMissing(v)) return true;
  if (field.type === 'number' && typeof v === 'number' && (v === -1 || Number.isNaN(v))) return true;
  return false;
}

function formatNumber(v) {
  if (Array.isArray(v)) v = v.length; // e.g. carouselCount = childPosts.length
  if (v == null || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  if (n === -1 || n < 0) return ''; // -1 = Instagram hidden-count sentinel
  return Math.round(n);
}

function formatDatetime(v) {
  if (v == null || v === '') return '';
  let ms;
  if (typeof v === 'number') {
    ms = v < 1e12 ? v * 1000 : v; // unix seconds → ms; already-ms otherwise
  } else if (typeof v === 'string') {
    const parsed = new Date(v);
    if (!Number.isNaN(parsed.getTime())) {
      ms = parsed.getTime();
    } else {
      const n = Number(v);
      if (Number.isNaN(n)) return '';
      ms = n < 1e12 ? n * 1000 : n;
    }
  } else if (v instanceof Date) {
    ms = v.getTime();
  } else {
    return '';
  }
  if (!Number.isFinite(ms)) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: CONFIG.TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function formatText(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'object') v = v.text ?? v.caption ?? v.content ?? '';
  return sanitize(v);
}

function formatList(v, sub) {
  if (!Array.isArray(v)) return formatText(v);
  const parts = v
    .map((el) => {
      let x;
      if (sub) x = el && typeof el === 'object' ? getPath(el, sub) : el;
      else if (el && typeof el === 'object') x = el.url ?? el.display_url ?? el.src ?? el.image_url ?? '';
      else x = el;
      return sanitize(x);
    })
    .filter((x) => x !== '');
  return parts.join(', ');
}

function formatComments(v) {
  if (!Array.isArray(v)) return '';
  const parts = v
    .map((c) => {
      if (!c || typeof c !== 'object') return '';
      const u = sanitize(c.ownerUsername ?? c.owner_username);
      const t = sanitize(c.text ?? c.comment);
      if (!u && !t) return '';
      return u ? `${u}: ${t}` : t;
    })
    .filter(Boolean);
  return parts.join(' | ');
}

function formatBool(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'string' && /^(false|0|no|off)$/i.test(v.trim())) return CONFIG.BOOL_FALSE;
  return v ? CONFIG.BOOL_TRUE : CONFIG.BOOL_FALSE;
}

function formatValue(field, v) {
  switch (field.type) {
    case 'number':   return formatNumber(v);
    case 'datetime': return formatDatetime(v);
    case 'text':     return formatText(v);
    case 'list':     return formatList(v, field.sub);
    case 'comments': return formatComments(v);
    case 'bool':     return formatBool(v);
    case 'url':      return sanitize(v);
    default:         return sanitize(v);
  }
}

// Pick the value for one field from primary + fallback items, then format it.
function resolveField(field, primaryItem, fallbackItem) {
  let v;
  if (field.primary != null) {
    const pv = getPath(primaryItem, field.primary);
    if (!isPrimaryGap(field, pv)) {
      v = pv;
    } else if (field.fallback != null && fallbackItem) {
      v = getPath(fallbackItem, field.fallback);
    } else {
      return '';
    }
  } else {
    // fallback-only field
    if (fallbackItem) v = getPath(fallbackItem, field.fallback);
    else return '';
  }
  return formatValue(field, v);
}

// ─────────────────────────────────────────────────────────────────────────────
// URL parsing + result mapping (matched by shortcode, never by array order).
// ─────────────────────────────────────────────────────────────────────────────

function parseUrls(raw) {
  const tokens = String(raw || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const seenShortcodes = new Set();
  const seenInvalid = new Set();
  const entries = [];
  const failed = [];
  for (const t of tokens) {
    const sc = extractShortcode(t);
    if (sc) {
      if (!seenShortcodes.has(sc)) {
        seenShortcodes.add(sc);
        entries.push({ shortcode: sc, url: t });
      }
    } else if (!seenInvalid.has(t)) {
      seenInvalid.add(t);
      failed.push({ url: t, reason: 'invalid url' });
    }
  }
  return { entries, failed };
}

function itemShortcode(item, matchKey) {
  if (!item) return null;
  const candidates = [matchKey, 'shortcode', 'shortCode', 'code'].filter(Boolean);
  for (const k of candidates) {
    if (typeof item[k] === 'string' && item[k]) return item[k];
  }
  for (const k of ['post_url', 'url', 'permalink', 'link', 'postUrl', 'mediaUrl']) {
    const s = item[k];
    if (typeof s === 'string') {
      const sc = extractShortcode(s);
      if (sc) return sc;
    }
  }
  return null;
}

function buildMap(items, matchKey) {
  const map = new Map();
  for (const item of items || []) {
    const sc = itemShortcode(item, matchKey);
    if (sc && !map.has(sc)) map.set(sc, item);
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// Apify client + actor runs (one automatic retry, batched — never per-URL).
// ─────────────────────────────────────────────────────────────────────────────

function getClient() {
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    throw new Error('APIFY_TOKEN is not set. Copy .env.example to .env and add your Apify token.');
  }
  return new ApifyClient({ token });
}

async function runActor(actorId, inputKey, urls) {
  if (!actorId || /REPLACE/i.test(actorId)) {
    throw new Error('Actor ID not configured — set PRIMARY_ACTOR_ID / FALLBACK_ACTOR_ID in the CONFIG block of server.js.');
  }
  const client = getClient();
  const attempt = async () => {
    const run = await client.actor(actorId).call({ [inputKey]: urls });
    if (!run || !run.defaultDatasetId) {
      throw new Error(`Actor ${actorId} returned no dataset.`);
    }
    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    return items || [];
  };
  try {
    return await attempt();
  } catch (err) {
    return await attempt(); // one retry; a second failure propagates
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Express app
// ─────────────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Single source of truth for the frontend checklist.
app.get('/api/fields', (req, res) => {
  res.json(FIELD_CATALOG);
});

app.post('/api/scrape', async (req, res) => {
  try {
    const body = req.body || {};
    const parsed = parseUrls(body.urls);
    if (parsed.entries.length === 0) {
      return res.status(400).json({ error: 'No valid Instagram URLs found. Paste post/reel/tv URLs.' });
    }

    const selectedKeys = Array.isArray(body.selected) ? body.selected : [];
    const selectedFields = selectedKeys
      .map((k) => FIELD_CATALOG.find((f) => f.key === k))
      .filter(Boolean);
    if (selectedFields.length === 0) {
      return res.status(400).json({ error: 'Select at least one field.' });
    }

    const urlsList = parsed.entries.map((e) => e.url);
    const needPrimary = selectedFields.some((f) => f.primary != null);
    const needFallbackAll = selectedFields.some((f) => f.primary == null && f.fallback != null);
    const fallbackEnabled = !!CONFIG.FALLBACK_ENABLED;

    let primaryMap = new Map();
    let fallbackMap = new Map();
    let usedFallback = false;

    // Fast path: when a fallback-only field is selected we know up front that
    // BOTH actors are needed, so run them concurrently — halves wall-clock time.
    if (needPrimary && fallbackEnabled && needFallbackAll) {
      const [primaryItems, fallbackItems] = await Promise.all([
        runActor(CONFIG.PRIMARY_ACTOR_ID, CONFIG.PRIMARY_INPUT_KEY, urlsList),
        runActor(CONFIG.FALLBACK_ACTOR_ID, CONFIG.FALLBACK_INPUT_KEY, urlsList),
      ]);
      primaryMap = buildMap(primaryItems, CONFIG.PRIMARY_MATCH_KEY);
      fallbackMap = buildMap(fallbackItems, CONFIG.FALLBACK_MATCH_KEY);
      usedFallback = true;
    } else {
      // One batched run of the primary actor for all URLs.
      if (needPrimary) {
        const items = await runActor(CONFIG.PRIMARY_ACTOR_ID, CONFIG.PRIMARY_INPUT_KEY, urlsList);
        primaryMap = buildMap(items, CONFIG.PRIMARY_MATCH_KEY);
      }

      if (fallbackEnabled) {
        let fallbackUrls = null;
        if (needFallbackAll) {
          fallbackUrls = urlsList; // a selected field is fallback-only → need it for every URL
        } else {
          // Gap-fill: only re-fetch URLs where a selected both-source field is
          // missing / hidden (-1) in the primary. Keeps the second run cheap.
          const bothFields = selectedFields.filter((f) => f.primary != null && f.fallback != null);
          fallbackUrls = urlsList.filter((u) => {
            const sc = extractShortcode(u);
            const item = primaryMap.get(sc);
            if (!item) return true;
            return bothFields.some((f) => isPrimaryGap(f, getPath(item, f.primary)));
          });
        }
        if (fallbackUrls && fallbackUrls.length > 0) {
          const items = await runActor(CONFIG.FALLBACK_ACTOR_ID, CONFIG.FALLBACK_INPUT_KEY, fallbackUrls);
          fallbackMap = buildMap(items, CONFIG.FALLBACK_MATCH_KEY);
          usedFallback = true;
        }
      }
    }

    // Assemble rows (URL always first), skipping URLs with no data at all.
    const columns = ['URL', ...selectedFields.map((f) => f.label)];
    const rows = [];
    const failed = [...parsed.failed];
    for (const e of parsed.entries) {
      const sc = e.shortcode;
      const primaryItem = primaryMap.get(sc);
      const fallbackItem = fallbackMap.get(sc);
      if (!primaryItem && !fallbackItem) {
        failed.push({ url: e.url, reason: 'no data (private / deleted / unavailable)' });
        continue;
      }
      const row = { URL: e.url };
      for (const f of selectedFields) {
        row[f.label] = resolveField(f, primaryItem, fallbackItem);
      }
      rows.push(row);
    }

    const lines = [columns.join('\t')];
    for (const row of rows) {
      lines.push(columns.map((c) => (row[c] == null ? '' : String(row[c]))).join('\t'));
    }
    const tsv = lines.join('\n');

    res.json({
      columns,
      rows,
      tsv,
      failed,
      counts: {
        requested: parsed.entries.length + parsed.failed.length,
        returned: rows.length,
        failed: failed.length,
      },
      usedFallback,
    });
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : 'Scrape failed.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  if (!process.env.APIFY_TOKEN) {
    console.warn('\n⚠  APIFY_TOKEN is not set. /api/fields works, but /api/scrape will fail until you add your token to .env.\n');
  }
  console.log(`IG Metrics Automator running at http://localhost:${PORT}`);
});
