// ─────────────────────────────────────────────────────────────────────────────
// X (Twitter) mode — scrape posts by link using scrape.badger/twitter-tweets-scraper.
//
// One actor run returns the post metrics AND the author's profile stats, so
// unlike Instagram there is no fallback or separate profile scraper. Same job
// shape as the Instagram modes, so the page and /api/job polling work unchanged.
//
// server.js passes in its shared helpers (actor runner, formatters) — see the
// require('./x')(…) call there.
// ─────────────────────────────────────────────────────────────────────────────

const X_CONFIG = {
  ACTOR_ID: 'scrape.badger/twitter-tweets-scraper', // picked after a side-by-side test: same data as apidojo, ~350x cheaper
  MODE: 'Get a Few Tweets', // the actor's "fetch these tweet IDs" mode
  BATCH_SIZE: 100,          // tweet IDs per actor run (comma-separated input)
  RETRY_MAX_ROUNDS: 2,      // re-ask once for tweets that came back empty
};

// Same columns as the Instagram catalog where X has an equivalent, plus X-only extras.
//   path     field in the actor's item, or null when `compute` derives it
const X_FIELD_CATALOG = [
  // Engagement
  { key: 'likes',     label: 'Likes',     group: 'Engagement', bucket: 'recommended', type: 'number', default: true,  path: 'favorite_count' },
  { key: 'comments',  label: 'Comments',  group: 'Engagement', bucket: 'recommended', type: 'number', default: true,  path: 'reply_count' },
  { key: 'shares',    label: 'Shares',    group: 'Engagement', bucket: 'recommended', type: 'number', default: true,  path: null, compute: (it) => sumCounts(it.retweet_count, it.quote_count) }, // reposts + quotes
  { key: 'views',     label: 'Views',     group: 'Engagement', bucket: 'recommended', type: 'number', default: true,  path: 'view_count' },
  { key: 'reposts',   label: 'Reposts',   group: 'Engagement', bucket: 'recommended', type: 'number', default: false, path: 'retweet_count' },
  { key: 'quotes',    label: 'Quotes',    group: 'Engagement', bucket: 'recommended', type: 'number', default: false, path: 'quote_count' },
  { key: 'bookmarks', label: 'Bookmarks', group: 'Engagement', bucket: 'recommended', type: 'number', default: false, path: 'bookmark_count' }, // X's "saves"

  // Timing
  { key: 'postedAt',   label: 'Posted time',        group: 'Timing', bucket: 'recommended', type: 'datetime', default: true,  path: 'created_at' },
  { key: 'postedDate', label: 'Posted date',        group: 'Timing', bucket: 'recommended', type: 'date',     default: false, path: 'created_at' },
  { key: 'postedUtc',  label: 'Published_at (UTC)', group: 'Timing', bucket: 'recommended', type: 'text',     default: false, path: null, compute: (it) => isoUtc(it.created_at) },

  // Post
  { key: 'caption',   label: 'Caption',          group: 'Post', bucket: 'recommended', type: 'text', default: false, path: null, compute: (it) => it.full_text || it.text },
  { key: 'postType',  label: 'Post type',        group: 'Post', bucket: 'advanced',    type: 'text', default: false, path: null, compute: mediaType },
  { key: 'postUrl',   label: 'Post URL',         group: 'Post', bucket: 'advanced',    type: 'url',  default: false, path: null, compute: (it) => it.id && it.username ? `https://x.com/${it.username}/status/${it.id}` : '' },
  { key: 'postId',    label: 'Post ID',          group: 'Post', bucket: 'advanced',    type: 'text', default: false, path: 'id' },
  { key: 'hashtags',  label: 'Hashtags',         group: 'Post', bucket: 'advanced',    type: 'list', default: false, path: 'hashtags', sub: 'tag' },
  { key: 'mentions',  label: 'Mentions',         group: 'Post', bucket: 'advanced',    type: 'list', default: false, path: 'user_mentions', sub: 'screen_name' },
  { key: 'links',     label: 'Links in post',    group: 'Post', bucket: 'advanced',    type: 'list', default: false, path: 'urls', sub: 'expanded_url' },
  { key: 'lang',      label: 'Language',         group: 'Post', bucket: 'advanced',    type: 'text', default: false, path: 'lang' },
  { key: 'isRetweet', label: 'Is repost',        group: 'Post', bucket: 'advanced',    type: 'bool', default: false, path: 'is_retweet' },
  { key: 'isQuote',   label: 'Is quote',         group: 'Post', bucket: 'advanced',    type: 'bool', default: false, path: 'is_quote_status' },
  { key: 'notes',     label: 'Community Notes',  group: 'Post', bucket: 'advanced',    type: 'bool', default: false, path: 'has_community_notes' },
  { key: 'sensitive', label: 'Sensitive',        group: 'Post', bucket: 'advanced',    type: 'bool', default: false, path: 'possibly_sensitive' },

  // Creator
  { key: 'ownerUsername',   label: 'Owner username',     group: 'Creator', bucket: 'advanced', type: 'text',   default: false, path: 'username' },
  { key: 'ownerFullName',   label: 'Owner full name',    group: 'Creator', bucket: 'advanced', type: 'text',   default: false, path: 'user_name' },
  { key: 'ownerProfileUrl', label: 'Owner profile URL',  group: 'Creator', bucket: 'advanced', type: 'url',    default: false, path: null, compute: (it) => it.username ? `https://x.com/${it.username}` : '' },
  { key: 'ownerId',         label: 'Owner ID',           group: 'Creator', bucket: 'advanced', type: 'text',   default: false, path: 'user_id' },
  { key: 'ownerFollowers',  label: 'Owner followers',    group: 'Creator', bucket: 'advanced', type: 'number', default: false, path: 'user_followers_count' },
  { key: 'ownerFollowing',  label: 'Owner following',    group: 'Creator', bucket: 'advanced', type: 'number', default: false, path: 'user_following_count' },
  { key: 'ownerTweets',     label: 'Owner total posts',  group: 'Creator', bucket: 'advanced', type: 'number', default: false, path: 'user_tweet_count' },
  { key: 'ownerVerified',   label: 'Owner verified',     group: 'Creator', bucket: 'advanced', type: 'bool',   default: false, path: 'user_is_blue_verified' },
  { key: 'ownerBio',        label: 'Owner bio',          group: 'Creator', bucket: 'advanced', type: 'text',   default: false, path: 'user_description' },
  { key: 'ownerLocation',   label: 'Owner location',     group: 'Creator', bucket: 'advanced', type: 'text',   default: false, path: 'user_location' },
  { key: 'ownerJoined',     label: 'Owner joined',       group: 'Creator', bucket: 'advanced', type: 'date',   default: false, path: 'user_created_at' },
  { key: 'ownerPic',        label: 'Owner profile pic',  group: 'Creator', bucket: 'advanced', type: 'url',    default: false, path: 'user_profile_image_url' },

  // Media
  { key: 'mediaUrls',     label: 'Media URLs',          group: 'Media', bucket: 'advanced', type: 'list',   default: false, path: 'media', sub: 'url' },
  { key: 'mediaCount',    label: 'Media items',         group: 'Media', bucket: 'advanced', type: 'number', default: false, path: null, compute: (it) => (Array.isArray(it.media) ? it.media.length : 0) },
  { key: 'videoDuration', label: 'Video duration (s)',  group: 'Media', bucket: 'advanced', type: 'number', default: false, path: null, compute: videoDuration },
];

function sumCounts(a, b) {
  if (a == null && b == null) return '';
  return (Number(a) || 0) + (Number(b) || 0);
}

function isoUtc(v) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().replace('.000Z', '+00:00');
}

function mediaType(it) {
  const types = (it.media || []).map((m) => m && m.type);
  if (types.some((t) => t === 'video' || t === 'animated_gif')) return 'video';
  if (types.length === 1) return 'image';
  if (types.length > 1) return 'carousel';
  return 'text';
}

function videoDuration(it) {
  for (const m of it.media || []) {
    if (!m) continue;
    const ms = m.duration_millis ?? m.durationMs ?? m.duration_ms;
    if (ms) return Math.round(ms / 1000);
    const s = m.duration ?? m.duration_seconds;
    if (s) return Math.round(Number(s));
  }
  return '';
}

// Accepts x.com / twitter.com / mobile links (any ?s=20&t=… tail) or bare numeric IDs.
function tweetIdOf(token) {
  const m = String(token).match(/\/status(?:es)?\/(\d+)/) || String(token).match(/^\s*(\d{5,})\s*$/);
  return m ? m[1] : null;
}

function parseXInputs(raw) {
  const tokens = Array.isArray(raw) ? raw : String(raw || '').split(/[\s,]+/);
  const seen = new Set();
  return tokens
    .map((t) => String(t).trim())
    .filter(Boolean)
    .map((url) => {
      const id = tweetIdOf(url);
      const duplicate = !!id && seen.has(id);
      if (id) seen.add(id);
      return { url, id, invalid: !id, duplicate };
    });
}

module.exports = function createXMode({ runActorWithInput, getPath, formatValue, sleep }) {
  function resolveXField(field, item) {
    const v = field.compute ? field.compute(item) : getPath(item, field.path);
    return formatValue(field, v);
  }

  async function processXJob(job, inputs, selectedFields) {
    const byId = new Map();
    const ids = [...new Set(inputs.filter((i) => i.id).map((i) => i.id))];
    const batches = [];
    for (let i = 0; i < ids.length; i += X_CONFIG.BATCH_SIZE) batches.push(ids.slice(i, i + X_CONFIG.BATCH_SIZE));
    job.batchesTotal = batches.length;

    const buildOutput = (final) => {
      job.rows = [];
      job.meta = [];
      for (const it of inputs) {
        const row = { [job.columns[0]]: it.url };
        let status = 'ok';
        let reason = null;
        if (it.invalid) {
          status = 'invalid';
          reason = 'unsupported link (needs x.com/<user>/status/<id>)';
        } else {
          const item = byId.get(it.id);
          if (!item) {
            status = final ? 'no data' : 'pending';
            reason = final ? 'no data (deleted / protected / unavailable)' : 'waiting for scrape…';
          } else {
            if (it.duplicate) status = 'duplicate';
            for (const f of selectedFields) row[f.label] = resolveXField(f, item);
          }
        }
        job.rows.push(row);
        job.meta.push({ url: it.url, status, reason });
      }
      job.counts.returned = job.meta.filter((m) => m.status === 'ok' || m.status === 'duplicate').length;
      job.counts.failed = job.meta.filter((m) => m.status === 'invalid' || m.status === 'no data').length;
    };

    for (let round = 0; round < X_CONFIG.RETRY_MAX_ROUNDS; round++) {
      const todo = batches.map((b) => b.filter((id) => !byId.has(id))).filter((b) => b.length);
      if (!todo.length) break;
      if (round > 0) { job.retrying = true; job.remaining = todo.flat().length; await sleep(1500); }
      // Batches run in parallel: each is one actor run over up to BATCH_SIZE IDs
      await Promise.all(todo.map(async (batch) => {
        try {
          const { items, cost } = await runActorWithInput(X_CONFIG.ACTOR_ID, { mode: X_CONFIG.MODE, tweets: batch.join(',') });
          for (const item of items || []) if (item && item.id != null) byId.set(String(item.id), item);
          job.costUsd += cost || 0;
        } catch (err) {
          console.warn(`X batch failed (${batch.length}); will retry: ${(err && err.message) || err}`);
        }
        if (round === 0) job.batchesDone = Math.min(job.batchesDone + 1, job.batchesTotal);
        buildOutput(false);
      }));
    }

    job.retrying = false;
    job.remaining = ids.filter((id) => !byId.has(id)).length;
    buildOutput(true);
    job.batchesDone = job.batchesTotal;
    job.status = 'done';
    job.timing = { totalMs: Date.now() - job.startedAt };
  }

  return { X_FIELD_CATALOG, parseXInputs, processXJob };
};
