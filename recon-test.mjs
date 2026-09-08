// Unit tests for recon.mjs's detection logic, against fixture HTML.
// The network half can't be tested offline; the parsing half is what breaks.
import assert from 'node:assert/strict';
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  ✓ ' + n); }
                      catch (e) { fail++; console.log('  ✖ ' + n + '\n      ' + e.message); } };

const origin = 'https://kosovajob.com';
const ASSET = /\.(css|js|mjs|json|ico|png|jpe?g|gif|svg|webp|avif|woff2?|ttf|eot|map|xml|txt|pdf)($|\?)/i;
const JOB_PATH = /\/[^/]*(job|vende|pune|pun[ëée]|punesim|position|vacanc|oferta|listing|shpallje|karrier|konkurs)[^/]*\//i;

function toPath(href) {
  try {
    const u = new URL(href, origin);
    if (u.origin !== origin) return null;
    if (u.pathname === '/' || u.pathname === '') return null;
    if (ASSET.test(u.pathname)) return null;
    return u.pathname;
  } catch { return null; }
}
const jobish = (html) => [...new Set(
  [...html.matchAll(/href=["']([^"']+)["']/gi)].map(m => toPath(m[1])).filter(Boolean)
)].filter(p => JOB_PATH.test(p));

console.log('\n▸ the kosovajob.com regression');
t('hostname containing "job" is NOT counted as a job link', () => {
  // These are the exact hrefs recon wrongly reported as 599 job links.
  const html = `<link href="//kosovajob.com/favicon.ico?vas=25">
                <link href="//kosovajob.com/css/style-v3.css?v=178">
                <a href="https://kosovajob.com/manifest.json">m</a>
                <a href="https://kosovajob.com/">home</a>
                <a href="https://kosovajob.com/rfq">rfq</a>`;
  const found = jobish(html);
  assert.equal(found.length, 0, 'should be 0, got ' + JSON.stringify(found));
});
t('assets are filtered even under a job-ish path', () => {
  assert.equal(jobish(`<a href="/vende-pune/style.css">x</a><a href="/jobs/app.js">y</a>`).length, 0);
});
t('off-site links are ignored', () => {
  assert.equal(jobish(`<a href="https://facebook.com/jobs/1">fb</a>`).length, 0);
});
t('the homepage is not a job link', () => {
  assert.equal(jobish(`<a href="https://kosovajob.com/">h</a><a href="/">h2</a>`).length, 0);
});

console.log('\n▸ real job links still match');
t('Albanian hyphenated slugs match', () => {
  const html = `<a href="/vende-pune/backend-zhvillues-123">a</a>
                <a href="/vende-te-lira-pune/456">b</a>
                <a href="/shpallje-pune/789">c</a>
                <a href="/konkurse/101">d</a>
                <a href="/karriera/112">e</a>`;
  assert.equal(jobish(html).length, 5, 'got ' + JSON.stringify(jobish(html)));
});
t('English job paths match', () => {
  const html = `<a href="/job/1">a</a><a href="/jobs/2">b</a><a href="/position/3">c</a>
                <a href="/vacancy/4">d</a><a href="/listing/5">e</a>`;
  assert.equal(jobish(html).length, 5);
});
t('protocol-relative same-origin job links match', () => {
  assert.equal(jobish(`<a href="//kosovajob.com/vende-pune/backend-1">a</a>`).length, 1);
});
t('duplicate hrefs collapse', () => {
  assert.equal(jobish(`<a href="/job/1">a</a><a href="/job/1">a again</a>`).length, 1);
});

console.log('\n▸ path-prefix ranking');
const rank = (paths) => {
  const m = new Map();
  for (const p of paths) {
    const seg = p.split('/').filter(Boolean);
    if (seg.length < 2) continue;
    const k = '/' + seg.slice(0, seg.length - 1).join('/') + '/';
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
t('ranks the dominant listing prefix first', () => {
  const r = rank(['/vende-pune/a', '/vende-pune/b', '/vende-pune/c', '/karriera/x']);
  assert.equal(r[0][0], '/vende-pune/');
  assert.equal(r[0][1], 3);
});

console.log('\n▸ framework + api detection');
const FRAMEWORKS = [[/__NEXT_DATA__/, 'Next.js'], [/__NUXT__/, 'Nuxt'],
  [/wp-content|wp-json/, 'WordPress'], [/data-reactroot|react-dom/, 'React (client-rendered)']];
const detect = h => FRAMEWORKS.filter(([re]) => re.test(h)).map(([, n]) => n);
t('detects Next.js', () => assert.ok(detect('<script id="__NEXT_DATA__">{}</script>').includes('Next.js')));
t('detects WordPress', () => assert.ok(detect('<link href="/wp-content/x.css">').includes('WordPress')));
t('plain HTML matches no framework', () => assert.equal(detect('<html><h1>Jobs</h1>').length, 0));

const apiPaths = h => [...new Set([...h.matchAll(/["'`](\/(?:api|graphql|wp-json|jsonapi)[^"'`\s]{0,120})["'`]/gi)].map(m => m[1]))];
t('finds inline /api paths', () => {
  const f = apiPaths(`<script>fetch("/api/v1/jobs?page=1")</script>`);
  assert.ok(f.includes('/api/v1/jobs?page=1'), JSON.stringify(f));
});
t('ignores non-api paths', () => assert.equal(apiPaths('<a href="/about">x</a>').length, 0));

console.log('\n▸ robots.txt semantics');
const emptyDisallow = r => {
  const d = [...r.matchAll(/^\s*Disallow:\s*(\S*)/gim)].map(m => m[1]);
  return d.length > 0 && d.every(x => x === '');
};
t('empty "Disallow:" reads as allow-all', () => assert.equal(emptyDisallow('User-agent: *\nDisallow:'), true));
t('"Disallow: /" does not read as allow-all', () => assert.equal(emptyDisallow('User-agent: *\nDisallow: /'), false));

console.log(`\n${fail ? '✖' : '▸'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
