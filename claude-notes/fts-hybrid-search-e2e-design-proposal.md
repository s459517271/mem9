---
title: FTS Hybrid Search E2E Design Proposal
created: 2026-03-03
updated: 2026-03-04
status: revised
scope: server + direct-mode plugins + runtime canary
revision: 3 (post-Codex Round 2 review — all blockers and concerns resolved)
---

## 1. Background

The FTS hybrid search implementation was reviewed and fixed across:

- `server` hybrid/fts fallback logic
- `opencode-plugin` direct backend fallback and totals
- `openclaw-plugin` direct backend failure signaling and auto-embed dims wiring
- `claude-plugin` direct init schema behavior for generated embedding column
- TiDB repository startup FTS index bootstrap

We now need an E2E design that verifies behavior at runtime, not only via code review and type/build checks.

## 2. Goals

1. Catch regressions in hybrid search correctness and fallback behavior.
2. Verify plugin-level integration paths (not only REST server APIs).
3. Keep PR signal deterministic and fast.
4. Keep a higher-fidelity runtime canary for OpenClaw real sessions.

## 3. Non-Goals

1. Replacing all existing CRDT E2E scripts.
2. Full UI automation of OpenClaw TUI.
3. Making remote EC2/tmux workflow a required PR gate.
4. CI wiring (out of scope for initial implementation; scripts must make CI setup straightforward).

## 4. Proposed Test Strategy

Use a 3-lane model:

1. `Lane A (Required, deterministic)`: API/backend E2E that runs locally or in CI.
2. `Lane B (Required, deterministic)`: Plugin direct-backend execution harness (OpenClaw + OpenCode backend-level testing).
3. `Lane C (Optional canary, high fidelity)`: Two OpenClaw sessions in tmux on EC2.

Decision:

- Lane A + Lane B are merge gates.
- Lane C is nightly/pre-release canary and debugging aid.

## 5. Why tmux+EC2 Is Useful But Not Required

The two-session OpenClaw test is valuable because it validates:

- real OpenClaw runtime loading
- plugin registration and lifecycle behavior
- remote network and deployment wiring

But it should remain optional because it is:

- environment-dependent
- timing-sensitive/flaky
- slower and harder to keep deterministic

Conclusion: keep tmux+EC2 canary, but do not block PRs on it.

## 6. Lane A: Server E2E (REST Black-Box)

### 6.1 Runner

- Python script in `e2e/` (same style as existing scripts).
- Talks to a running `mnemo-server` via REST.
- Uses unique workspace keys and test-specific keys per run.
- Stdlib only: `json`, `os`, `sys`, `time`, `urllib.request`, `urllib.error`.
- Follows exact pattern of `e2e/crdt-server-merge-e2e.py`: env var checks, provision workspace,
  `p(label)` / `f(label)` helpers, final exit with nonzero if FAIL > 0.

### 6.2 Response Schema Contract

Server REST search returns (ref: `server/internal/handler/memory.go:listResponse`):

```json
{
  "memories": [...],
  "total": <int>,
  "limit": <int>,
  "offset": <int>
}
```

All Lane A assertions must verify this exact shape.

### 6.3 Core Cases

1. `A1`: FTS index auto-bootstrap on startup.
- Primary assertion (no DB access required): store a memory, search with `q=<unique-word>`,
  assert HTTP 200 with valid `{memories, total, limit, offset}` shape.
- Optional assertion (requires `MNEMO_TEST_DSN`): query `INFORMATION_SCHEMA.STATISTICS` for
  `idx_fts_content` existence. Skip A1a if `MNEMO_TEST_DSN` not set.
- Separate assertions:
  - (a) Index row exists in STATISTICS (DDL executed) — conditional on `MNEMO_TEST_DSN`
  - (b) Search request returns HTTP 200 with valid shape (index usable)

2. `A2`: Embed failure fallback path.
- Since server cannot be reconfigured from the test, A2 tests the observable outcome:
  `GET /api/memories?q=<term>` returns HTTP 200, `memories` is array, `total >= 0`.
- If `MNEMO_TEST_EMBED_FAIL=1` env var is set (server started with bad embed config),
  additionally assert `total >= 1` for a pre-seeded keyword (FTS/LIKE fallback confirmed active).

3. `A3`: Zero-result query is not treated as dual-leg failure.
- Use query guaranteed to miss.
- Assert empty result with HTTP 200 and stable response shape:
  - `memories` is `[]` (not null)
  - `total` is `0`
  - `limit` matches requested value
  - `offset` is `0`

4. `A4`: Pagination contract.
- Seed 5 items with unique prefix.
- Assert `total`, `limit`, `offset`, and page content are coherent:
  - total is consistent across paginated requests
  - offset past total returns `memories == []` with HTTP 200 (not error)
  - `len(memories) <= limit`

## 7. Lane B: Direct Plugin Backend E2E

### 7.1 Runner Architecture

Two separate harnesses due to different plugin architectures:

**OpenClaw (backend-level harness)**:
- TypeScript script imports `openclaw-plugin/direct-backend.ts` and `openclaw-plugin/schema.ts`
- Tests `DirectBackend` class methods directly
- Uses `@tidbcloud/serverless` Connection (resolved from `openclaw-plugin/node_modules`)
- Invocation: `cd openclaw-plugin && npm ci && npx tsx ../e2e/fts-hybrid-openclaw-e2e.ts`

**OpenCode (backend-level harness)**:
- TypeScript script imports `opencode-plugin/src/direct-backend.ts`
- Tests `DirectBackend` class methods directly
- Uses TiDB HTTP Data API (`fetch`) — no external package beyond Node builtins
- Invocation: `cd opencode-plugin && npm ci && npx tsx ../e2e/fts-hybrid-opencode-e2e.ts`

**Module resolution note**: `npx tsx` resolves `@tidbcloud/serverless` from the imported file's
directory (`openclaw-plugin/`), which requires `npm ci` (or `npm install`) in `openclaw-plugin/` first.
For CI merge gates, always use `npm ci` (lockfile-pinned) rather than bare `npx tsx` from project root.

### 7.2 Response Schema Contracts

OpenClaw `DirectBackend.search()` returns (ref: `openclaw-plugin/types.ts:SearchResult`):
```typescript
{ data: Memory[], total: number, limit: number, offset: number }
```

OpenCode `DirectBackend.search()` returns (ref: `opencode-plugin/src/types.ts:SearchResult`):
```typescript
{ memories: Memory[], total: number, limit: number, offset: number }
```

OpenClaw tool wrappers (`memory_search.execute`) return:
```typescript
{ ok: true, data: Memory[], total: number, limit: number, offset: number }
```

**Critical**: Field name differs — `data` vs `memories`. Tests must use the correct field per plugin.
Misconfiguring this causes tests to pass vacuously (asserting on `undefined`).

### 7.3 OpenClaw Cases

1. `B1`: `autoEmbedDims` wiring.
- Setup tuple: `autoEmbedModel = "tidbcloud_free/amazon/titan-embed-text-v2"` AND
  `autoEmbedDims = 768` (non-default). Both must be set together — `autoEmbedDims` is only
  used when `autoEmbedModel` is enabled.
- Instantiate `new DirectBackend(host, user, pass, db, null, model, 768)` (7th arg = `autoEmbedDims`).
  Do NOT call `initSchema()` directly — the constructor is the pass-through path under test
  (constructor lines 117-120 route `autoEmbedDims` into `initSchema`).
- Wait for schema to be ready (call `backend.get("nonexistent-id")` to await `initialized`).
- Query `INFORMATION_SCHEMA.COLUMNS` for embedding column type.
- Assert: column type contains `768` (e.g. `vector(768)`).
- Assert: `ftsAvailable` is set (probe via `backend.search({ q: 'probe' })`).
- Requires isolated DB (`MNEMO_B1_DB_NAME`). Skip if not set.

2. `B2`: No false "both legs failed" on zero-hit query.
- Instantiate `DirectBackend` with real DB credentials, no embedder, no `autoEmbedModel`
  (keyword-only or FTS-only mode).
- Seed one memory to ensure table exists and schema is initialized.
- Call `backend.search({ q: 'uuid-guaranteed-miss-' + Date.now() })`.
- Assert result is `{ data: [], total: 0, ... }` — NOT a thrown Error.
- Assert `result.data` is an Array (not undefined).

3. `B3`: CRUD tool behavior in direct mode.
- Store → get → update → search → delete round-trip.
- Assert `result.data` is array (field is `data` NOT `memories`).
- Assert `result.total >= 1` after store.
- Assert `backend.remove(id)` returns `true`.
- Assert `backend.get(id)` returns `null` after remove.

### 7.4 OpenCode Cases

1. `B4`: FTS catch-path LIKE fallback `total` correctness.
- **Critical precondition**: construct `DirectBackend` with `autoEmbedModel: undefined`.
  Without this, `search()` routes to `autoHybridSearch()` and never enters `ftsOnlySearch()`
  where the regression lives. The test would pass vacuously otherwise.
- Requires isolated DB (`MNEMO_B4_DB_NAME`). Fail fast in CI mode if not set.
- Steps:
  1. Precheck FTS probe succeeds:
     `SELECT fts_match_word('probe', content) FROM memories LIMIT 0`
     If fails, skip B4 (cluster doesn't support FTS).
  2. Seed 3 memories with unique keyword.
  3. Drop index: `ALTER TABLE memories DROP INDEX idx_fts_content`
  4. Poll until FTS probe fails (timeout 60s, interval 2s).
  5. Run `backend.search({ q: '<unique-keyword>' })` — routes to `keywordSearch → ftsOnlySearch → LIKE catch`.
  6. Assert `result.memories.length >= 1` (LIKE finds them).
  7. Assert `result.total === result.memories.length` (the bug: total was 0 before fix).
  8. Restore: `ALTER TABLE memories ADD FULLTEXT INDEX idx_fts_content (content) WITH PARSER MULTILINGUAL ADD_COLUMNAR_REPLICA_ON_DEMAND`
  9. Poll until FTS probe succeeds (timeout 60s, interval 2s).
- **Cleanup guarantee**: wrap the entire B4 body in `try { ... } finally { await restoreIndex(); }`.
  Register idempotent signal handlers for `SIGINT`, `SIGTERM`, and `uncaughtException` that call
  `await restoreIndex(); process.exit(1)` — these handlers must await the async SQL before exiting.
  Do NOT rely on `process.on('exit', ...)` for async restore (exit handlers cannot await promises).
- DDL steps executed via a local `runSQL(url, auth, db, sql)` helper using `fetch` to TiDB HTTP API.

2. `B5`: Basic hybrid/keyword CRUD round-trip parity with OpenClaw.
- Same as B3 but for OpenCode `DirectBackend`.
- Assert `result.memories` is array (field is `memories` not `data`).

3. `B1b`: OpenCode `autoEmbedDims` wiring.
- Setup tuple: `autoEmbedModel = "tidbcloud_free/amazon/titan-embed-text-v2"` AND
  `autoEmbedDims = 512` (non-default). Both must be set together.
- After `schemaReady` resolves, query `INFORMATION_SCHEMA.COLUMNS` for embedding column type.
- Assert: column type contains `512`.
- Requires isolated DB (`MNEMO_B1B_DB_NAME`). Skip if not set.

### 7.5 Config Path Verification

Both plugins have different config mechanisms for `autoEmbedDims`:

| Plugin | Config Path | Constructor / Init call | Test Approach |
|--------|-------------|------------------------|---------------|
| OpenClaw | 7th constructor arg | `new DirectBackend(host, user, pass, db, null, model, 768)` | Instantiate backend directly; constructor routes dims to initSchema |
| OpenCode | `cfg.autoEmbedDims` (from `MnemoConfig`) | `new DirectBackend({ ..., autoEmbedModel: model, autoEmbedDims: 512 })` | Construct via config object |

B1 verifies OpenClaw path **via constructor** (not via direct `initSchema()` call — must exercise the pass-through wiring).
B1b (in Lane B OpenCode) verifies OpenCode path via `MnemoConfig`.

## 7b. Lane B-shell: Claude Plugin Schema Init

### 7b.1 Runner

- Shell script (`e2e/fts-hybrid-claude-schema.sh`)
- Sources `claude-plugin/hooks/common.sh`
- Invokes `mnemo_direct_init` function
- Uses Python3 for JSON assertions (same pattern as `crdt-e2e-tests.sh`)
- Pass/fail pattern matching `crdt-e2e-tests.sh`: `PASS=0; FAIL=0`, `pass()` / `fail()` functions.

### 7b.2 Cases

1. `B6`: Generated embedding column on fresh init.
- Set `MNEMO_AUTO_EMBED_MODEL=tidbcloud_free/amazon/titan-embed-text-v2` and `MNEMO_AUTO_EMBED_DIMS=1024`.
- Run `mnemo_direct_init`.
- Query `INFORMATION_SCHEMA.COLUMNS` for `EXTRA` of `embedding` column.
- Assert `EXTRA` contains `GENERATED`.
- Assert `MNEMO_FTS_AVAILABLE` env var is set (0 or 1, not empty).
- Requires isolated DB (`MNEMO_B6_DB_NAME`). Skip if not set.

2. `B7`: FTS index creation via claude-plugin init.
- After `mnemo_direct_init`, query `INFORMATION_SCHEMA.STATISTICS` for `idx_fts_content`.
- Assert: at least one row returned (index exists).
- Requires isolated DB (`MNEMO_B6_DB_NAME`). Skip if not set.

## 8. Lane C: OpenClaw tmux + EC2 Canary

### 8.1 Setup

- Two tmux windows/panes.
- Each pane ssh to EC2 host with running OpenClaw + mnemo plugin.
- Two OpenClaw sessions (Agent A / Agent B) on same workspace.
- Config from env: `MNEMO_EC2_HOST`, `MNEMO_EC2_KEY` (SSH key path), `MNEMO_EC2_USER` (default `ubuntu`).
- If any required env vars are unset, print usage and exit 0 (graceful skip, not a failure).

### 8.2 Canary Scenarios

1. Cross-agent visibility.
2. Same-key overwrite behavior.
3. Search recall from both agents after writes.
4. Optional near-simultaneous writes.

### 8.3 Automation Level

- Start semi-automated:
  - use tmux `send-keys`
  - capture output with `tmux capture-pane`
  - parse known success markers
- Keep a manual fallback playbook in the same note.

## 9. Mapping to Previously Fixed Findings

| Finding | Test Case | Script |
|---------|-----------|--------|
| 1. Claude generated embedding column on fresh direct init | B6 | `fts-hybrid-claude-schema.sh` |
| 2. OpenCode LIKE fallback `total` was 0 | B4 | `fts-hybrid-opencode-e2e.ts` |
| 3. OpenClaw false dual-leg failure on empty results | B2 | `fts-hybrid-openclaw-e2e.ts` |
| 4. OpenClaw `autoEmbedDims` pass-through | B1 | `fts-hybrid-openclaw-e2e.ts` |
| 5. Server embed failure fallback to keyword/FTS path | A2 | `fts-hybrid-server-e2e.py` |
| 6. Server startup auto-create FTS index | A1 + B7 | `fts-hybrid-server-e2e.py` + `fts-hybrid-claude-schema.sh` |
| 7. `kwErr`/`vecErr` correctness (zero result != dual failure) | A3 | `fts-hybrid-server-e2e.py` |

## 10. Data and Isolation Rules

1. Use unique DB/workspace keys per run: `e2e-fts-<timestamp>`.
2. Use unique memory keys per test case.
3. Never assume prior state.
4. Cleanup is best-effort; uniqueness is the primary isolation mechanism.
5. B4/B1/B1b/B6/B7 require isolated DBs via env vars (`MNEMO_B4_DB_NAME`, `MNEMO_B1_DB_NAME`,
   `MNEMO_B1B_DB_NAME`, `MNEMO_B6_DB_NAME`).
   - Local dev: skip with SKIP signal (exit 0) if env var absent.
   - CI (`MNEMO_E2E_STRICT=1`): fail fast (exit 1) if env var absent — missing isolation DB is a
     misconfiguration, not a graceful skip.
6. B4 always restores the FTS index on exit — use `try/finally` around B4 body plus idempotent
   `SIGINT`/`SIGTERM`/`uncaughtException` handlers that await the async restore SQL before calling
   `process.exit()`. Do NOT rely on `process.on('exit', ...)` — exit callbacks cannot await promises.

## 11. Execution Plan

### 11.1 Add Scripts

1. `e2e/fts-hybrid-server-e2e.py` (Lane A)
2. `e2e/fts-hybrid-openclaw-e2e.ts` (Lane B - OpenClaw backend-level)
3. `e2e/fts-hybrid-opencode-e2e.ts` (Lane B - OpenCode backend-level)
4. `e2e/fts-hybrid-claude-schema.sh` (Lane B-shell)
5. `e2e/fts-hybrid-openclaw-tmux-canary.sh` (Lane C, optional)
6. `e2e/run-fts-hybrid.sh` (or Make target) as single entrypoint

### 11.2 Dependencies and Runner Commands

**Lane A (Python)**:
```bash
# No pip dependencies (stdlib only)
python3 e2e/fts-hybrid-server-e2e.py
```

**Lane B (TypeScript)**:
```bash
# Lockfile-pinned invocation (required for CI merge gates):
cd openclaw-plugin && npm ci && npx tsx ../e2e/fts-hybrid-openclaw-e2e.ts
cd opencode-plugin && npm ci && npx tsx ../e2e/fts-hybrid-opencode-e2e.ts

# Quick local run (acceptable outside CI if node_modules already present):
npx --prefix openclaw-plugin tsx e2e/fts-hybrid-openclaw-e2e.ts
npx tsx e2e/fts-hybrid-opencode-e2e.ts
```

**Lane B-shell**:
```bash
bash e2e/fts-hybrid-claude-schema.sh
```

**Why TypeScript for Lane B**:
- OpenClaw backend testing imports `DirectBackend` and `initSchema` from TS source directly
- OpenCode backend testing imports `DirectBackend` class directly
- Python would require HTTP calls to TiDB Data API (already covered by Lane A pattern)
- In-process testing catches type errors and import issues that HTTP tests miss

**Why lockfile-pinned for CI**:
- `npx tsx` without lockfile fetches latest `tsx` at runtime (version drift, non-deterministic)
- `npm ci` from each plugin directory uses `package-lock.json`, ensuring reproducible execution

### 11.3 CI/Runtime Policy

1. PR required (merge gates):
- Lane A + Lane B + Lane B-shell

2. Nightly / release:
- Lane A + Lane B + Lane B-shell + Lane C

3. Skip policy:
- **Local dev mode** (default): missing isolated DB env vars (`MNEMO_B4_DB_NAME` etc.) emit SKIP (exit 0).
- **CI required mode** (`MNEMO_E2E_STRICT=1`): missing isolated DB env vars cause fail-fast (exit 1)
  with a clear error message. This prevents false-green merges where findings 1/2/4 are silently
  uncovered because the isolation DBs were not configured.
- Lane C emits SKIP (exit 0) in both modes if `MNEMO_EC2_HOST` not set.
- `run-fts-hybrid.sh` prints summary of SKIPs alongside PASS/FAIL counts.

## 12. Acceptance Criteria

1. All Lane A, Lane B, and Lane B-shell tests pass in clean environment.
2. Reproduces and prevents regression for all 7 original findings.
3. Failures provide actionable diagnostics (test name, request, observed result).
4. Lane C canary runs successfully in staging at least once per day.
5. B4 never leaves staging DB without FTS index (cleanup always runs).
6. All scripts emit SKIP (exit 0) in local dev mode when optional env vars are absent.
   In CI mode (`MNEMO_E2E_STRICT=1`), scripts fail fast on missing required isolation DBs.

## 13. Risks and Mitigations

1. TiDB FTS provisioning latency.
- Mitigation: A1 uses explicit poll strategy (60s timeout, 2s interval).
- Separate assertions for "index exists" vs "index usable".

2. Remote session flakiness in tmux canary.
- Mitigation: keep canary non-blocking for PR merges.

3. External embedding provider instability.
- Mitigation: embed-failure tests should intentionally use controlled invalid endpoint, not random provider outages.

4. FTS index drop timing (B4).
- Mitigation: for staging, B4 always uses drop + poll + restore.
- Poll until `fts_match_word` fails after DROP (60s timeout, 2s interval), then poll until probe
  succeeds after index re-create.
- Do not rely on immediate DROP/ADD behavior.
- Cleanup guarantee: `try/finally` around B4 body + `SIGINT`/`SIGTERM`/`uncaughtException` handlers
  that await async restore SQL before exiting. `process.on('exit')` is NOT sufficient (cannot await).

5. B4 `autoEmbedModel` misconfiguration (vacuous pass).
- Mitigation: B4 setup explicitly requires `autoEmbedModel: undefined`. Enforced in test preconditions.
- Without this, `search()` routes to `autoHybridSearch()` and the `ftsOnlySearch` LIKE catch-path
  (the regression site) is never exercised.

6. `npx tsx` version drift in CI.
- Mitigation: CI must use `npm ci` (lockfile-pinned) from plugin directory, not bare `npx tsx`.
- Documented in Section 11.2.

## 14. Environment Variables Reference

| Var | Required By | Description |
|-----|-------------|-------------|
| `MNEMO_TEST_BASE` | Lane A | mnemo-server URL (default: `http://127.0.0.1:18081`) |
| `MNEMO_TEST_USER_TOKEN` | Lane A | User token for server API |
| `MNEMO_TEST_EMBED_FAIL` | Lane A (A2) | Set to `1` if server was started with bad embed config |
| `MNEMO_TEST_DSN` | Lane A (A1a) | Optional: direct DB access for DDL assertion |
| `MNEMO_E2E_STRICT` | All lanes | Set to `1` for CI mode: missing isolation DBs cause fail-fast instead of SKIP |
| `MNEMO_DB_HOST` | Lane B + B-shell | TiDB Serverless host |
| `MNEMO_DB_USER` | Lane B + B-shell | TiDB username |
| `MNEMO_DB_PASS` | Lane B + B-shell | TiDB password |
| `MNEMO_DB_NAME` | Lane B + B-shell | Database name (default: `mnemos`) |
| `MNEMO_AUTO_EMBED_MODEL` | Lane B (B1), B-shell (B6) | Auto-embed model for VECTOR column test |
| `MNEMO_B1_DB_NAME` | Lane B OpenClaw (B1) | Isolated DB for autoEmbedDims wiring test |
| `MNEMO_B4_DB_NAME` | Lane B OpenCode (B4) | Isolated DB for FTS drop+restore test |
| `MNEMO_B1B_DB_NAME` | Lane B OpenCode (B1b) | Isolated DB for OpenCode autoEmbedDims test |
| `MNEMO_B6_DB_NAME` | Lane B-shell (B6/B7) | Isolated DB for claude-plugin schema test |
| `MNEMO_EC2_HOST` | Lane C | EC2 hostname for tmux canary |
| `MNEMO_EC2_KEY` | Lane C | SSH key path |
| `MNEMO_EC2_USER` | Lane C | SSH user (default: `ubuntu`) |

## 15. Rollout

1. Phase 1 (this week): implement Lane A + B scripts and run locally.
2. Phase 2: wire Lane A + B + B-shell into CI required checks.
3. Phase 3: add Lane C nightly canary in staging and collect stability metrics.
