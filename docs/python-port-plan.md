# Python port — implementation plan

Status: **agreed, not started** (decided 2026-10-16 in a grilling session).
Branch: `python-port`. Merge to `main` only on Alp's say-so.

This plan is built for **parallel implementation**. Phase 0 freezes every
contract between components; after it lands, the Wave 1 tracks own disjoint
files and can run simultaneously (one agent / worktree each). Wave 2 wires
them together.

```
Phase 0 (serial)  ──►  Wave 1 (parallel: A B1 B2 B3 C D E F G)  ──►  Wave 2 (I1 → I2 → I3)
skeleton+contracts      kernel, providers, pipeline, recon,          wire-up, parity + delete JS,
                        storage, AI, GUI                             docs + commands
```

---

## 1. Settled decisions (do not re-litigate)

| Area | Decision |
|---|---|
| Strategy | Full Python rewrite in place. JS deleted only after the parity run (I2) is clean. |
| UI | Local web UI, **NiceGUI**, bound to `127.0.0.1` only. |
| AI | **Claude via the `anthropic` SDK**. Model ids in config, never hard-coded in logic. |
| AI scope v1 | Deep score (shortlisted jobs only) + drafting. **No** bulk triage, chat, or AI source onboarding. |
| AI safety | Model gets **no tools**. Posting text goes in delimited data blocks; output is structured JSON; nothing the model emits is executed or fetched. AI-directed text in a posting is a scam flag. |
| Scanner | Stays zero-token. Deterministic filters in `profile.yml` run first. |
| Users / platforms | Alp only, local, multiple devices, **Windows + Linux**. |
| Persistence | SQLite. |
| Multi-device | All personal state lives in one **data dir** (`JOBSCAN_HOME`, default `~/jobscan-data`) that Alp syncs (Syncthing/OneDrive/etc). A **lock file** prevents two devices writing at once; the second opens read-only. |
| Git | Only code and `*.example` files. Personal config never enters git. |
| API key | `ANTHROPIC_API_KEY` from env or gitignored `.env`. Never stored in SQLite. Missing key → UI shows "AI disabled", app still works. |
| Cost | Cache AI results by (content hash, prompt version, model); show tokens + $ per action; soft monthly cap with confirmation. |
| Scan trigger | "Scan now" button + `jobscan scan` CLI. No scheduler in v1. |
| Tooling | `uv`, `pyproject.toml`, `requires-python >=3.12`, `ruff`, `pytest`. |
| Provider contract | Same shape as JS, idiomatic Python (see §3.2). Auto-loaded registry, `_`-prefixed files skipped. |
| SSRF guard | Kept. DNS cache dropped. Connect to the IP that was checked (no rebinding window). |
| CV | One-time PDF → `cv.md` import via Claude, Alp corrects it, `cv.md` is the source of truth thereafter. |
| Shortlisting | Manual, in the UI. AI scoring offered only on shortlisted jobs. |
| Statuses | `new → shortlisted → scored → drafting → applied → interviewing → offer / rejected`, plus `dismissed` (sticky across rescans). Vanished jobs kept, flagged "no longer listed". |
| Drafts | Four panels (fit, CV bullets, cover letter ≤200 words, interview Qs), each editable / copyable / regenerable; saved as Markdown in the data dir. No docx/PDF export in v1. |
| Language | Match the posting's language, overridable per draft. |
| Settings UI | `portals.yml` editable in UI (add via careers URL → detect-ats; toggle on/off). `profile.yml` stays hand-edited, shown read-only. |
| Score output | tier used, score 1–5 (tier-capped), hard filter tripped, scam flags, reasons, gaps, timezone-overlap note. |
| Claude Code | `/scan` and `/apply` kept, repointed at the Python CLI. `AGENTS.md` updated. |

### Non-goals for v1
Bulk AI triage · chat · scheduled scans · docx/PDF export · editing `profile.yml` in the UI · HTTP response caching · DNS cache · new providers.

---

## 2. Target layout

```
pyproject.toml            deps, [project.scripts] jobscan = "jobscan.cli:main"
.env.example              ANTHROPIC_API_KEY=, JOBSCAN_HOME=
jobscan/
  __init__.py
  cli.py                  argparse entrypoint: scan | recon | detect-ats | ui | cv-import | paths
  paths.py                data-dir resolution (JOBSCAN_HOME)            [Phase 0]
  config.py               load/save portals.yml, load profile.yml       [Phase 0 stub → C]
  models.py               Job, Salary, PortalEntry, ScanStat, …         [Phase 0, frozen]
  lock.py                 device lock                                    [E]
  pipeline/
    filters.py            keep(job, filters, since)                      [C]
    dedup.py              dedup_key(job, provider)                       [C]
    scan.py               run_scan(...) -> ScanResult                    [C]
    report.py             jobs.md / jobs.json writers                    [C]
  net/
    errors.py             HttpError, RefusedRedirectError, BlockedAddressError  [Phase 0]
    context.py            HttpContext protocol                           [Phase 0]
    guard.py              is_blocked_address + guarded network backend   [A]
    http.py               make_http_context(), retry helpers             [A]
  providers/
    __init__.py
    _registry.py          load_providers, resolve_provider               [Phase 0]
    _html.py              html_to_text, decode_entities (port of _html-*.mjs) [Phase 0]
    _feed.py              RSS/Atom item extraction                       [B3]
    _TEMPLATE.py, ADDING_A_PROVIDER.md                                   [B1]
    <one module per provider>                                            [B1 B2 B3]
  recon.py, detect_ats.py                                                [D]
  store/
    schema.sql, store.py  Store class                                    [E]
  ai/
    schemas.py            ScoreResult, DraftPart, … (pydantic)           [Phase 0, frozen]
    service.py            AIService protocol + real impl                 [Phase 0 protocol → F]
    prompts/              versioned prompt templates                     [F]
    jd.py                 fetch_jd(url) → text                           [F]
    cost.py               pricing, spend accounting                      [F]
  ui/
    app.py, pages/…       NiceGUI                                        [G]
tests/
  fakes.py                FakeHttpContext, FakeStore, FakeAIService      [Phase 0]
  test_<track>_*.py       each track owns its own test files
config/*.example.yml      unchanged content; copied into data dir on first run
```

Python module names can't start with a digit: `4dayweek` lives in
`providers/fourdayweek.py` with `ID = "4dayweek"`.

---

## 3. Phase 0 — skeleton and frozen contracts (serial, one agent)

Everything another track imports is defined here. After Phase 0 merges, these
signatures change only by explicit agreement — a track that needs a change
says so in its PR instead of editing the contract unilaterally.

### 3.1 Tooling
- `uv init`-style `pyproject.toml`, **all** runtime + dev deps declared up front
  so no Wave 1 track touches it:
  - runtime: `httpx`, `ruamel.yaml` (round-trips comments — needed because the UI
    edits `portals.yml`), `nicegui`, `anthropic`, `pydantic`, `python-dotenv`
  - dev: `pytest`, `pytest-asyncio`, `respx`, `ruff`
- `ruff` config, `pytest` config (`asyncio_mode = "auto"`).
- `.gitignore`: add `.venv/`, `__pycache__/`, `.env`, `*.db`.
- CI-equivalent local check: `uv run ruff check && uv run pytest`.

### 3.2 Contracts

```python
# jobscan/models.py
@dataclass(slots=True)
class Salary:
    min: float | None = None
    max: float | None = None
    currency: str = ""

@dataclass(slots=True)
class Job:
    title: str
    url: str
    company: str = ""
    location: str = ""
    description: str = ""            # capped at 4000 chars by the pipeline
    posted_at: datetime | None = None  # tz-aware UTC
    salary: Salary | None = None
    source: str = ""                 # provider ID, set by the pipeline

PortalEntry = Mapping[str, Any]      # opaque, like JS; providers validate their own keys

@dataclass(slots=True)
class DetectHit: url: str

@dataclass(slots=True)
class ScanStat:
    name: str
    status: Literal["ok", "fail", "error", "unrouted"]
    count: int = 0
    raw: int = 0
    ms: int = 0
    error: str | None = None

@dataclass(slots=True)
class ScanResult:
    scanned_at: datetime
    stats: list[ScanStat]
    jobs: list[tuple[str, Job]]      # (dedup_key, job), sorted posted_at desc, company asc
```

```python
# jobscan/net/context.py
class HttpContext(Protocol):
    max_pages: int | None
    async def fetch_text(self, url: str, *, timeout: float = 10, headers: dict | None = None,
                         method: str = "GET", body: str | bytes | None = None) -> str: ...
    async def fetch_json(self, url: str, **kw) -> Any: ...
    async def fetch_text_head(self, url: str, *, max_bytes: int = 8192, **kw) -> str: ...
    async def fetch_response(self, url: str, **kw) -> httpx.Response: ...
    async def sleep(self, seconds: float) -> None: ...
```
Semantics carried over from `_http.mjs`: redirects are **refused** (raise
`RefusedRedirectError` carrying `location`), non-2xx raises `HttpError(status,
body, retry_after, location)`, the timeout covers the body read.

```python
# provider module contract (providers/<name>.py)
ID: str
async def fetch(entry: PortalEntry, ctx: HttpContext) -> list[Job]: ...
def detect(entry: PortalEntry) -> DetectHit | None: ...        # optional
def dedup_key(job: Job) -> str | None: ...                     # optional
```

```python
# jobscan/providers/_registry.py   (port of _registry.mjs, implemented in Phase 0)
def load_providers() -> dict[str, ModuleType]       # alphabetical, skips _-prefixed, validates ID + fetch
def resolve_provider(entry, providers, *, skip_ids=()) -> ModuleType | ResolveError | None
    # explicit `provider:` wins; unknown id → ResolveError; else first detect() hit, alphabetical
```

```python
# jobscan/store/store.py — protocol frozen in Phase 0, implemented by E
class Status(StrEnum): NEW, SHORTLISTED, SCORED, DRAFTING, APPLIED, INTERVIEWING, OFFER, REJECTED, DISMISSED

@dataclass
class JobRow:  id: int; key: str; job: Job; status: Status; first_seen: datetime;
               last_seen: datetime; listed: bool; notes: str

class StoreProtocol(Protocol):
    def ingest_scan(self, result: ScanResult) -> IngestSummary: ...   # new / updated / vanished counts
    def list_jobs(self, q: JobQuery) -> list[JobRow]: ...              # filters: status, source, family, since, text
    def get_job(self, job_id: int) -> JobRow | None: ...
    def set_status(self, job_id: int, status: Status) -> None: ...
    def set_notes(self, job_id: int, notes: str) -> None: ...
    def cached_ai(self, kind: str, content_hash: str, prompt_version: str, model: str) -> dict | None: ...
    def save_ai(self, job_id: int, kind: str, content_hash: str, prompt_version: str,
                model: str, payload: dict, usage: Usage) -> None: ...
    def latest_ai(self, job_id: int, kind: str) -> dict | None: ...
    def month_spend_usd(self, month: date) -> float: ...
    def last_scan_stats(self) -> list[ScanStat]: ...
```

```python
# jobscan/ai/schemas.py (pydantic) — frozen in Phase 0
class ScoreResult(BaseModel):
    tier: int                      # 1–4 from profile context
    tier_reason: str
    score: int                     # 1–5, must be <= tier cap
    hard_filter: str | None        # which hard filter tripped, if any
    scam_flags: list[str]
    reasons: list[str]             # 2–4
    gaps: list[str]
    timezone_overlap: str
    language: str                  # detected posting language, e.g. "en", "de"

class DraftKind(StrEnum): FIT, BULLETS, COVER_LETTER, QUESTIONS
class DraftPart(BaseModel): kind: DraftKind; language: str; markdown: str
class Usage(BaseModel): model: str; input_tokens: int; output_tokens: int; usd: float

# jobscan/ai/service.py
class AIService(Protocol):
    enabled: bool                                   # False when no API key
    async def score(self, job: JobRow, *, force: bool = False) -> tuple[ScoreResult, Usage | None]: ...
    async def draft(self, job: JobRow, kind: DraftKind, *, language: str | None = None,
                    force: bool = False) -> tuple[DraftPart, Usage | None]: ...
    async def import_cv(self, pdf: Path) -> str: ...  # returns markdown for Alp to review
    def would_exceed_cap(self) -> bool: ...
```
`Usage is None` means "served from cache, $0".

### 3.3 Also in Phase 0
- `paths.py`: `data_dir()` from `JOBSCAN_HOME` or `~/jobscan-data`; helpers for
  `portals.yml`, `profile.yml`, `cv.md`, `jobscan.db`, `drafts/`, `jobs.md`,
  `jobs.json`, `.lock`. First run copies `config/*.example.yml` into the data dir.
- `providers/_html.py`: faithful port of `_html-to-text.mjs` + `_html-entities.mjs`
  **with their behaviour tests** (pure functions every provider needs).
- `tests/fakes.py`:
  - `FakeHttpContext(routes: dict[str, str | dict | Exception])` — maps URL →
    body/JSON/raised error; records calls; instant `sleep`.
  - `FakeStore` (in-memory), `FakeAIService` (canned results, `enabled` toggle).
- `cli.py` with subcommands wired to `NotImplementedError` stubs.

**Done when:** `uv sync && uv run pytest` passes on Windows and Linux (WSL is
fine for the Linux check); registry loads an empty provider set; fakes importable.

---

## 4. Wave 1 — parallel tracks

Each track: branch from `python-port` after Phase 0, own **only** the files
listed, write tests against the fakes, open a PR back to `python-port`.
Every track reads the corresponding `.mjs` source as the behavioural spec.

### Track A — HTTP kernel + SSRF guard
**Owns:** `jobscan/net/guard.py`, `jobscan/net/http.py`, `tests/test_net_*.py`
**Spec:** `providers/_http.mjs`, `providers/_ip-guard.mjs`, `user-agent.mjs`

- `make_http_context(*, user_agent=DEFAULT_UA, max_pages=None) -> HttpContext`
  over one shared `httpx.AsyncClient(follow_redirects=False, trust_env=False)`.
  `trust_env=False` so a proxy env var can't route around the guard.
- Guard: a custom **httpcore network backend** whose `connect_tcp(host, port)`
  resolves with `getaddrinfo`, rejects blocked addresses, and connects to the
  **checked IP**. TLS SNI/cert verification still use the original hostname
  (httpcore passes it separately), so HTTPS stays correct and there is no
  DNS-rebinding window.
- `is_blocked_address`: port the JS list exactly, plus: unwrap IPv4-mapped IPv6,
  `100.64.0.0/10` (CGNAT — also covers Tailscale), cloud metadata v4/v6.
- Retry helpers: `fetch_json_with_retry(ctx, url, policy=RetryPolicy())` /
  `fetch_text_with_retry` — 2 retries, 0.5 s base, 8 s max, exponential + 0.25 s
  jitter, honour `Retry-After` (capped 4× max), retry on 429/5xx/network, never
  on refused redirect. `parse_retry_after`, `is_retryable_error`.
- `fetch_text_head`: streamed read capped at `max_bytes`.

**Tests:** blocked-address table (port JS cases); guard rejects a hostname
resolving to 127.0.0.1 / 10.x / 169.254.169.254 (monkeypatch resolver); redirect
refused with `location`; retry timing with injected sleep; Retry-After parsing;
head cap. Use `respx` where the guard isn't under test.

### Track B1 — job-board JSON providers (+ template)
**Owns:** `providers/{remoteok,remotive,workingnomads,himalayas,jobicy,arbeitnow,landingjobs,fourdayweek}.py`,
`providers/_TEMPLATE.py`, `providers/ADDING_A_PROVIDER.md`, `tests/test_providers_boards.py`

### Track B2 — ATS JSON providers
**Owns:** `providers/{greenhouse,lever,ashby,breezy,recruitee,smartrecruiters,workable}.py`,
`tests/test_providers_ats.py`
Includes each `detect()` and any `dedup_key()`; host allowlists + HTTPS-only
checks ported verbatim.

### Track B3 — RSS/feed providers
**Owns:** `providers/_feed.py`, `providers/{weworkremotely,nodesk,jobspresso,teamtailor,personio}.py`,
`tests/test_providers_feeds.py`
`_feed.py` ports the regex item/tag extraction. Do **not** switch to an XML
parser in this port — behaviour parity first; a parser swap is a later change.

**All B tracks:**
- Rule: one-to-one port of the `.mjs` mapping logic, including every guard
  (allowlisted hosts, HTTPS-only, skip metadata rows, description via
  `_html.html_to_text`, salary only when the source states it).
- Each provider has ≥1 test with a recorded-shape fixture through
  `FakeHttpContext`: happy path, plus each guard the JS has.
- Port the existing smoke-test assertions for that provider (remoteok metadata
  row; greenhouse `absolute_url`, host rejection, http rejection).
- Checklist: the 20 non-`_` modules in `providers/` — if a count differs from the
  JS folder, the JS folder is the truth.

### Track C — scan pipeline, config, reports, scan CLI
**Owns:** `jobscan/config.py`, `jobscan/pipeline/*`, `cli.py` `scan` + `paths`
subcommands, `tests/test_pipeline_*.py`
**Spec:** `scan.mjs`

- `config.py`: load `portals.yml` / `profile.yml` (ruamel), `--profile name`
  variants (`profile.<name>.yml`, name `^[a-z0-9-]+$`); `save_portals()`
  preserving comments; `set_entry_enabled(name, bool)`; `add_entry(stanza)`.
- `filters.keep()`: identical semantics — case-insensitive substring
  `title_include` / `title_exclude`, `exclude` over title+location+description,
  `location_include` with the remote regex bypass, `--since`.
- `dedup.dedup_key()`: provider `dedup_key` → `f"{ID}:{k}"`, else URL
  normalisation (drop hash, `utm_*|ref|source|gh_src|lever-*|src`, trailing
  slashes, lowercase), else `company|title`. **Must produce byte-identical keys
  to the JS** — the store and the parity run depend on it.
- `scan.run_scan(entries, providers, ctx, *, concurrency=5, filters, since, progress=None) -> ScanResult`
  — asyncio semaphore pool; normalisation as in `scan.mjs`; per-source
  `ScanStat`; optional `progress(stat)` callback (the GUI uses it).
- `report.py`: `jobs.md` + `jobs.json` in the data dir, same columns/format.
- CLI `jobscan scan [--only] [--since N] [--json] [--concurrency N] [--profile name]`
  — writes reports **and**, if a store is passed in (wired in I1), ingests.
- Port the smoke tests: provider loading, routing (5 cases), filters (4), dedup (3).

### Track D — recon + detect-ats
**Owns:** `jobscan/recon.py`, `jobscan/detect_ats.py`, `cli.py` `recon` +
`detect-ats` subcommands, `tests/test_recon*.py`, `tests/test_detect_ats.py`
**Spec:** `recon.mjs`, `detect-ats.mjs`, `recon-test.mjs`, `tests-recon.mjs`
- Same probe order and verdicts (robots.txt Disallow/Sitemap → JSON API → feed →
  SSR vs SPA). Robots `Disallow: /` is reported as a stop, never bypassed.
- `detect_ats` returns structured hits (used by the Sources page) **and** prints
  the YAML stanza for the CLI.
- Port all ~24 recon tests, including the kosovajob.com job-link regression.

### Track E — storage + device lock
**Owns:** `jobscan/store/*`, `jobscan/lock.py`, `tests/test_store*.py`, `tests/test_lock.py`

- SQLite with **`journal_mode=DELETE`** (not WAL — sync tools mishandle the
  `-wal`/`-shm` sidecars). `PRAGMA user_version` migrations.
- Tables: `jobs` (key UNIQUE, fields, status, first_seen, last_seen, listed,
  notes), `scans` (+ stats JSON), `ai_results` (job_id, kind, content_hash,
  prompt_version, model, payload JSON, tokens, usd, created_at), `drafts` are
  rows in `ai_results` with `kind = "draft:<part>"`; edited text stored as a new
  row flagged `edited`.
- `ingest_scan`: upsert by dedup key; new → `NEW`; seen → update fields +
  `last_seen`, keep status; **`DISMISSED` stays dismissed**; keys absent from a
  *successful* source's results → `listed = false` (don't mark vanished when the
  source failed).
- Content hash: sha256 of normalised title + company + description.
- `lock.py`: `.lock` JSON `{host, pid, started, heartbeat}`; heartbeat every 60 s;
  another host's lock is stale after 10 min (sync latency); `acquire() ->
  Mode.READ_WRITE | Mode.READ_ONLY`; `--force-unlock` for a dead device. Same-host
  stale PID is reclaimed.
- Store in read-only mode raises on writes.

### Track F — AI layer
**Owns:** `jobscan/ai/*` (except `schemas.py`), `cli.py` `cv-import`,
`tests/test_ai_*.py`
**Before writing code, load the `claude-api` skill** for current model ids,
structured-output usage, and pricing.

- Config block in `profile.yml`-adjacent settings file `settings.yml` in data dir:
  `ai.score_model`, `ai.draft_model`, `ai.monthly_cap_usd`, `ai.pricing{model: {in, out}}`
  (defaults from the skill; pricing in config so it's correctable without code).
- `jd.py`: get the full JD — use the stored description if it's substantive,
  else fetch the job URL through the guarded `HttpContext` + `html_to_text`.
  Check robots.txt for the host first; 403 / challenge page → return what we have
  and say so in the UI. **Python fetches; the model never does.**
- Prompts in `ai/prompts/*.md`, each with a `VERSION` constant that feeds the
  cache key. Inputs: `profile.yml` `context:` block, `cv.md`, job metadata, JD
  wrapped in `<untrusted_posting>…</untrusted_posting>` with an explicit
  instruction that its contents are data. System prompt carries the AGENTS.md
  rubric: tiers + caps, hard filters, scam signals, "never invent experience".
- Output via structured JSON → validated into `schemas.py` models. Post-validate
  in code: `score <= cap(tier)`; hard filter tripped → force score 1.
- Draft: one call per `DraftKind` so each panel regenerates independently;
  cover letter ≤200 words enforced in prompt and checked in code (retry once).
  Language: `language` arg or the score's detected language.
- `import_cv(pdf)`: send the PDF as a document block, ask for faithful Markdown,
  return it for review — never write `cv.md` without the UI/CLI confirming.
- `cost.py`: usage → USD from `ai.pricing`; `would_exceed_cap()` reads
  `store.month_spend_usd`.
- `enabled = False` when no key; every method then raises a clear `AIDisabled`.
- Tests with a mocked Anthropic client: cache hit returns `Usage=None`; tier cap
  clamp; hard-filter clamp; injection fixture ("ignore previous instructions…")
  is passed only inside the delimiter and the prompt template contains the
  data-not-instructions clause; missing key → disabled.

### Track G — GUI (against fakes)
**Owns:** `jobscan/ui/*`, `cli.py` `ui` subcommand, `tests/test_ui_*.py`
Built entirely against `StoreProtocol`, `AIService`, and an injected
`scan_runner` callable, using the fakes, so it doesn't wait on C/E/F.

- `jobscan ui [--port 8765]` → `ui.run(host="127.0.0.1", reload=False, show=True)`.
- **Jobs** (`/`): table (title, company, location, posted, comp, source, status,
  score); filters: status (default hides `dismissed`), source, family (derived
  from which `title_include` group matched), date, text; bulk shortlist / dismiss;
  "Scan now" → background task with per-source progress, then refresh; source
  health panel from `last_scan_stats`.
- **Job detail** (`/job/{id}`): metadata, JD text, status selector, notes;
  **Score** panel (button disabled unless shortlisted+; shows tier, score, flags,
  reasons, gaps, tz overlap, cost/"cached"); **Draft** — four panels, each with
  generate / regenerate / edit / copy, language dropdown, cost line; cap
  exceeded → confirmation dialog.
- **Sources** (`/sources`): list portals entries with enable toggles; "Add from
  careers URL" → `detect_ats` → preview stanza → save.
- **Settings** (`/settings`): data-dir path, lock status, AI enabled?, month
  spend vs cap, `profile.yml` read-only view, CV import (upload PDF → review
  Markdown → save `cv.md`).
- Read-only mode (lock held elsewhere): banner + all mutating controls disabled.
- Long work runs off the event loop (`background_tasks` / `run.io_bound`).
- Tests: NiceGUI `User` fixture smoke tests per page against fakes.

---

## 5. Wave 2 — integration (serial)

### I1 — Wire-up
`cli.py` composition root: resolve data dir → acquire lock → real `Store`,
`make_http_context`, real `AIService` → `ui` / `scan` get real deps. `jobscan
scan` ingests into the store. End-to-end test: `FakeHttpContext`-backed scan →
store → jobs page lists rows.

### I2 — Parity run, then delete JS
1. Port is complete when `uv run pytest` covers every ported JS test.
2. With the same `portals.yml` + `profile.yml`, run back-to-back:
   `node scan.mjs --json` and `jobscan scan --json`.
3. Diff the **dedup-key sets** and per-source counts (script in `tests/parity/`).
   Every differing key gets an explanation (listing changed between runs is
   acceptable only if re-running shrinks it). Commit the diff report.
4. In the **same commit** as the clean report: delete all `.mjs`, `package.json`,
   `package-lock.json`, `node_modules/`, update `.gitignore`.

### I3 — Docs and Claude Code integration
- `README.md`: install uv → `uv sync` → `jobscan paths` → set up sync folder →
  `jobscan ui`. Windows and Linux.
- `AGENTS.md`: new repo map, `jobscan scan` instead of `node scan.mjs`, outputs in
  the data dir (`jobscan paths`), untrusted-content rules unchanged.
- `.claude/commands/scan.md` / `apply.md`: Python CLI + data-dir paths.
- `providers/ADDING_A_PROVIDER.md` already ported in B1; link it.

---

## 6. Running the tracks in parallel

- After Phase 0 merges: one git worktree per track
  (`git worktree add ../jobscan-<track> -b port/<track> python-port`).
- Tracks touch disjoint files; the only shared file is `cli.py`, where each
  track fills in **only its own subcommand function** (Phase 0 creates one stub
  function per subcommand to keep merges trivial).
- Merge order inside Wave 1 doesn't matter; A before I1 matters only because I1
  needs the real context.
- Agent brief template:

  > Implement **Track X** of `docs/python-port-plan.md`. Read §1 and §3 first —
  > the contracts are frozen. Own only the files listed for your track. Use the
  > referenced `.mjs` files as the behavioural spec. Tests against `tests/fakes.py`.
  > `uv run ruff check && uv run pytest` must pass. If a contract is wrong,
  > stop and report instead of changing it.

## 7. Definition of done (whole port)
- `uv sync && uv run pytest` green on Windows and Linux.
- Parity report committed; JS removed.
- `jobscan ui` on a fresh device with only `JOBSCAN_HOME` pointing at the synced
  folder shows the same jobs, statuses, scores and drafts as the other device.
- Second device opening concurrently gets read-only mode.
- With no API key, everything except Score/Draft/CV import works.
- `/scan` and `/apply` work against the Python CLI.
