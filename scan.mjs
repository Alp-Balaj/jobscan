#!/usr/bin/env node
// @ts-check
/**
 * scan.mjs — minimal zero-token job scanner.
 *
 * Loads config/portals.yml, routes each entry through the vendored provider
 * registry, fetches in bounded parallel, dedups, filters against your profile,
 * and writes data/jobs.md (human + agent readable) plus data/jobs.json.
 *
 * No LLM calls. No network beyond the boards you list. Run it as often as you like.
 *
 *   node scan.mjs                 # scan everything enabled
 *   node scan.mjs --only remoteok # scan one provider or entry name
 *   node scan.mjs --since 14      # only postings seen/posted in last 14 days
 *   node scan.mjs --json          # write jobs.json only, no markdown
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

import { loadProviders, resolveProvider } from './providers/_registry.mjs';
import { makeHttpCtx, sleep } from './providers/_http.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROVIDERS_DIR = path.join(ROOT, 'providers');
const CONFIG = path.join(ROOT, 'config', 'portals.yml');
const OUT_DIR = path.join(ROOT, 'data');

// ── CLI ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : (argv[i + 1] ?? true);
};
const ONLY = /** @type {string|null} */ (flag('only'));
const SINCE_DAYS = Number(flag('since') ?? 0) || 0;
const JSON_ONLY = argv.includes('--json');
const CONCURRENCY = Number(flag('concurrency') ?? 5) || 5;

// --profile backend  →  config/profile.backend.yml  →  data/jobs.backend.md
// Omitted            →  config/profile.yml         →  data/jobs.md
// Namespacing the OUTPUT matters as much as the input: without it a second
// scan silently overwrites the first, and you lose the list you were working.
const PROFILE_NAME = typeof flag('profile') === 'string' ? String(flag('profile')) : null;
if (PROFILE_NAME && !/^[a-z0-9-]+$/i.test(PROFILE_NAME)) {
  console.error(`\u2716 --profile must be a plain name (a-z, 0-9, -), got "${PROFILE_NAME}"`);
  process.exit(1);
}
const SUFFIX = PROFILE_NAME ? `.${PROFILE_NAME}` : '';
const PROFILE = path.join(ROOT, 'config', `profile${SUFFIX}.yml`);

// ── config ───────────────────────────────────────────────────────────────────
function loadYaml(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return yaml.load(readFileSync(file, 'utf8')) ?? fallback;
  } catch (err) {
    console.error(`✖ ${path.basename(file)}: ${err.message}`);
    process.exit(1);
  }
}

const portals = loadYaml(CONFIG, null);
if (!portals) {
  console.error(`✖ no config/portals.yml — copy config/portals.example.yml first.`);
  process.exit(1);
}
if (PROFILE_NAME && !existsSync(PROFILE)) {
  console.error(`\u2716 no config/profile${SUFFIX}.yml \u2014 available: ${
    readdirSync(path.join(ROOT, 'config'))
      .filter(f => /^profile\..+\.yml$/.test(f))
      .map(f => f.replace(/^profile\.|\.yml$/g, ''))
      .join(', ') || '(none)'
  }`);
  process.exit(1);
}
const profile = loadYaml(PROFILE, {});

/** Entries from both sections; job_boards and tracked_companies route identically. */
const entries = [...(portals.job_boards ?? []), ...(portals.tracked_companies ?? [])]
  .filter((e) => e && e.enabled !== false)
  .filter((e) => !ONLY || e.name === ONLY || e.provider === ONLY);

if (!entries.length) {
  console.error('✖ no enabled entries matched.');
  process.exit(1);
}

// ── filters (all optional — absent config means "keep everything") ───────────
const F = profile.filters ?? {};
const lower = (s) => String(s ?? '').toLowerCase();
const anyMatch = (haystack, needles) =>
  !needles?.length || needles.some((n) => lower(haystack).includes(lower(n)));

function keep(job) {
  const blob = `${job.title} ${job.location} ${job.description ?? ''}`;

  if (F.title_include?.length && !anyMatch(job.title, F.title_include)) return false;
  if (F.title_exclude?.length && anyMatch(job.title, F.title_exclude)) return false;
  if (F.exclude?.length && anyMatch(blob, F.exclude)) return false;

  // Location: keep if it matches an allowed location OR looks remote.
  if (F.location_include?.length) {
    const remote = /remote|anywhere|worldwide|distributed|work from home/i.test(
      `${job.location} ${job.title}`,
    );
    if (!remote && !anyMatch(job.location, F.location_include)) return false;
  }

  if (SINCE_DAYS && job.postedAt) {
    const cutoff = Date.now() - SINCE_DAYS * 86_400_000;
    if (job.postedAt < cutoff) return false;
  }
  return true;
}

// ── dedup ────────────────────────────────────────────────────────────────────
/** Strip tracking params and trailing slashes so the same posting collapses. */
function dedupKey(job, provider) {
  if (typeof provider?.dedupKey === 'function') {
    try {
      const k = provider.dedupKey(job);
      if (k) return `${provider.id}:${k}`;
    } catch { /* fall through to URL */ }
  }
  try {
    const u = new URL(job.url);
    u.hash = '';
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|ref|source|gh_src|lever-|src$)/i.test(p)) u.searchParams.delete(p);
    }
    return `${u.host}${u.pathname.replace(/\/+$/, '')}${u.search}`.toLowerCase();
  } catch {
    return lower(`${job.company}|${job.title}`);
  }
}

// ── scan ─────────────────────────────────────────────────────────────────────
async function pool(items, size, worker) {
  const out = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (cursor < items.length) out.push(await worker(items[cursor++]));
  });
  await Promise.all(runners);
  return out;
}

const providers = await loadProviders(PROVIDERS_DIR);
console.log(`▸ ${providers.size} providers loaded, ${entries.length} entries enabled\n`);

const ctx = { ...makeHttpCtx(), sleep: (ms) => sleep(ms, {}) };
const seen = new Map();
const stats = [];

await pool(entries, CONCURRENCY, async (entry) => {
  const resolved = resolveProvider(entry, providers);
  if (!resolved) {
    stats.push({ name: entry.name, status: 'unrouted', count: 0 });
    console.log(`  ?  ${entry.name.padEnd(28)} no provider claimed it`);
    return;
  }
  if ('error' in resolved) {
    stats.push({ name: entry.name, status: 'error', count: 0, error: resolved.error });
    console.log(`  ✖  ${entry.name.padEnd(28)} ${resolved.error}`);
    return;
  }

  const { provider } = resolved;
  const t0 = Date.now();
  try {
    const jobs = (await provider.fetch(entry, ctx)) ?? [];
    let kept = 0;
    for (const job of jobs) {
      if (!job?.title || !job?.url) continue;
      const normalized = {
        title: String(job.title).trim(),
        company: String(job.company || entry.name).trim(),
        location: String(job.location || '').trim(),
        url: job.url,
        source: provider.id,
        postedAt: job.postedAt ?? null,
        salary: job.salary ?? null,
        description: job.description ? String(job.description).slice(0, 4000) : '',
      };
      if (!keep(normalized)) continue;
      const key = dedupKey(normalized, provider);
      if (!seen.has(key)) {
        seen.set(key, normalized);
        kept++;
      }
    }
    stats.push({ name: entry.name, status: 'ok', count: kept, raw: jobs.length, ms: Date.now() - t0 });
    console.log(`  ✓  ${entry.name.padEnd(28)} ${String(kept).padStart(4)} kept / ${jobs.length} raw  (${provider.id}, ${Date.now() - t0}ms)`);
  } catch (err) {
    stats.push({ name: entry.name, status: 'fail', count: 0, error: err.message });
    console.log(`  ✖  ${entry.name.padEnd(28)} ${err.message.slice(0, 70)}`);
  }
});

// ── output ───────────────────────────────────────────────────────────────────
mkdirSync(OUT_DIR, { recursive: true });
const jobs = [...seen.values()].sort(
  (a, b) => (b.postedAt ?? 0) - (a.postedAt ?? 0) || a.company.localeCompare(b.company),
);

writeFileSync(path.join(OUT_DIR, `jobs${SUFFIX}.json`), JSON.stringify({ scannedAt: new Date().toISOString(), stats, jobs }, null, 2));

if (!JSON_ONLY) {
  const date = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '—');
  const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim() || '—';
  const money = (s) =>
    !s ? '—' : `${s.min ? Math.round(s.min / 1000) + 'k' : ''}${s.max ? '–' + Math.round(s.max / 1000) + 'k' : ''} ${s.currency ?? ''}`.trim();

  const md = [
    `# Job scan — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    ``,
    `${jobs.length} unique postings from ${stats.filter((s) => s.status === 'ok').length}/${entries.length} sources.`,
    ``,
    `| # | Role | Company | Location | Posted | Comp | Source |`,
    `|---|------|---------|----------|--------|------|--------|`,
    ...jobs.map((j, i) =>
      `| ${i + 1} | [${cell(j.title)}](${j.url}) | ${cell(j.company)} | ${cell(j.location)} | ${date(j.postedAt)} | ${money(j.salary)} | ${j.source} |`,
    ),
    ``,
    `## Source health`,
    ``,
    `| Source | Status | Kept | Note |`,
    `|--------|--------|------|------|`,
    ...stats.map((s) => `| ${cell(s.name)} | ${s.status} | ${s.count} | ${cell(s.error ?? '')} |`),
    ``,
  ].join('\n');
  writeFileSync(path.join(OUT_DIR, `jobs${SUFFIX}.md`), md);
}

const failed = stats.filter((s) => s.status !== 'ok').length;
console.log(`\n▸ ${jobs.length} unique postings → data/jobs.md${failed ? `  (${failed} source(s) had trouble)` : ''}`);
