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

  if (blanket) say('⛔', 'Disallow: /', 'this site asks not to be crawled — stop here, see NOTES');
  else say('✓', `${disallows.length} Disallow rules`, disallows.slice(0, 8).join(' ') || '(none)');

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
console.log(`\n▸ server-rendered listings?`);
// Heuristic: job listing pages that SSR have many links whose href looks like a
// job detail page. A shell app has almost none.
const links = [...html.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1]);
// Hyphenated slugs matter here: Albanian boards use /vende-pune/,
// /vende-te-lira-pune/, /shpallje-pune/ — an anchored word-only pattern
// misses all of them, which would make every local board look client-rendered.
const JOB_PATH = /\/[^/]*(job|vende|pune|pun[ëe]|punesim|position|vacancy|oferta|listing|shpallje|karrier)[^/]*\//i;
const jobish = links.filter((h) => JOB_PATH.test(h));
const uniqueJobish = [...new Set(jobish)];
findings.ssr = uniqueJobish.length >= 5;

if (findings.ssr) {
  say('✓', `${uniqueJobish.length} job-detail links in served HTML`, 'scrapeable without a browser');
  console.log('   samples:');
  for (const l of uniqueJobish.slice(0, 5)) console.log(`     ${l}`);
} else {
  say('⚠', `only ${uniqueJobish.length} job-detail links`, 'listings are probably injected by JS — use the API, not a scraper');
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
