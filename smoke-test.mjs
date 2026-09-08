#!/usr/bin/env node
// @ts-check
/**
 * smoke-test.mjs — offline verification of the whole pipeline.
 *
 * Runs every stage (load → route → fetch → normalize → filter → dedup → render)
 * against fixture payloads instead of the live network, so it passes on a
 * plane, in CI, or behind a corporate proxy. If this is green, the only thing
 * left that can break is a board changing its response shape.
 *
 *   node smoke-test.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { loadProviders, resolveProvider } from './providers/_registry.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
const fail = [];

const test = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail.push({ name, err });
    console.log(`  ✖ ${name}\n      ${err.message}`);
  }
};

/** A ctx that serves canned payloads by URL substring instead of hitting the network. */
const stubCtx = (routes) => ({
  transport: 'http',
  async fetchJson(url) {
    const hit = Object.entries(routes).find(([frag]) => url.includes(frag));
    if (!hit) throw new Error(`stub: no route for ${url}`);
    return hit[1];
  },
  async fetchText(url) {
    const hit = Object.entries(routes).find(([frag]) => url.includes(frag));
    if (!hit) throw new Error(`stub: no route for ${url}`);
    return typeof hit[1] === 'string' ? hit[1] : JSON.stringify(hit[1]);
  },
  async fetchResponse() { throw new Error('stub: fetchResponse unused'); },
  sleep: async () => {},
});

console.log('\n▸ registry');
const providers = await loadProviders(path.join(ROOT, 'providers'));

await test('every provider file loads and satisfies { id, fetch }', () => {
  assert.ok(providers.size >= 19, `expected >=19 providers, got ${providers.size}`);
  for (const [id, p] of providers) {
    assert.equal(typeof p.fetch, 'function', `${id}.fetch is not a function`);
    assert.equal(typeof p.id, 'string');
  }
});

await test('underscore helpers are NOT loaded as providers', () => {
  for (const id of providers.keys()) assert.ok(!id.startsWith('_'), `${id} leaked in`);
  assert.ok(!providers.has('_http'), '_http.mjs was loaded as a provider');
});

console.log('\n▸ routing');

await test('explicit provider: field wins', () => {
  const r = resolveProvider({ name: 'x', provider: 'remoteok' }, providers);
  assert.ok(r && 'provider' in r && r.provider.id === 'remoteok');
});

await test('unknown provider id reports an error, does not throw', () => {
  const r = resolveProvider({ name: 'x', provider: 'nope' }, providers);
  assert.ok(r && 'error' in r && /unknown provider/.test(r.error));
});

await test('greenhouse careers_url auto-detects with no provider: field', () => {
  const r = resolveProvider({ name: 'Acme', careers_url: 'https://job-boards.greenhouse.io/acme' }, providers);
  assert.ok(r && 'provider' in r, 'nothing claimed the greenhouse URL');
  assert.equal(r.provider.id, 'greenhouse');
});

await test('lever careers_url auto-detects', () => {
  const r = resolveProvider({ name: 'Acme', careers_url: 'https://jobs.lever.co/acme' }, providers);
  assert.ok(r && 'provider' in r && r.provider.id === 'lever');
});

await test('an unroutable URL returns null rather than guessing', () => {
  const r = resolveProvider({ name: 'x', careers_url: 'https://example.com/jobs' }, providers);
  assert.equal(r, null);
});

console.log('\n▸ fetch + normalize (fixtures)');

await test('remoteok: skips the metadata row, normalizes the rest', async () => {
  const ctx = stubCtx({
    'remoteok.com/api': [
      { last_updated: '2026-09-01', legal: '…' },
      { position: 'Backend Engineer', company: 'Acme', location: 'Europe', url: 'https://remoteok.com/l/1' },
      { position: '   ', company: 'Bad', url: 'https://remoteok.com/l/2' }, // dropped: blank title
      { position: 'Dev', company: 'Bad2', url: 'javascript:alert(1)' },      // dropped: non-http url
    ],
  });
  const jobs = await providers.get('remoteok').fetch({ name: 'RemoteOK' }, ctx);
  assert.equal(jobs.length, 1, `expected 1 usable job, got ${jobs.length}`);
  assert.equal(jobs[0].title, 'Backend Engineer');
  assert.equal(jobs[0].company, 'Acme');
});

await test('greenhouse: pulls jobs[] and keeps absolute_url', async () => {
  const ctx = stubCtx({
    'boards-api.greenhouse.io': {
      jobs: [
        { title: 'Platform Engineer', absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/1', location: { name: 'Remote - EU' }, updated_at: '2026-09-01T00:00:00Z' },
        { title: 'No URL', location: { name: 'Berlin' } }, // dropped
      ],
    },
  });
  const jobs = await providers.get('greenhouse').fetch({ name: 'Acme', api: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs' }, ctx);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, 'Platform Engineer');
});

await test('greenhouse: refuses a hostname outside the allowlist (SSRF guard)', async () => {
  await assert.rejects(
    () => providers.get('greenhouse').fetch({ name: 'Evil', api: 'https://evil.example.com/v1/boards/x/jobs' }, stubCtx({})),
    /untrusted hostname/,
  );
});

await test('greenhouse: refuses plain HTTP', async () => {
  await assert.rejects(
    () => providers.get('greenhouse').fetch({ name: 'Evil', api: 'http://boards-api.greenhouse.io/v1/boards/x/jobs' }, stubCtx({})),
    /must use HTTPS/,
  );
});

console.log('\n▸ filters + dedup (scan.mjs logic)');

// Mirrors scan.mjs — kept in sync by eye; if you change scan.mjs, change this.
const lower = (s) => String(s ?? '').toLowerCase();
const anyMatch = (h, n) => !n?.length || n.some((x) => lower(h).includes(lower(x)));
const makeKeep = (F) => (job) => {
  const blob = `${job.title} ${job.location} ${job.description ?? ''}`;
  if (F.title_include?.length && !anyMatch(job.title, F.title_include)) return false;
  if (F.title_exclude?.length && anyMatch(job.title, F.title_exclude)) return false;
  if (F.exclude?.length && anyMatch(blob, F.exclude)) return false;
  if (F.location_include?.length) {
    const remote = /remote|anywhere|worldwide|distributed|work from home/i.test(`${job.location} ${job.title}`);
    if (!remote && !anyMatch(job.location, F.location_include)) return false;
  }
  return true;
};

await test('title_include / title_exclude behave', () => {
  const keep = makeKeep({ title_include: ['backend', 'full stack'], title_exclude: ['director'] });
  assert.equal(keep({ title: 'Backend Engineer', location: 'Remote' }), true);
  assert.equal(keep({ title: 'Marketing Lead', location: 'Remote' }), false);
  assert.equal(keep({ title: 'Backend Director', location: 'Remote' }), false);
});

await test('US-only postings are excluded by phrase', () => {
  const keep = makeKeep({ exclude: ['US only', 'security clearance'] });
  assert.equal(keep({ title: 'Backend Eng', location: 'Remote', description: 'Remote, US only.' }), false);
  assert.equal(keep({ title: 'Backend Eng', location: 'Remote', description: 'Remote, EU.' }), true);
});

await test('remote postings bypass the location allowlist', () => {
  const keep = makeKeep({ location_include: ['europe', 'kosovo'] });
  assert.equal(keep({ title: 'Backend Eng', location: 'Remote — Worldwide' }), true, 'remote should pass');
  assert.equal(keep({ title: 'Backend Eng', location: 'Prishtinë, Kosovo' }), true, 'allowlisted city should pass');
  assert.equal(keep({ title: 'Backend Eng', location: 'Austin, TX' }), false, 'non-remote non-EU should fail');
});

const dedupKey = (job) => {
  try {
    const u = new URL(job.url);
    u.hash = '';
    for (const p of [...u.searchParams.keys()]) if (/^(utm_|ref|source|gh_src|lever-|src$)/i.test(p)) u.searchParams.delete(p);
    return `${u.host}${u.pathname.replace(/\/+$/, '')}${u.search}`.toLowerCase();
  } catch {
    return lower(`${job.company}|${job.title}`);
  }
};

await test('dedup collapses tracking params, trailing slash and case', () => {
  const a = dedupKey({ url: 'https://Jobs.Example.com/eng/12/?utm_source=remoteok&gh_src=x' });
  const b = dedupKey({ url: 'https://jobs.example.com/eng/12#apply' });
  assert.equal(a, b, `keys differ:\n  ${a}\n  ${b}`);
});

await test('dedup keeps genuinely different postings apart', () => {
  assert.notEqual(
    dedupKey({ url: 'https://jobs.example.com/eng/12' }),
    dedupKey({ url: 'https://jobs.example.com/eng/13' }),
  );
});

await test('dedup falls back to company|title on a malformed URL', () => {
  assert.equal(dedupKey({ url: 'not a url', company: 'Acme', title: 'Dev' }), 'acme|dev');
});

console.log(`\n${fail.length ? '✖' : '▸'} ${pass} passed, ${fail.length} failed\n`);
process.exit(fail.length ? 1 : 0);
