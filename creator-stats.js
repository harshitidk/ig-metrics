// Creator-level stats for the Profiles mode: average views, engagement rate,
// main language and content niche. Pure functions over the scraper output so
// they can be tested without Apify.
//
//   profile = one item from apify/instagram-profile-scraper (has latestPosts)
//   reels   = items from apify/instagram-reel-scraper for that username
//             (fetched only when "Avg views" is selected; may include pinned reels)

const LAST_N = 5; // average over the 5 newest reels

const ts = (p) => {
  const t = Date.parse(p && p.timestamp);
  return Number.isFinite(t) ? t : 0;
};
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

// Newest N reels by date. Pinned reels sit first in the scraper output but are
// often months old; sorting by date and taking the newest drops them.
function newestReels(reels, n = LAST_N) {
  return (reels || [])
    .filter((r) => r && !r.error && ts(r) > 0)
    .sort((a, b) => ts(b) - ts(a))
    .slice(0, n);
}

function reelViews(r) {
  return num(r.videoPlayCount) ?? num(r.videoViewCount);
}

function avgViews(profile, reels) {
  const v = newestReels(reels).map(reelViews).filter((x) => x != null);
  const a = avg(v);
  return a == null ? '' : Math.round(a);
}

// Posts used for engagement: the 5 newest reels from the reel scraper when we
// have them, otherwise the 5 newest non-pinned videos (or posts) from the
// profile's own latestPosts — free, no extra scraper run.
function engagementSample(profile, reels) {
  const fromReels = newestReels(reels);
  if (fromReels.length) return fromReels;
  const posts = ((profile && profile.latestPosts) || []).filter((p) => p && !p.isPinned);
  const videos = posts.filter((p) => /video|clips|reel/i.test(String(p.type || p.productType || '')));
  const pool = videos.length ? videos : posts;
  return pool.sort((a, b) => ts(b) - ts(a)).slice(0, LAST_N);
}

// (avg likes + avg comments) / followers x 100, rounded to 2 decimals.
// Hidden likes come back as -1 / null and are left out of the like average.
function engagementRate(profile, reels) {
  const followers = num(profile && profile.followersCount);
  if (!followers) return '';
  const sample = engagementSample(profile, reels);
  if (!sample.length) return '';
  const likes = avg(sample.map((p) => num(p.likesCount)).filter((x) => x != null));
  const comments = avg(sample.map((p) => num(p.commentsCount)).filter((x) => x != null));
  if (likes == null && comments == null) return '';
  return Math.round((((likes || 0) + (comments || 0)) / followers) * 10000) / 100;
}

// ── Language ────────────────────────────────────────────────────────────────
// Instagram does not report a language, so we read it from the bio + recent
// captions: Indian scripts by Unicode block, and Roman-script text split into
// Hinglish vs English by common Hindi words. Approximate by design.
const SCRIPTS = [
  ['Hindi', /[ऀ-ॿ]/g],
  ['Bengali', /[ঀ-৿]/g], // Assamese shares this block; see below
  ['Punjabi', /[਀-੿]/g],
  ['Gujarati', /[઀-૿]/g],
  ['Odia', /[଀-୿]/g],
  ['Tamil', /[஀-௿]/g],
  ['Telugu', /[ఀ-౿]/g],
  ['Kannada', /[ಀ-೿]/g],
  ['Malayalam', /[ഀ-ൿ]/g],
  ['Urdu', /[؀-ۿ]/g],
];
const ASSAMESE = /[ৰৱ]/; // ৰ ৱ only exist in Assamese
const HINGLISH = new Set(('hai hain ho tha thi the nahi nhi nahin kya kyu kyun kaise kaisa kab kaha kahan kuch bhi aur ' +
  'mera meri mere tera teri tere apna apni hum tum aap yeh ye woh wo isko usko inko unko ko ki ka ke se mein me par pe ' +
  'bhai bhaiya yaar dost pyaar pyar zindagi dil log logo sab sabhi bahut bohot bhut accha acha achha theek thik ' +
  'karo karna karne kar kiya kiye raha rahi rahe gaya gayi hoga hogi jaana jana dekho dekhiye suno bolo bata batao ' +
  'ji jee abhi aaj kal sath saath wala wali wale liye liya lekin magar agar toh to bas sirf phir fir ab jab tab ' +
  'naya nayi purana desh sarkar neta janta gaon shaadi maa papa beta beti didi').split(' '));

function captionText(p) {
  const c = p && p.caption;
  return typeof c === 'string' ? c : (c && c.text) || '';
}

function langOfText(text) {
  const t = String(text || '')
    .normalize('NFKC') // fancy "bold/italic" Unicode letters -> plain letters
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[#@][\w.]+/g, ' ');
  let best = null;
  let bestN = 0;
  for (const [name, re] of SCRIPTS) {
    const n = (t.match(re) || []).length;
    if (n > bestN) { best = name; bestN = n; }
  }
  const words = t.toLowerCase().match(/[a-z]{2,}/g) || [];
  if (bestN >= 3 && bestN >= words.length) {
    if (best === 'Bengali' && ASSAMESE.test(t)) return 'Assamese';
    return best;
  }
  if (words.length < 3) return bestN >= 3 ? best : null;
  const hi = words.filter((w) => HINGLISH.has(w)).length;
  return hi >= 2 && hi / words.length >= 0.12 ? 'Hinglish' : 'English';
}

// Main language over bio + up to 12 captions; "A + B" when a second language
// covers at least 30% of the texts that had one.
function language(profile, reels) {
  const texts = [profile && profile.biography];
  for (const p of (profile && profile.latestPosts) || []) texts.push(captionText(p));
  for (const r of reels || []) texts.push(captionText(r));
  const count = {};
  let total = 0;
  for (const t of texts) {
    const l = langOfText(t);
    if (!l) continue;
    count[l] = (count[l] || 0) + 1;
    total++;
  }
  const ranked = Object.entries(count).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return '';
  if (ranked[1] && ranked[1][1] / total >= 0.3) return `${ranked[0][0]} + ${ranked[1][0]}`;
  return ranked[0][0];
}

// ── Niche ───────────────────────────────────────────────────────────────────
// Content niche from bio + captions + hashtags (+ Instagram's own category as a
// tie-breaker). Keyword scoring — approximate, meant for sorting creators.
const NICHES = [
  ['Politics', 'politics political election vote bjp congress aap modi rahul kejriwal yogi minister mla mp parliament sarkar neta rajneeti chunav loksabha vidhansabha government opposition rss'],
  ['News & Current affairs', 'news breakingnews breaking headline headlines reporter journalist journalism khabar samachar newsupdate currentaffairs geopolitics'],
  ['Comedy & Memes', 'comedy funny meme memes humor humour prank roast jokes joke comedian lol hasi masti fun standup'],
  ['Beauty & Fashion', 'makeup beauty skincare skin hair fashion outfit style styling saree lehenga lipstick grwm nails salon bridal'],
  ['Food', 'food recipe recipes cooking cook chef foodie khana kitchen streetfood restaurant tasty dish biryani snacks'],
  ['Travel', 'travel traveller travelling trip tour explore wanderlust trek mountains beach roadtrip ghumna yatra'],
  ['Fitness & Health', 'fitness gym workout yoga health healthy diet weightloss exercise bodybuilding protein wellness'],
  ['Devotional & Spiritual', 'bhakti devotional spiritual god temple mandir mahadev shiv shiva krishna radha ram hanuman bhajan jai shri shree sanatan dharma gurudwara waheguru allah islamic puja aarti'],
  ['Education', 'education study student exam upsc ssc neet jee class teacher learn learning knowledge facts gk tips career coaching'],
  ['Tech', 'tech technology gadget gadgets mobile smartphone iphone android ai coding software laptop review unboxing'],
  ['Finance & Business', 'finance money stock stocks market trading investment invest mutualfund crypto business startup entrepreneur sharemarket'],
  ['Music', 'music song songs singer singing cover rapper rap guitar musician lyrics album'],
  ['Dance', 'dance dancer dancing choreography choreographer bhangra garba'],
  ['Gaming', 'gaming gamer game games bgmi freefire pubg esports'],
  ['Sports', 'cricket football sports sport ipl kabaddi athlete match player'],
  ['Motivation', 'motivation motivational inspiration inspirational success mindset quotes life lessons'],
  ['Acting & Entertainment', 'actor actress acting film films movie movies bollywood serial web series shooting entertainment'],
  ['Family & Lifestyle', 'lifestyle vlog vlogs vlogger daily life family couple mom mother baby kids parenting home'],
  ['Local / City page', 'city local jharkhand bihar kanpur lucknow delhi mumbai patna ranchi assam guwahati punjab haryana bilaspur chandigarh district'],
];
const NICHE_SETS = NICHES.map(([n, w]) => [n, new Set(w.split(' '))]);
const CATEGORY_HINT = [
  [/news|media/i, 'News & Current affairs'], [/politic|government/i, 'Politics'],
  [/beauty|cosmetic|fashion|clothing/i, 'Beauty & Fashion'], [/food|restaurant|chef/i, 'Food'],
  [/fitness|gym|health|sport/i, 'Fitness & Health'], [/musician|band|music|singer/i, 'Music'],
  [/dance/i, 'Dance'], [/gaming|video creator/i, 'Gaming'], [/education|school|teacher/i, 'Education'],
  [/actor|film|entertainment|tv/i, 'Acting & Entertainment'], [/religio|spiritual/i, 'Devotional & Spiritual'],
  [/comedian/i, 'Comedy & Memes'], [/travel/i, 'Travel'], [/finance|business/i, 'Finance & Business'],
];

function niche(profile, reels) {
  // Bio + name describe the creator directly, so they count 3x a caption word.
  const about = [profile && profile.biography, profile && profile.fullName].join(' ');
  const parts = [about, about, about];
  const posts = [...((profile && profile.latestPosts) || []), ...(reels || [])];
  for (const p of posts) {
    parts.push(captionText(p));
    if (Array.isArray(p.hashtags)) parts.push(p.hashtags.join(' '));
  }
  const words = parts.join(' ').normalize('NFKC').toLowerCase().replace(/#/g, ' ').match(/[a-z]{2,}/g) || [];
  const score = {};
  for (const w of words) {
    for (const [n, set] of NICHE_SETS) if (set.has(w)) score[n] = (score[n] || 0) + 1;
  }
  const cat = String((profile && profile.businessCategoryName) || '');
  for (const [re, n] of CATEGORY_HINT) if (re.test(cat)) { score[n] = (score[n] || 0) + 2; break; }
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  return ranked.length && ranked[0][1] >= 2 ? ranked[0][0] : 'Other';
}

module.exports = { LAST_N, newestReels, avgViews, engagementRate, language, langOfText, niche };
