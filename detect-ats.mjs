#!/usr/bin/env node
// @ts-check
/**
 * detect-ats.mjs — point it at a company careers page, get the portals.yml stanza.
 *
 * This is the piece that makes the Balkan half of your search work. Local job
 * boards (KosovaJob, PortalPunes) have no public API — but plenty of regional
 * companies run their hiring on Workable, Recruitee, Personio or Teamtailor,
 * all of which DO have public APIs and are already vendored here.
 *
 * So the workflow is: collect careers URLs → run this → paste the hits into
 * config/portals.yml. You never need to scrape a local board.
 *
 *   node detect-ats.mjs https://gjirafa.com/careers
 *   node detect-ats.mjs --file companies.txt      # one URL per line
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProviders, resolveProvider } from './providers/_registry.mjs';
import { makeHttpCtx } from './providers/_http.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const providers = await loadProviders(path.join(ROOT, 'providers'));
const ctx = makeHttpCtx();

const argv = process.argv.slice(2);
const fileIdx = argv.indexOf('--file');
const urls =
  fileIdx !== -1
    ? readFileSync(argv[fileIdx + 1], 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    : argv.filter((a) => a.startsWith('http'));

if (!urls.length) {
  console.error('usage: node detect-ats.mjs <careers-url> [...]  |  --file companies.txt');
  process.exit(1);
}

/** ATS fingerprints found in page HTML when the careers page embeds/redirects to a vendor. */
const FINGERPRINTS = [
  [/boards\.greenhouse\.io\/([a-z0-9_-]+)|job-boards(?:\.eu)?\.greenhouse\.io\/([a-z0-9_-]+)/i, 'greenhouse'],
  [/jobs\.lever\.co\/([a-z0-9_-]+)/i, 'lever'],
  [/jobs\.ashbyhq\.com\/([a-z0-9_.-]+)/i, 'ashby'],
  [/([a-z0-9_-]+)\.workable\.com|apply\.workable\.com\/([a-z0-9_-]+)/i, 'workable'],
  [/([a-z0-9_-]+)\.recruitee\.com/i, 'recruitee'],
  [/([a-z0-9_-]+)\.jobs\.personio\.(?:de|com)/i, 'personio'],
  [/([a-z0-9_-]+)\.teamtailor\.com/i, 'teamtailor'],
  [/([a-z0-9_-]+)\.breezy\.hr/i, 'breezy'],
  [/careers\.smartrecruiters\.com\/([a-z0-9_-]+)|api\.smartrecruiters\.com/i, 'smartrecruiters'],
  [/([a-z0-9_-]+)\.bamboohr\.com/i, 'bamboohr (not vendored — add from upstream)'],
  [/myworkdayjobs\.com/i, 'workday (not vendored — add from upstream)'],
];

const hits = [];
const misses = [];

for (const url of urls) {
  const label = url.replace(/^https?:\/\//, '').slice(0, 50);
  // 1. Cheap path: does a vendored provider's detect() already claim this URL?
  const routed = resolveProvider({ name: label, careers_url: url }, providers);
  if (routed && 'provider' in routed) {
    hits.push({ url, provider: routed.provider.id, via: 'url pattern' });
    console.log(`✓ ${label.padEnd(52)} → ${routed.provider.id}  (url pattern)`);
    continue;
  }

  // 2. Fetch the page and look for an embedded ATS widget or link.
  try {
    const html = await ctx.fetchText(url, { timeoutMs: 12_000 });
    const found = FINGERPRINTS.find(([re]) => re.test(html));
    if (found) {
      const m = html.match(found[0]);
      const slug = m?.slice(1).find(Boolean) ?? '?';
      hits.push({ url, provider: found[1], slug, via: 'page fingerprint' });
      console.log(`✓ ${label.padEnd(52)} → ${found[1]}  (embedded, slug: ${slug})`);
    } else {
      misses.push({ url, reason: 'no ATS fingerprint in page' });
      console.log(`·  ${label.padEnd(52)}   no known ATS — needs a custom provider or manual checking`);
    }
  } catch (err) {
    misses.push({ url, reason: err.message });
    console.log(`✖ ${label.padEnd(52)}   ${err.message.slice(0, 40)}`);
  }
}

if (hits.length) {
  console.log(`\n# ── paste into config/portals.yml under tracked_companies: ──\n`);
  for (const h of hits) {
    const name = new URL(h.url).hostname.replace(/^www\./, '').split('.')[0];
    console.log(`  - name: ${name}`);
    console.log(`    careers_url: "${h.url}"`);
    if (!h.provider.includes('not vendored')) console.log(`    provider: ${h.provider}`);
    console.log(`    enabled: true`);
  }
}
console.log(`\n▸ ${hits.length} routable, ${misses.length} not.`);
