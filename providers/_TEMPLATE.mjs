// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

/**
 * _TEMPLATE.mjs — copy this to providers/<yourboard>.mjs and fill in ONE of the
 * three shapes below. Delete the other two and this header.
 *
 * The leading underscore keeps this file OUT of the registry, so an unfinished
 * template can never run. Your copy must NOT start with an underscore.
 *
 * Run `node recon.mjs https://theboard.com` first — it tells you which shape.
 *
 * Contract:
 *   id      unique string
 *   detect  optional; return {url} to claim a portals.yml entry, else null
 *   fetch   required; return an array of Job objects
 *
 * Job: { title, url, company, location, description?, postedAt?, salary? }
 *   title/url are required and must be non-empty; url must be absolute.
 *   Everything else is optional — omit rather than inventing a value.
 *
 * Rules that are not optional:
 *   - Use ctx.fetchJson / ctx.fetchText. Never bare fetch() — you lose the
 *     timeout, the SSRF guard and the retry policy.
 *   - Pass { redirect: 'error' } so a server-side redirect can't walk you off
 *     the allowlisted host.
 *   - Keep a HOSTS allowlist and assert against it. Providers are the one place
 *     a URL from config reaches the network.
 *   - Return [] on "no results". Throw only on a real failure. scan.mjs shows
 *     your throw message in the Source health table, so make it readable.
 */

import { htmlToText } from './_html-to-text.mjs';
import { decodeEntities } from './_html-entities.mjs';

const HOSTS = new Set(['example.com', 'www.example.com']);
const BASE = 'https://example.com';

/** @param {string} url */
function assertHost(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`template: invalid URL: ${url}`); }
  if (u.protocol !== 'https:') throw new Error(`template: must use HTTPS: ${url}`);
  if (!HOSTS.has(u.hostname)) throw new Error(`template: untrusted hostname "${u.hostname}"`);
  return url;
}

/** NaN-safe date parse — `|| undefined` would also swallow epoch 0. */
function toEpochMs(value) {
  if (!value) return undefined;
  const p = Date.parse(value);
  return Number.isNaN(p) ? undefined : p;
}

/** @type {Provider} */
export default {
  id: 'CHANGE-ME',

  detect(entry) {
    // Board-wide feed with no per-entry URL — the usual case for a local board.
    // Requires `provider: CHANGE-ME` in portals.yml, which is what you want:
    // it can never claim an entry you didn't point at it.
    return entry?.provider === 'CHANGE-ME' ? { url: BASE } : null;
  },

  async fetch(entry, ctx) {
    // ════════════════════════════════════════════════════════════════════════
    // SHAPE 1 — JSON API.  Best case. Stable, cheap, survives redesigns.
    // ════════════════════════════════════════════════════════════════════════
    const url = assertHost(`${BASE}/api/jobs?page=1&per_page=100`);
    const data = /** @type {any} */ (await ctx.fetchJson(url, { redirect: 'error' }));

    // Be defensive about the envelope — boards wrap results differently and
    // change it without warning. Fail with a message that says what you got.
    const rows = Array.isArray(data) ? data
      : Array.isArray(data?.results) ? data.results
      : Array.isArray(data?.data) ? data.data
      : Array.isArray(data?.jobs) ? data.jobs
      : null;
    if (!rows) throw new Error(`CHANGE-ME: unexpected response shape (keys: ${Object.keys(data ?? {}).join(',') || 'none'})`);

    return rows
      .filter((r) => r && typeof r.title === 'string' && r.title.trim())
      .map((r) => ({
        title: r.title.trim(),
        // Build absolute URLs from a slug/id — never trust a relative href.
        url: new URL(r.url ?? `/job/${r.slug ?? r.id}`, BASE).href,
        company: String(r.company?.name ?? r.company ?? entry.name ?? '').trim(),
        location: String(r.location ?? r.city ?? '').trim(),
        // Only set description when the LIST payload carries it. Never make a
        // per-job request here — that turns one call into two hundred.
        description: r.description ? htmlToText(String(r.description)) : undefined,
        postedAt: toEpochMs(r.published_at ?? r.created_at ?? r.date),
      }));

    /* ═══════════════════════════════════════════════════════════════════════
    // SHAPE 2 — RSS / Atom feed. Nearly as good as JSON. No XML library needed
    // for a feed this simple; a real parser is overkill and adds a dependency.
    // ═══════════════════════════════════════════════════════════════════════
    const xml = await ctx.fetchText(assertHost(`${BASE}/feed`), { redirect: 'error' });
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);
    const tag = (block, name) => {
      const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
      if (!m) return '';
      return decodeEntities(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim();
    };
    return items
      .map((block) => ({
        title: tag(block, 'title'),
        url: tag(block, 'link'),
        company: entry.name ?? '',
        location: tag(block, 'category'),
        description: htmlToText(tag(block, 'description')).slice(0, 4000) || undefined,
        postedAt: toEpochMs(tag(block, 'pubDate')),
      }))
      .filter((j) => j.title && /^https?:\/\//i.test(j.url));
    ═══════════════════════════════════════════════════════════════════════ */

    /* ═══════════════════════════════════════════════════════════════════════
    // SHAPE 3 — server-rendered HTML. Fragile by nature. Only use this when
    // recon.mjs found no API and no feed AND confirmed the listings are in the
    // served HTML.
    //
    // Two rules that make it survivable:
    //   a) Anchor on things that change slowly — URL patterns, semantic tags —
    //      not on generated class names like `css-1x2y3z`.
    //   b) Return [] rather than throwing when the page parses but matches
    //      nothing, and let the Kept/raw column tell you it broke. A hard throw
    //      on every redesign is noise; a silent 0 you can see is signal.
    //
    // If you end up needing real selectors, `npm i cheerio` and use it. Regex
    // over nested HTML is how you get subtly wrong data rather than an error.
    // ═══════════════════════════════════════════════════════════════════════
    const page = await ctx.fetchText(assertHost(`${BASE}/jobs`), { redirect: 'error' });
    const jobs = [];
    // Anchor on the detail-URL pattern — that outlives any CSS refactor.
    for (const m of page.matchAll(/<a[^>]+href=["']([^"']*\/job\/[^"']+)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi)) {
      const title = htmlToText(m[2]).trim();
      if (!title) continue;
      jobs.push({
        title,
        url: new URL(m[1], BASE).href,
        company: entry.name ?? '',
        location: '',
      });
    }
    if (!jobs.length) console.error(`⚠️  CHANGE-ME: page fetched but matched 0 listings — selector probably stale`);
    return jobs;
    ═══════════════════════════════════════════════════════════════════════ */
  },
};
