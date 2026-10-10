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
  // PRIMARY = the 128-field Instagram post scraper. Takes an ARRAY of
  // post/reel/tv URLs in one run, returns the widest set of fields. Default
  // source for almost everything.
  PRIMARY_ACTOR_ID: 'data-slayer/instagram-post-details',
  PRIMARY_INPUT_KEY: 'postUrls', // verified against live input schema — the bulk array field is `postUrls` (legacy single field is `postCode`)

  // FALLBACK = Instagram Reel Scraper. Adds reel-only fields (comment detail,
  // transcript, pinned, display/audio URLs, plays…) and gap-fills values the
  // primary hides.
  FALLBACK_ACTOR_ID: 'apify/instagram-reel-scraper', // verified slug
  FALLBACK_INPUT_KEY: 'username', // verified against live input schema — the array field accepting reel URLs is `username`
  FALLBACK_ENABLED: true, // false = primary only

  // COMMENTS = a dedicated comments extractor (full comment lists, top comments).
  // The user will supply the actor ID + input key; leave disabled until then.
  COMMENTS_ACTOR_ID: 'REPLACE_WITH_COMMENTS_ACTOR_ID', // TODO: set this
  COMMENTS_INPUT_KEY: 'urls', // TODO: verify on the actor's Input tab
  COMMENTS_MATCH_KEY: 'shortcode', // TODO: verify which field carries the post shortcode
  COMMENTS_ENABLED: false, // flip to true once the actor is configured

  // How many input links to send per actor run. Larger batches mean fewer
  // actor-start charges and let the actor pace its own requests (Instagram
  // rate-limits bursts of small runs far more aggressively).
  BATCH_SIZE: 25,
  BATCH_DELAY_MS: 2000, // pause between batches to avoid tripping rate limits

  // How many parallel worker runs to split a bulk submission across. The full
  // link list is divided evenly and each worker scrapes its own share at the
  // same time, so a big batch finishes in ~1/CONCURRENCY of the time. Capped
  // by your Apify plan's max concurrent runs (32 on the free/paid plans).
  CONCURRENCY: 32,

  // Retry URLs that come back with no data. Instagram rate limits cause
  // transient failures; keep retrying until every URL has data, capped only by
  // RETRY_MAX_ROUNDS (a hard safety net for permanently private/deleted URLs).
  RETRY_ENABLED: true,
  RETRY_MAX_ROUNDS: 4, // total rounds incl. first pass; stops early once all URLs resolve (or no progress is made)
  RETRY_DELAY_MS: 1500, // pause before each retry round

  // Per-run actor attempts. A single actor call can fail transiently (network
  // blip, Apify hiccup); retry it this many times inside `runActor` before
  // giving up on that call. Combined with the round-level retry above, a
  // failed call is never fatal to the job.
  MAX_RUN_ATTEMPTS: 5,

  // Results are matched to inputs by shortcode (actors reorder and normalise
  // /reel/ ↔ /p/). These are the keys we look at first on each actor's items;
  // if absent we extract the shortcode from the item's url field instead.
  PRIMARY_MATCH_KEY: 'code', // primary returns the shortcode as `code`
  FALLBACK_MATCH_KEY: 'shortCode',

  // Fallback cache. The reel scraper is the most expensive actor and its
  // fields (transcript, display/audio URLs, comment text) change slowly, so
  // they are cached per shortcode. Primary metrics are intentionally NOT
  // cached so counts stay fresh for time-series snapshots.
  FALLBACK_CACHE_ENABLED: true,
  FALLBACK_CACHE_TTL_MS: 60 * 60 * 1000, // 1 hour (set to 0 to disable)

  TIMEZONE: 'Asia/Kolkata', // IST, for datetime columns
  DATETIME_FORMAT: 'HH:MM:SS AM/PM', // informational — the formatter uses Intl (see formatDatetime)
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
//   group    category (for sub-grouping in the UI)
//   bucket   'recommended' | 'advanced' — which top-level checklist section it lives in
//   type     number | datetime | date | text | list | bool | url | comments
//   default  checked on load? (only the core four are true)
//   primary  field/path in the primary actor's item (or null)
//   fallback field/path in the fallback actor's item (or null)
//   comments field/path in the comments actor's item (or null)
//   sub      for arrays of objects, the subkey to pull from each element (e.g. "username")
//
// Paths are dot-separated ("musicInfo.artist_name", "location.lat").
// ─────────────────────────────────────────────────────────────────────────────
// NOTE: the primary actor returns the RAW Instagram web-info JSON (358 keys),
// NOT the clean names its README claims. Every `primary` path below has been
// verified against a live run of a real reel. The fallback (reel scraper)
// returns clean names and its paths were verified against its sample output.
const FIELD_CATALOG = [
  // ── Engagement (numbers) ─────────────────────────────────────────────
  { key: 'likes',        label: 'Likes',              group: 'Engagement', bucket: 'recommended', type: 'number',  default: true,  primary: 'metrics.like_count',    fallback: 'likesCount' },
  { key: 'comments',     label: 'Comments',           group: 'Engagement', bucket: 'recommended', type: 'number',  default: true,  primary: 'metrics.comment_count', fallback: 'commentsCount' },
  { key: 'views',        label: 'Views',              group: 'Engagement', bucket: 'recommended', type: 'number',  default: true,  primary: 'metrics.play_count',    fallback: 'videoPlayCount' }, // reels report plays → map to play count so it always shows
  { key: 'plays',        label: 'Plays',              group: 'Engagement', bucket: 'recommended', type: 'number',  default: false, primary: 'metrics.ig_play_count', fallback: 'videoPlayCount' },
  { key: 'shares',       label: 'Shares',             group: 'Engagement', bucket: 'recommended', type: 'number',  default: false, primary: 'metrics.share_count',   fallback: null },
  { key: 'saves',        label: 'Saves',              group: 'Engagement', bucket: 'recommended', type: 'number',  default: false, primary: 'metrics.save_count',    fallback: null },
  { key: 'reposts',      label: 'Reposts',            group: 'Engagement', bucket: 'recommended', type: 'number',  default: false, primary: 'metrics.repost_count',  fallback: null },

  // ── Timing ───────────────────────────────────────────────────────────
  { key: 'postedAt',     label: 'Posted time',        group: 'Timing',     bucket: 'recommended', type: 'datetime', default: true,  primary: 'taken_at',        fallback: 'timestamp' }, // unix epoch seconds
  { key: 'postedDate',   label: 'Posted date',        group: 'Timing',     bucket: 'recommended', type: 'date',     default: false, primary: 'taken_at',        fallback: 'timestamp' }, // "D Month YYYY"
  { key: 'takenAt',      label: 'Taken at',           group: 'Timing',     bucket: 'advanced',    type: 'datetime', default: false, primary: 'taken_at_date',   fallback: null }, // ISO string

  // ── Post / meta ──────────────────────────────────────────────────────
  { key: 'caption',      label: 'Caption',            group: 'Post',       bucket: 'recommended', type: 'text',    default: false, primary: 'caption.text',     fallback: 'caption' }, // SANITIZE newlines
  { key: 'postUrl',      label: 'Post URL',           group: 'Post',       bucket: 'advanced',    type: 'url',     default: false, primary: null,              fallback: 'url' },
  { key: 'shortcode',    label: 'Shortcode',          group: 'Post',       bucket: 'advanced',    type: 'text',    default: false, primary: 'code',             fallback: 'shortCode' },
  { key: 'postId',       label: 'Post ID',            group: 'Post',       bucket: 'advanced',    type: 'text',    default: false, primary: 'id',               fallback: 'id' },
  { key: 'postType',     label: 'Post type',          group: 'Post',       bucket: 'advanced',    type: 'text',    default: false, primary: 'media_name',       fallback: 'type' }, // "reel" / "video" / "image" …
  { key: 'productType',  label: 'Product type',       group: 'Post',       bucket: 'advanced',    type: 'text',    default: false, primary: 'product_type',     fallback: 'productType' }, // "clips" / "feed" / "igtv" …
  { key: 'hashtags',     label: 'Hashtags',           group: 'Post',       bucket: 'advanced',    type: 'list',    default: false, primary: 'caption.hashtags', fallback: 'hashtags' },
  { key: 'mentions',     label: 'Mentions',           group: 'Post',       bucket: 'advanced',    type: 'list',    default: false, primary: 'caption.mentions', fallback: 'mentions' },
  { key: 'paidPartner',  label: 'Paid partnership',   group: 'Post',       bucket: 'advanced',    type: 'bool',    default: false, primary: 'is_paid_partnership', fallback: 'paidPartnership' },
  { key: 'sponsors',     label: 'Sponsors',           group: 'Post',       bucket: 'advanced',    type: 'list',    default: false, primary: 'sponsor_tags',   sub: 'sponsor.username', fallback: null },
  { key: 'taggedUsers',  label: 'Tagged users',       group: 'Post',       bucket: 'advanced',    type: 'list',    default: false, primary: 'tagged_users',   sub: 'username',         fallback: 'taggedUsers' },
  { key: 'productTags',  label: 'Product tags',       group: 'Post',       bucket: 'advanced',    type: 'list',    default: false, primary: 'featured_products', fallback: null }, // verify shape; rarely populated
  { key: 'isPinned',     label: 'Pinned',             group: 'Post',       bucket: 'advanced',    type: 'bool',    default: false, primary: 'is_pinned',       fallback: 'isPinned' },
  { key: 'canReshare',   label: 'Can reshare',        group: 'Post',       bucket: 'advanced',    type: 'bool',    default: false, primary: 'can_reshare',     fallback: null },
  { key: 'filterType',   label: 'Filter type',        group: 'Post',       bucket: 'advanced',    type: 'text',    default: false, primary: 'filter_type',     fallback: null }, // numeric filter id (0 = none)
  { key: 'commentsOff',  label: 'Comments disabled',  group: 'Post',       bucket: 'advanced',    type: 'bool',    default: false, primary: 'comments_disabled', fallback: 'isCommentsDisabled' },
  { key: 'altText',      label: 'Alt text',           group: 'Post',       bucket: 'advanced',    type: 'text',    default: false, primary: 'accessibility_caption', fallback: 'alt' },

  // ── Creator / owner ──────────────────────────────────────────────────
  { key: 'ownerUsername',  label: 'Owner username',         group: 'Creator', bucket: 'recommended', type: 'text',   default: false, primary: 'user.username',           fallback: 'ownerUsername' },
  { key: 'ownerFullName',  label: 'Owner full name',        group: 'Creator', bucket: 'recommended', type: 'text',   default: false, primary: 'user.full_name',           fallback: 'ownerFullName' },
  { key: 'ownerId',        label: 'Owner ID',               group: 'Creator', bucket: 'advanced',    type: 'text',   default: false, primary: 'user.id',                  fallback: 'ownerId' },
  { key: 'ownerVerified',  label: 'Owner verified',         group: 'Creator', bucket: 'advanced',    type: 'bool',   default: false, primary: 'user.is_verified',          fallback: null },
  { key: 'ownerFollowers', label: 'Owner followers',        group: 'Creator', bucket: 'advanced',    type: 'number', default: false, primary: 'metrics.user_follower_count', fallback: null }, // often null
  { key: 'ownerBio',       label: 'Owner bio',              group: 'Creator', bucket: 'advanced',    type: 'text',   default: false, primary: null,                fallback: null }, // not in either actor's output
  { key: 'ownerExtUrl',    label: 'Owner external URL',     group: 'Creator', bucket: 'advanced',    type: 'url',    default: false, primary: null,                fallback: null }, // not in either actor's output
  { key: 'ownerCategory',  label: 'Owner business category',group: 'Creator', bucket: 'advanced',    type: 'text',   default: false, primary: null,                fallback: null }, // not in either actor's output
  { key: 'ownerPic',       label: 'Owner profile pic',      group: 'Creator', bucket: 'advanced',    type: 'url',    default: false, primary: 'user.profile_pic_url',     fallback: null },

  // ── Audio / music ────────────────────────────────────────────────────
  { key: 'audioTitle',   label: 'Audio title',        group: 'Audio',      bucket: 'advanced', type: 'text',    default: false, primary: 'clips_metadata.original_sound_info.original_audio_title', fallback: 'musicInfo.song_name' },
  { key: 'audioArtist',  label: 'Audio artist',       group: 'Audio',      bucket: 'advanced', type: 'text',    default: false, primary: 'clips_metadata.original_sound_info.ig_artist.full_name', fallback: 'musicInfo.artist_name' },
  { key: 'audioId',      label: 'Audio ID',           group: 'Audio',      bucket: 'advanced', type: 'text',    default: false, primary: 'clips_metadata.original_sound_info.audio_id', fallback: 'musicInfo.audio_id' },
  { key: 'origAudio',    label: 'Original audio',     group: 'Audio',      bucket: 'advanced', type: 'bool',    default: false, primary: null,              fallback: 'musicInfo.uses_original_audio' },
  { key: 'musicGenre',   label: 'Music genre',        group: 'Audio',      bucket: 'advanced', type: 'text',    default: false, primary: null,              fallback: null }, // not in either actor's output
  { key: 'audioUrl',     label: 'Audio URL',          group: 'Audio',      bucket: 'advanced', type: 'url',     default: false, primary: 'clips_metadata.original_sound_info.progressive_download_url', fallback: 'audioUrl' },

  // ── Media / technical ────────────────────────────────────────────────
  { key: 'mediaUrl',      label: 'Media / video URL', group: 'Media',      bucket: 'advanced', type: 'url',     default: false, primary: 'video_url',      fallback: 'videoUrl' }, // blank on photos (expected)
  { key: 'thumbnailUrl',  label: 'Thumbnail URL',     group: 'Media',      bucket: 'advanced', type: 'url',     default: false, primary: 'thumbnail_url',  fallback: null },
  { key: 'displayUrl',    label: 'Display image URL', group: 'Media',      bucket: 'advanced', type: 'url',     default: false, primary: null,             fallback: 'displayUrl' },
  { key: 'images',        label: 'Image URLs',        group: 'Media',      bucket: 'advanced', type: 'list',    default: false, primary: 'image_versions.items', sub: 'url', fallback: 'images' },
  { key: 'videoDuration', label: 'Video duration (s)',group: 'Media',      bucket: 'advanced', type: 'number',  default: false, primary: 'video_duration', fallback: 'videoDuration' },
  { key: 'width',         label: 'Width',             group: 'Media',      bucket: 'advanced', type: 'number',  default: false, primary: 'original_width', fallback: 'dimensionsWidth' },
  { key: 'height',        label: 'Height',            group: 'Media',      bucket: 'advanced', type: 'number',  default: false, primary: 'original_height', fallback: 'dimensionsHeight' },
  { key: 'carouselCount', label: 'Carousel items',    group: 'Media',      bucket: 'advanced', type: 'number',  default: false, primary: null,             fallback: 'childPosts' }, // output = childPosts.length
  { key: 'transcript',    label: 'Transcript',        group: 'Media',      bucket: 'advanced', type: 'text',    default: false, primary: null,             fallback: 'transcript' }, // SANITIZE; reel-scraper only

  // ── Location ─────────────────────────────────────────────────────────
  { key: 'locationName', label: 'Location name',      group: 'Location',   bucket: 'advanced', type: 'text',    default: false, primary: 'location.name',    fallback: 'locationName' },
  { key: 'locationId',   label: 'Location ID',        group: 'Location',   bucket: 'advanced', type: 'text',    default: false, primary: 'location.pk',      fallback: 'locationId' },
  { key: 'locationLat',  label: 'Location lat',       group: 'Location',   bucket: 'advanced', type: 'number',  default: false, primary: 'location.lat',     fallback: null },
  { key: 'locationLng',  label: 'Location lng',       group: 'Location',   bucket: 'advanced', type: 'number',  default: false, primary: 'location.lng',     fallback: null },
  { key: 'locationAddr', label: 'Location address',   group: 'Location',   bucket: 'advanced', type: 'text',    default: false, primary: 'location.address', fallback: null },

  // ── Comments detail ──────────────────────────────────────────────────
  { key: 'firstComment',  label: 'First comment',     group: 'Comments',   bucket: 'recommended', type: 'text',     default: false, primary: null, fallback: 'firstComment' }, // SANITIZE
  { key: 'latestComments',label: 'Latest comments',   group: 'Comments',   bucket: 'recommended', type: 'comments', default: false, primary: null, fallback: 'latestComments' }, // join "user: text | ..."
  { key: 'topComments',   label: 'Top comments',      group: 'Comments',   bucket: 'recommended', type: 'comments', default: false, primary: null, fallback: null, comments: 'topComments' }, // comments actor — verify key
  { key: 'allComments',   label: 'All comments',      group: 'Comments',   bucket: 'recommended', type: 'comments', default: false, primary: null, fallback: null, comments: 'comments' }, // comments actor — verify key
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

function isMissing(v) {
  if (v == null || v === '') return true;
  if (Array.isArray(v) && v.length === 0) return true;
  return false;
}

// True when the primary actor's value should fall through to the fallback actor.
function isPrimaryGap(field, v) {
  if (isMissing(v)) return true;
  if (field.type === 'number' && typeof v === 'number' && (v === -1 || Number.isNaN(v))) return true;
  return false;
}

// True when the primary item is a reel/video — the only kinds the fallback
// reel scraper can enrich. Photos/carousels are excluded so we never pay for
// a fallback run that can't return anything.
function isVideoLike(item) {
  if (!item) return false;
  if (item.product_type === 'clips') return true; // reels
  if (item.media_name === 'reel' || item.media_name === 'video') return true;
  if (item.is_video === true) return true; // catch-all for videos/igtv
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

function parseTimestampMs(v) {
  if (v == null || v === '') return null;
  let ms;
  if (typeof v === 'number') {
    ms = v < 1e12 ? v * 1000 : v;
  } else if (typeof v === 'string') {
    const parsed = new Date(v);
    if (!Number.isNaN(parsed.getTime())) {
      ms = parsed.getTime();
    } else {
      const n = Number(v);
      if (Number.isNaN(n)) return null;
      ms = n < 1e12 ? n * 1000 : n;
    }
  } else if (v instanceof Date) {
    ms = v.getTime();
  } else {
    return null;
  }
  return Number.isFinite(ms) ? ms : null;
}

function formatDatetime(v) {
  const ms = parseTimestampMs(v);
  if (ms == null) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CONFIG.TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).formatToParts(new Date(ms));
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
  return `${get('hour')}:${get('minute')}:${get('second')} ${get('dayPeriod')}`;
}

function formatDate(v) {
  const ms = parseTimestampMs(v);
  if (ms == null) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CONFIG.TIMEZONE,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).formatToParts(new Date(ms));
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
  return `${get('day')} ${get('month')} ${get('year')}`;
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
      const u = sanitize(c.ownerUsername ?? c.owner_username ?? c.username);
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
    case 'date':     return formatDate(v);
    case 'text':     return formatText(v);
    case 'list':     return formatList(v, field.sub);
    case 'comments': return formatComments(v);
    case 'bool':     return formatBool(v);
    case 'url':      return sanitize(v);
    default:         return sanitize(v);
  }
}

// Pick the value for one field from the actor items, then format it.
function resolveField(field, primaryItem, fallbackItem, commentsItem) {
  let v;
  if (field.comments != null) {
    v = getPath(commentsItem, field.comments);
    return formatValue(field, v);
  }
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
    if (fallbackItem) v = getPath(fallbackItem, field.fallback);
    else return '';
  }
  return formatValue(field, v);
}

// ─────────────────────────────────────────────────────────────────────────────
// URL parsing + result mapping (matched by shortcode, never by array order).
// Duplicates are KEPT but flagged; invalid links are KEPT as rows.
// ─────────────────────────────────────────────────────────────────────────────

function parseInputs(raw) {
  const tokens = String(raw || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const seen = new Set();
  const inputs = [];
  for (const t of tokens) {
    const sc = extractShortcode(t);
    if (sc) {
      const duplicate = seen.has(sc);
      seen.add(sc);
      inputs.push({ url: t, shortcode: sc, duplicate, invalid: false });
    } else {
      inputs.push({ url: t, shortcode: null, duplicate: false, invalid: true });
    }
  }
  return inputs;
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

function mergeMap(target, source) {
  for (const [k, v] of source) if (!target.has(k)) target.set(k, v);
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
    throw new Error('An actor ID is not configured (see the CONFIG block in server.js).');
  }
  const client = getClient();
  const maxAttempts = Math.max(1, CONFIG.MAX_RUN_ATTEMPTS);
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const run = await client.actor(actorId).call({ [inputKey]: urls });
      if (!run || !run.defaultDatasetId) {
        throw new Error(`Actor ${actorId} returned no dataset.`);
      }
      const { items } = await client.dataset(run.defaultDatasetId).listItems();
      const cost = Number(run.usageTotalUsd || run.usageUsd || 0);
      return { items: items || [], cost };
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        await sleep(attempt * 1000); // small backoff between attempts
      }
    }
  }
  throw lastErr;
}

// Run the actors needed for `selectedFields` over `urls`, returning per-actor
// item maps + total cost. Primary runs first: its output both supplies data
// and tells us which URLs are reels/videos, so the (expensive) fallback reel
// scraper only ever runs for URLs it can actually enrich.
const fallbackCache = new Map(); // shortcode -> { item, at }

async function scrapeUrls(urls, selectedFields) {
  const primaryMap = new Map();
  const fallbackMap = new Map();
  const commentsMap = new Map();
  let costUsd = 0;
  let usedFallback = false;
  let usedComments = false;

  const needPrimary = selectedFields.some((f) => f.primary != null);
  const needFallbackAll = selectedFields.some((f) => f.primary == null && f.fallback != null);
  const needComments = selectedFields.some((f) => f.comments != null);
  const fallbackEnabled = !!CONFIG.FALLBACK_ENABLED;
  const commentsEnabled = !!CONFIG.COMMENTS_ENABLED;
  const fallbackFields = selectedFields.filter((f) => f.fallback != null);
  const fallbackWanted = fallbackEnabled && fallbackFields.length > 0;

  const run = async (id, key, u) => {
    const r = await runActor(id, key, u);
    costUsd += r.cost;
    return r.items;
  };

  // Primary (data + reel/video classification) and comments run concurrently.
  // Primary is also run when only fallback fields are selected, so we can tell
  // reels from photos without ever sending a photo URL to the reel scraper.
  const shouldRunPrimary = needPrimary || fallbackWanted;
  const [primaryItems, commentsItems] = await Promise.all([
    shouldRunPrimary
      ? run(CONFIG.PRIMARY_ACTOR_ID, CONFIG.PRIMARY_INPUT_KEY, urls)
      : Promise.resolve(null),
    commentsEnabled && needComments
      ? run(CONFIG.COMMENTS_ACTOR_ID, CONFIG.COMMENTS_INPUT_KEY, urls)
      : Promise.resolve(null),
  ]);
  if (primaryItems) mergeMap(primaryMap, buildMap(primaryItems, CONFIG.PRIMARY_MATCH_KEY));
  if (commentsItems) {
    mergeMap(commentsMap, buildMap(commentsItems, CONFIG.COMMENTS_MATCH_KEY));
    usedComments = true;
  }

  // Fallback — reels/videos only, and only when it has something to add.
  if (fallbackWanted) {
    const reelUrls = urls.filter((u) => {
      const sc = extractShortcode(u);
      return isVideoLike(primaryMap.get(sc));
    });
    if (reelUrls.length) {
      let fbUrls;
      if (needFallbackAll) {
        fbUrls = reelUrls;
      } else {
        const bothFields = selectedFields.filter((f) => f.primary != null && f.fallback != null);
        fbUrls = reelUrls.filter((u) => {
          const sc = extractShortcode(u);
          const item = primaryMap.get(sc);
          return bothFields.some((f) => isPrimaryGap(f, getPath(item, f.primary)));
        });
      }

      // Serve cached fallback items first; only run the actor for the rest.
      const toRun = [];
      for (const u of fbUrls) {
        const sc = extractShortcode(u);
        const cached = fallbackCache.get(sc);
        if (CONFIG.FALLBACK_CACHE_ENABLED && cached && Date.now() - cached.at < CONFIG.FALLBACK_CACHE_TTL_MS) {
          if (!fallbackMap.has(sc)) fallbackMap.set(sc, cached.item);
        } else {
          toRun.push(u);
        }
      }

      if (toRun.length) {
        const items = await run(CONFIG.FALLBACK_ACTOR_ID, CONFIG.FALLBACK_INPUT_KEY, toRun);
        for (const [sc, item] of buildMap(items, CONFIG.FALLBACK_MATCH_KEY)) {
          if (CONFIG.FALLBACK_CACHE_ENABLED) fallbackCache.set(sc, { item, at: Date.now() });
          if (!fallbackMap.has(sc)) fallbackMap.set(sc, item);
        }
      }
      if (fallbackMap.size) usedFallback = true;
    }
  }

  return { primaryMap, fallbackMap, commentsMap, costUsd, usedFallback, usedComments };
}

// ─────────────────────────────────────────────────────────────────────────────
// Jobs — in-memory batch processing (real-time streaming for local use).
// ─────────────────────────────────────────────────────────────────────────────

const jobs = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

async function processJob(jobId, inputs, selectedFields) {
  const job = jobs.get(jobId);
  if (!job) return;
  const primaryMap = new Map();
  const fallbackMap = new Map();
  const commentsMap = new Map();
  const batchSize = Math.max(1, CONFIG.BATCH_SIZE);

  // Unique valid URLs to scrape (first occurrence of each shortcode).
  const toScrapeUrls = [];
  const seenSc = new Set();
  for (const it of inputs) {
    if (!it.shortcode || it.invalid) continue;
    if (seenSc.has(it.shortcode)) continue;
    seenSc.add(it.shortcode);
    toScrapeUrls.push(it.url);
  }

  const isMissing = (u) => {
    const sc = extractShortcode(u);
    return !primaryMap.has(sc) && !fallbackMap.has(sc) && !commentsMap.has(sc);
  };

  const maxRounds = CONFIG.RETRY_ENABLED ? Math.max(1, CONFIG.RETRY_MAX_ROUNDS) : 1;

  // Split the link list evenly across CONCURRENCY workers. Each worker owns a
  // chunk and scrapes it (with its own retries) while the others run in
  // parallel, so the whole job finishes in roughly 1/CONCURRENCY of the time.
  const concurrency = Math.max(1, Number(process.env.APIFY_CONCURRENCY) || CONFIG.CONCURRENCY);
  const chunks = [];
  const perChunk = Math.ceil(toScrapeUrls.length / concurrency);
  for (let i = 0; i < toScrapeUrls.length; i += perChunk) {
    chunks.push(toScrapeUrls.slice(i, i + perChunk));
  }
  job.batchesTotal = chunks.reduce((n, c) => n + Math.ceil(c.length / batchSize), 0);

  let batchesDone = 0;

  // Rebuild the preview rows/meta/counts from whatever the maps hold so far.
  // Called after every batch so the frontend can show partial results live,
  // and once more with `final=true` when the job is done (to mark leftovers).
  const buildOutput = (final) => {
    job.rows = [];
    job.meta = [];
    for (const it of inputs) {
      const row = { URL: it.url };
      let status = 'ok';
      let reason = null;
      if (it.invalid) {
        status = 'invalid';
        reason = 'unsupported link (not Instagram)';
      } else {
        const p = primaryMap.get(it.shortcode);
        const fb = fallbackMap.get(it.shortcode);
        const cm = commentsMap.get(it.shortcode);
        if (!p && !fb && !cm) {
          if (final) {
            status = 'no data';
            reason = 'no data (private / deleted / unavailable)';
          } else {
            status = 'pending';
            reason = 'waiting for scrape…';
          }
        } else if (it.duplicate) {
          status = 'duplicate';
        }
        if (status === 'ok' || status === 'duplicate') {
          for (const f of selectedFields) row[f.label] = resolveField(f, p, fb, cm);
        }
      }
      job.rows.push(row);
      job.meta.push({ url: it.url, status, reason });
    }
    job.counts.returned = job.meta.filter((m) => m.status === 'ok' || m.status === 'duplicate').length;
    job.counts.failed = job.meta.filter((m) => m.status === 'invalid' || m.status === 'no data').length;
  };

  const worker = async (chunk) => {
    let pending = chunk.slice();
    let round = 0;
    while (pending.length > 0 && round < maxRounds) {
      const pendingBefore = pending.length;
      if (round > 0) {
        job.retrying = true;
        if (CONFIG.RETRY_DELAY_MS > 0) await sleep(CONFIG.RETRY_DELAY_MS);
      }

      for (let i = 0; i < pending.length; i += batchSize) {
        const batch = pending.slice(i, i + batchSize);
        const need = batch.filter(isMissing);
        if (need.length > 0) {
          try {
            const r = await scrapeUrls(need, selectedFields);
            mergeMap(primaryMap, r.primaryMap);
            mergeMap(fallbackMap, r.fallbackMap);
            mergeMap(commentsMap, r.commentsMap);
            job.costUsd += r.costUsd;
            job.usedFallback = job.usedFallback || r.usedFallback;
            job.usedComments = job.usedComments || r.usedComments;
            buildOutput(false); // expose partial results to the preview

            // Validate the output: any URL in this batch that still has no
            // item is left for the next retry round (never reported as done).
            const resolved = need.filter((u) => !isMissing(u)).length;
            if (resolved < need.length) {
              console.warn(
                `Batch partially resolved (${resolved}/${need.length}); ` +
                  `${need.length - resolved} URL(s) will be retried.`
              );
            }
          } catch (err) {
            // Transient actor failure — leave the batch untouched so the retry
            // loop picks it back up instead of killing the whole job.
            console.warn(
              `Batch scrape failed (${need.length} URL(s)); will retry: ` +
                `${(err && err.message) || err}`
            );
          }
        }
        batchesDone++;
        job.batchesDone = Math.min(batchesDone, job.batchesTotal);
        if (CONFIG.BATCH_DELAY_MS > 0 && i + batchSize < pending.length) {
          await sleep(CONFIG.BATCH_DELAY_MS);
        }
      }

      pending = pending.filter(isMissing);
      round++;
      if (pending.length === pendingBefore) break; // no progress this round — stop retrying
    }
    return pending.length;
  };

  // Run all workers in parallel; sum their leftover (still-missing) counts.
  const leftovers = await Promise.all(chunks.map(worker));
  job.remaining = leftovers.reduce((a, b) => a + b, 0);
  job.batchesDone = job.batchesTotal;
  job.retrying = false;

  // Build final rows for all inputs in original order (duplicates + invalid kept).
  buildOutput(true);

  job.batchesDone = job.batchesTotal;
  job.status = 'done';
  job.timing = { totalMs: Date.now() - job.startedAt };
}

// ─────────────────────────────────────────────────────────────────────────────
// Express app
// ─────────────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/fields', (req, res) => {
  res.json(FIELD_CATALOG);
});

app.post('/api/scrape', (req, res) => {
  try {
    const body = req.body || {};
    const selectedKeys = Array.isArray(body.selected) ? body.selected : [];
    const selectedFields = selectedKeys
      .map((k) => FIELD_CATALOG.find((f) => f.key === k))
      .filter(Boolean);
    if (selectedFields.length === 0) {
      return res.status(400).json({ error: 'Select at least one field.' });
    }

    const inputs = parseInputs(body.urls);
    if (!inputs.some((i) => i.shortcode)) {
      return res.status(400).json({ error: 'No valid Instagram URLs found. Paste post/reel/tv URLs.' });
    }

    const jobId = randomId();
    const batchSize = Math.max(1, CONFIG.BATCH_SIZE);
    jobs.set(jobId, {
      status: 'running',
      columns: ['URL', ...selectedFields.map((f) => f.label)],
      rows: [],
      meta: [],
      counts: {
        requested: inputs.length,
        returned: 0,
        failed: 0,
        duplicates: inputs.filter((i) => i.duplicate).length,
      },
      costUsd: 0,
      batchesTotal: Math.ceil(inputs.length / batchSize),
      batchesDone: 0,
      retrying: false,
      remaining: 0,
      usedFallback: false,
      usedComments: false,
      startedAt: Date.now(),
      timing: null,
      error: null,
    });

    processJob(jobId, inputs, selectedFields).catch((err) => {
      const job = jobs.get(jobId);
      if (job) {
        job.status = 'error';
        job.error = err && err.message ? err.message : 'Scrape failed.';
      }
    });

    res.json({ jobId, batchesTotal: jobs.get(jobId).batchesTotal });
  } catch (err) {
    res.status(400).json({ error: err && err.message ? err.message : 'Scrape failed.' });
  }
});

app.get('/api/job/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found (it may have expired).' });
  res.json(job);
});

module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    if (!process.env.APIFY_TOKEN) {
      console.warn('\n⚠  APIFY_TOKEN is not set. /api/fields works, but /api/scrape will fail until you add your token to .env.\n');
    }
    console.log(`IG Metrics Automator running at http://localhost:${PORT}`);
  });
}
