#!/usr/bin/env node
// @ts-check
/**
 * recon.mjs — work out what shape a job board is before you write a provider.
 *
 * Answers, in order of how much they matter:
 *   1. What does robots.txt allow? (read it before anything else)
 *   2. Is there a JSON API behind the page? → cheap, stable provider
 *   3. Is there an RSS/Atom feed?           → cheap, stable provider
 *   4. Are listings in the served HTML?     → scrapeable, fragile
 *   5. Or is it a JS-rendered SPA?          → needs the API, or a browser
 *
 *   node recon.mjs https://kosovajob.com
 *   node recon.mjs https://kosovajob.com --path /jobs
 *
 * This tool only READS public pages, one request at a time. It does not defeat
 * bot protection, does not authenticate, and does not crawl. If a site says no,
 * that is the answer — see NOTES at the bottom.
 */

import { makeHttpCtx, BROWSER_LIKE_USER_AGENT } from './providers/_http.mjs';

const ctx = makeHttpCtx();
const argv = process.argv.slice(2);
const base = argv.find((a) => a.startsWith('http'));
const pathIdx = argv.indexOf('--path');
const listPath = pathIdx !== -1 ? argv[pathIdx + 1] : null;

if (!base) {
  console.error('usage: node recon.mjs https://board.example [--path /jobs]');
  process.exit(1);
}

const origin = new URL(base).origin;
const target = listPath ? new URL(listPath, origin).href : base;
const get = (u) => ctx.fetchText(u, { timeoutMs: 15_000, headers: { 'user-agent': BROWSER_LIKE_USER_AGENT } });

const say = (icon, label, detail = '') => console.log(`${icon} ${label}${detail ? ` — ${detail}` : ''}`);
const findings = { api: [], feeds: [], ssr: null, framework: null, robots: null };

// ── 1. robots.txt — read this first, and mean it ────────────────────────────
console.log(`\n▸ robots.txt`);
try {
  const robots = await get(`${origin}/robots.txt`);
  findings.robots = robots;
  const disallows = [...robots.matchAll(/^\s*Disallow:\s*(\S+)/gim)].map((m) => m[1]);
  const sitemaps = [...robots.matchAll(/^\s*Sitemap:\s*(\S+)/gim)].map((m) => m[1]);
  const blanket = disallows.includes('/');

  const real = disallows.filter((d) => d && d !== '');
  if (blanket) say('⛔', 'Disallow: /', 'this site asks not to be crawled — stop here, see NOTES');
  else if (!real.length) say('✓', 'Disallow: (empty)', 'an empty Disallow means ALLOW ALL — nothing here blocks you');
  else say('✓', `${real.length} Disallow rules`, real.slice(0, 8).join(' '));

  const apiBlocked = disallows.some((d) => /^\/api/i.test(d));
  if (apiBlocked) say('⚠', '/api is disallowed', 'do not use the JSON endpoints below');
  for (const s of sitemaps) { say('·', 'sitemap', s); findings.feeds.push(s); }
} catch (err) {
  say('·', 'no robots.txt', err.message.slice(0, 50));
}

// ── 2. the listing page itself ──────────────────────────────────────────────
console.log(`\n▸ listing page (${target})`);
let html = '';
try {
  html = await get(target);
  say('✓', `${(html.length / 1024).toFixed(0)} KB served`);
} catch (err) {
  say('✖', 'could not fetch', err.message);
  process.exit(1);
}

// Framework fingerprints — these tell you where the data actually lives.
const FRAMEWORKS = [
  [/__NEXT_DATA__/, 'Next.js', 'data is in the __NEXT_DATA__ <script> JSON — parse it directly, no API call needed'],
  [/__NUXT__/, 'Nuxt', 'data is in window.__NUXT__ — parse it out of the HTML'],
  [/window\.__INITIAL_STATE__/, 'SPA w/ initial state', 'data is in __INITIAL_STATE__'],
  [/wp-content|wp-json/, 'WordPress', 'try /wp-json/wp/v2/ and /feed — usually a clean JSON API'],
  [/Drupal\.settings|\/sites\/default\/files/, 'Drupal', 'try /jsonapi/'],
  [/data-reactroot|react-dom/, 'React (client-rendered)', 'listings likely NOT in served HTML — find the XHR'],
];
for (const [re, name, hint] of FRAMEWORKS) {
  if (re.test(html)) { findings.framework = name; say('✓', name, hint); }
}
if (!findings.framework) say('·', 'no framework fingerprint', 'likely classic server-rendered HTML');

// ── 3. hidden JSON endpoints referenced by the page ─────────────────────────
console.log(`\n▸ JSON endpoints referenced in the page`);
const apiPaths = new Set();
for (const m of html.matchAll(/["'`](\/(?:api|graphql|wp-json|jsonapi)[^"'`\s]{0,120})["'`]/gi)) apiPaths.add(m[1]);
for (const m of html.matchAll(/["'`](https?:\/\/[^"'`\s]*\/(?:api|graphql|wp-json)[^"'`\s]{0,120})["'`]/gi)) apiPaths.add(m[1]);
if (apiPaths.size) {
  for (const p of [...apiPaths].slice(0, 15)) { say('✓', p); findings.api.push(p); }
  console.log('   → try each: curl -s "' + origin + [...apiPaths][0] + '" | head -c 400');
} else {
  say('·', 'none referenced inline', 'check DevTools → Network → Fetch/XHR while the page loads');
}

// ── 4. feed probes ──────────────────────────────────────────────────────────
console.log(`\n▸ feed probes`);
const FEED_CANDIDATES = ['/feed', '/rss', '/rss.xml', '/feed.xml', '/atom.xml', '/jobs/feed', '/jobs.rss', '/sitemap.xml', '/wp-json/wp/v2/posts'];
for (const p of FEED_CANDIDATES) {
  try {
    const body = await get(origin + p);
    const isFeed = /<rss|<feed|<urlset|<sitemapindex/i.test(body.slice(0, 600));
    const isJson = body.trimStart().startsWith('[') || body.trimStart().startsWith('{');
    if (isFeed || isJson) {
      const items = (body.match(/<item[\s>]|<entry[\s>]|<url>/gi) || []).length;
      say('✓', origin + p, `${isJson ? 'JSON' : 'XML'}${items ? `, ~${items} entries` : ''}`);
      findings.feeds.push(origin + p);
    }
  } catch { /* 404s are the norm here — silence is correct */ }
}
if (!findings.feeds.length) say('·', 'no feeds found');

// ── 5. are the listings actually in the HTML? ───────────────────────────────
console.log(`\n\u25b8 server-rendered listings?`);
// Heuristic: an SSR listing page carries many links whose PATH looks like a job
// detail page. Two traps this has to avoid, both found the hard way:
//   1. The HOST must never be tested. kosovajob.com contains "job", so matching
//      against the full href scored every asset on the site as a job link.
//      Parse the URL and test pathname only.
//   2. Assets (.css/.js/.ico/.json/.png/...) live under paths that can contain
//      the keyword too. Extension-filter them out.
const ASSET = /\.(css|js|mjs|json|ico|png|jpe?g|gif|svg|webp|avif|woff2?|ttf|eot|map|xml|txt|pdf)($|\?)/i;
const JOB_PATH = /\/[^/]*(job|vende|pune|pun[\u00eb\u00e9e]|punesim|position|vacanc|oferta|listing|shpallje|karrier|konkurs)[^/]*\//i;

/** href → pathname (+search), or null for anything not usable. */
function toPath(href) {
  try {
    // Handles absolute, protocol-relative (//host/x) and root-relative (/x).
    const u = new URL(href, origin);
    if (u.origin !== origin) return null;          // off-site link
    if (u.pathname === '/' || u.pathname === '') return null;
    if (ASSET.test(u.pathname)) return null;
    return u.pathname;
  } catch { return null; }
}

const paths = [...new Set(
  [...html.matchAll(/href=["']([^"']+)["']/gi)].map((m) => toPath(m[1])).filter(Boolean),
)];
const uniqueJobish = paths.filter((p) => JOB_PATH.test(p));
findings.ssr = uniqueJobish.length >= 5;

// The genuinely useful output: which path PREFIX repeats. That prefix is the
// anchor your provider's regex should use — far more stable than a CSS class.
const prefixes = new Map();
for (const p of uniqueJobish) {
  const seg = p.split('/').filter(Boolean);
  if (seg.length < 2) continue;
  const key = '/' + seg.slice(0, seg.length - 1).join('/') + '/';
  prefixes.set(key, (prefixes.get(key) ?? 0) + 1);
}
const ranked = [...prefixes.entries()].sort((a, b) => b[1] - a[1]);

if (findings.ssr) {
  say('\u2713', `${uniqueJobish.length} job-like paths in served HTML`, `out of ${paths.length} same-origin links`);
  if (ranked.length) {
    console.log('   repeating path patterns (anchor your scraper on the top one):');
    for (const [pre, n] of ranked.slice(0, 6)) console.log(`     ${String(n).padStart(4)} \u00d7  ${pre}<slug>`);
  }
  console.log('   samples:');
  for (const l of uniqueJobish.slice(0, 5)) console.log(`     ${l}`);
} else {
  say('\u26a0', `only ${uniqueJobish.length} job-like paths`, `out of ${paths.length} same-origin links \u2014 listings likely injected by JS`);
  if (paths.length) {
    console.log('   most common path prefixes seen (is one of these the listing route?):');
    const all = new Map();
    for (const p of paths) {
      const seg = p.split('/').filter(Boolean);
      if (!seg.length) continue;
      const k = '/' + seg[0] + '/';
      all.set(k, (all.get(k) ?? 0) + 1);
    }
    for (const [k, n] of [...all.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      console.log(`     ${String(n).padStart(4)} \u00d7  ${k}`);
    }
    console.log('   → if one looks like the listing route, re-run with --path ' + ([...all.keys()][0] ?? '/jobs'));
  }
}

// ── verdict ─────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(70)}`);
if (/Disallow:\s*\/\s*$/im.test(findings.robots || '') && !/Allow:/i.test(findings.robots || '')) {
  console.log('VERDICT: robots.txt disallows crawling. Do not write a provider for this source.');
} else if (findings.feeds.some((f) => !/sitemap/i.test(f))) {
  console.log('VERDICT: use the FEED shape. Cheapest and most stable — copy providers/_TEMPLATE.mjs, feed section.');
} else if (findings.api.length) {
  console.log('VERDICT: use the JSON shape. Verify one endpoint by hand first, then copy providers/_TEMPLATE.mjs, json section.');
} else if (findings.framework?.startsWith('Next') || findings.framework?.startsWith('Nuxt')) {
  console.log('VERDICT: embedded-state shape. The listings are in a <script> tag as JSON — parse that, do not scrape the DOM.');
} else if (findings.ssr) {
  console.log('VERDICT: HTML shape. Scrapeable but fragile — expect to fix it when they redesign. Use the html section of the template.');
} else {
  console.log('VERDICT: client-rendered with no obvious API. Open DevTools → Network → Fetch/XHR, reload,');
  console.log('         and find the request that returns the listings. That URL is your provider.');
}
console.log(`${'─'.repeat(70)}`);

console.log(`
NOTES
  • robots.txt and the site's Terms are the limit, not what is technically
    possible. A blanket Disallow, a login wall, or an explicit no-scraping
    clause means don't. There is no version of this that is worth a legal
    letter over a job search.
  • Never work around bot protection (Cloudflare / Vercel checkpoints, CAPTCHA).
    A 403 or a challenge page IS the answer.
  • Keep it to one request per run and cache. You are one person looking for a
    job, not a crawler — behave like it.
  • Many local boards let you subscribe to an email alert. That is often the
    supported, zero-effort version of what you are about to build.
`);
