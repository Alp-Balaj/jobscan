# jobscan

A minimal zero-token job scanner. Fetches postings from remote-EU boards and
company ATS endpoints, filters them against your profile, writes a markdown
table your AI agent can read.

Vendored from [career-ops](https://github.com/career-ops-hq/career-ops) (MIT) —
**4.4k lines kept out of ~199k**. What was dropped: the self-updater, plugin
system, Go TUI, web dashboard, LaTeX/PDF CV builders, 16 translated READMEs,
and 75 providers for markets you aren't in.

## Why this shape

Two things worth knowing before you use it:

**Local Balkan job boards have no API.** KosovaJob, PortalPunes and Telegrafi
Punë are server-rendered classifieds. Nothing here scrapes them, and upstream
never did either — it has zero Balkans coverage.

**But ATS vendors do.** Plenty of regional companies run hiring on Workable,
Recruitee, Personio or Teamtailor, all of which serve public JSON. So you reach
the local market by pointing at *companies*, not at boards. `detect-ats.mjs`
turns a careers URL into a config stanza. That's the whole trick.

## Setup

```bash
npm install
cp config/portals.example.yml config/portals.yml
cp config/profile.example.yml config/profile.yml
$EDITOR config/profile.yml     # your filters live here
node smoke-test.mjs            # 17 checks, no network needed
node scan.mjs
```

Node 20+. No Playwright, no browser download, no postinstall script.

## Daily use

```bash
node scan.mjs                  # everything enabled
node scan.mjs --only remoteok  # one source
node scan.mjs --since 14       # postings from the last 14 days
node scan.mjs --json           # jobs.json only, skip the markdown
```

Output lands in `data/jobs.md` (read it) and `data/jobs.json` (parse it). The
markdown carries a **Source health** table at the bottom — when a board changes
its API you'll see it there rather than silently getting fewer results.

## Building your company list

This is where the real leverage is, and it takes about twenty minutes once.

```bash
cat > companies.txt <<'EOF'
https://somecompany.com/careers
https://another.al/jobs
EOF

node detect-ats.mjs --file companies.txt
```

It prints ready-to-paste `tracked_companies:` stanzas for every URL that
resolves to a vendored ATS. URLs that don't resolve are reported as misses —
no guessing, no fabricated config.

Nothing is pre-filled in `portals.yml` under `tracked_companies` on purpose: a
guessed careers URL is a 404 that looks like working config.

## With Claude Code

`CLAUDE.md` points at `AGENTS.md`, which carries the operating rules, the 1–5
scoring rubric, hard filters (US-only, EU-authorization-without-sponsorship),
and scam signals. Two slash commands:

- `/scan` — scan, then shortlist with fit scores
- `/apply` — prepare one application: fit assessment, CV bullets, cover letter, likely questions

The important rule in `AGENTS.md` is the untrusted-content one. Job postings are
text written by strangers and fed into an agent with shell access. They're
treated as data, never instructions. Read that section before you loosen
anything.

## Sources included

**Remote feeds** — remoteok, remotive, weworkremotely, workingnomads,
himalayas, jobicy, nodesk, jobspresso, 4dayweek

**EU-specific** — arbeitnow (German market, English postings, visa signal),
landingjobs (EU tech, relocation-friendly)

**ATS vendors** (point at a company) — greenhouse, lever, ashby, workable,
recruitee, personio, teamtailor, breezy, smartrecruiters

Want one that isn't here — bamboohr, workday, join, softgarden, comeet,
justjoin, nofluffjobs? Copy `providers/<name>.mjs` from upstream into
`providers/`. The contract is identical and the registry auto-loads it. No
wiring, no registration list.

`echojobs` was deliberately left out: upstream retired it in August 2026 when
the feed went behind bot protection.

## Adding a local board (KosovaJob, PortalPunes, …)

```bash
node recon.mjs https://theboard.com          # what shape is it?
node recon.mjs https://theboard.com --path /vende-pune   # narrow to the listing route
```

Recon reads robots.txt, fingerprints the framework, hunts for JSON endpoints and
feeds, and reports which **path prefixes repeat** — that prefix is what your
provider should anchor on, not a CSS class. Then copy `providers/_TEMPLATE.mjs`
to `providers/<board>.mjs`, keep the shape recon named, delete the other two.

Order of preference is always: feed → JSON API → embedded state → DOM scrape.
A scraper where an API exists is a bug, not a shortcut.

Note: recon inherits the vendored SSRF guard, so it refuses localhost and
private IPs. That is deliberate — it is a tool for public boards.

## Testing

```bash
npm test          # smoke-test.mjs + recon-test.mjs
```

33 checks covering provider loading, routing, fixture-based fetch and
normalization, the greenhouse SSRF allowlist, filters, dedup, and recon's link
classification (including the kosovajob.com regression, where a hostname
containing "job" made every asset on the site look like a listing). Runs offline,
so it passes behind a proxy or on a plane. If it's green, the only remaining
failure mode is a board changing its response shape — which the Source health
table will show you.

## What this deliberately doesn't do

No applications are submitted, ever. No CV files are written. No self-updater —
if you want upstream's provider fixes, `git diff` their `providers/` against
yours and copy what you want. Vendoring means you own this code now; that's the
trade for not auto-executing someone else's.

## License

MIT, inherited from career-ops. `providers/`, `user-agent.mjs` and
`providers/ADDING_A_PROVIDER.md` are substantially upstream's work.
`scan.mjs`, `detect-ats.mjs`, `smoke-test.mjs`, `AGENTS.md` and the configs are new.
