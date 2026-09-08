// Unit-test recon's detection logic against fixture HTML — the network half
// can't run here, but the parsing half is what actually needs verifying.
import assert from 'node:assert/strict';
let pass=0, fail=0;
const t=(n,f)=>{try{f();pass++;console.log('  ✓ '+n)}catch(e){fail++;console.log('  ✖ '+n+'\n      '+e.message)}};

const FRAMEWORKS = [
  [/__NEXT_DATA__/, 'Next.js'], [/__NUXT__/, 'Nuxt'],
  [/window\.__INITIAL_STATE__/, 'SPA w/ initial state'],
  [/wp-content|wp-json/, 'WordPress'], [/Drupal\.settings|\/sites\/default\/files/, 'Drupal'],
  [/data-reactroot|react-dom/, 'React (client-rendered)'],
];
const detect = h => FRAMEWORKS.filter(([re])=>re.test(h)).map(([,n])=>n);

t('detects Next.js', ()=>assert.ok(detect('<script id="__NEXT_DATA__">{}</script>').includes('Next.js')));
t('detects WordPress', ()=>assert.ok(detect('<link href="/wp-content/x.css">').includes('WordPress')));
t('plain HTML matches nothing', ()=>assert.equal(detect('<html><body><h1>Jobs</h1>').length, 0));

const apiPaths = h => {
  const s=new Set();
  for (const m of h.matchAll(/["'`](\/(?:api|graphql|wp-json|jsonapi)[^"'`\s]{0,120})["'`]/gi)) s.add(m[1]);
  return [...s];
};
t('finds inline /api paths', ()=>{
  const found = apiPaths(`<script>fetch("/api/v1/jobs?page=1")</script><a href='/api/health'>`);
  assert.ok(found.includes('/api/v1/jobs?page=1'), 'missing api path: '+JSON.stringify(found));
  assert.ok(found.includes('/api/health'));
});
t('ignores non-api paths', ()=>assert.equal(apiPaths('<a href="/about">x</a>').length, 0));

const jobish = h => {
  const links=[...h.matchAll(/href=["']([^"']+)["']/gi)].map(m=>m[1]);
  const JOB_PATH=/\/[^/]*(job|vende|pune|pun[ëe]|punesim|position|vacancy|oferta|listing|shpallje|karrier)[^/]*\//i;
  return [...new Set(links.filter(x=>JOB_PATH.test(x)))];
};
t('counts SSR job links incl. Albanian slugs', ()=>{
  const html = `<a href="/job/1">a</a><a href="/jobs/2">b</a><a href="/vende-pune/3">c</a>
                <a href="/vende-te-lira-pune/4">d</a><a href="/shpallje-pune/5">e</a>
                <a href="/punë/6">f</a><a href="/karriera/7">g</a><a href="/about">no</a>`;
  const found = jobish(html);
  assert.equal(found.length, 7, 'got '+JSON.stringify(found));
});
t('SPA shell reports few links', ()=>assert.ok(jobish('<div id="root"></div>').length < 5));

// RSS parsing from the template's SHAPE 2
const tag=(b,n)=>{const m=b.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`,'i'));
  return m? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').trim() : '';};
t('RSS item extraction handles CDATA', ()=>{
  const xml=`<item><title><![CDATA[Backend Zhvillues]]></title><link>https://x.co/j/1</link><pubDate>Mon, 01 Sep 2026 00:00:00 GMT</pubDate></item>`;
  const b=xml.match(/<item>([\s\S]*?)<\/item>/i)[1];
  assert.equal(tag(b,'title'),'Backend Zhvillues');
  assert.equal(tag(b,'link'),'https://x.co/j/1');
  assert.ok(!Number.isNaN(Date.parse(tag(b,'pubDate'))));
});
console.log(`\n${fail?'✖':'▸'} ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
