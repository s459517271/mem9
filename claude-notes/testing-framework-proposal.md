---
title: mnemos Testing Framework Proposal
created: 2026-03-04
updated: 2026-03-04
status: final
reviewed-by: Codex (gpt-5.3-codex) via tmux IPC — two rounds, AGREE reached
---

## 1. Current State

Zero unit tests exist anywhere in the repo. The complete test inventory today:

| Layer | Files | Status |
|-------|-------|--------|
| Go server (`server/internal/`) | 7 packages, ~2500 LoC | **Zero tests** |
| opencode-plugin TypeScript | 6 source files | **Zero tests** |
| openclaw-plugin TypeScript | 7 source files | **Zero tests** |
| claude-plugin bash hooks | 4 hook scripts, `common.sh` | **Zero tests** |
| E2E (`e2e/`) | 9 scripts, ~50 cases | Exists, live-DB only |

The Makefile has no `test` target. `go test` is never invoked. The CI workflow
(`e2e.yml`) is opt-in via repository variable `MNEMO_E2E_ENABLED` — PRs can
merge with zero tests running if the variable is not set.

---

## 2. Goals

1. Catch pure-logic regressions (CRDT clocks, RRF merge, section merge) without
   needing a live database.
2. Verify HTTP contract (request parsing, response shape, auth) without a live
   database.
3. Test plugin logic (clock increment, config loading, tool responses) without a
   live database.
4. Keep E2E tests for what only runtime can prove: FTS index creation, vector
   search correctness, multi-agent race conditions.
5. Add a zero-dependency, always-on CI job for unit tests that blocks every PR
   regardless of `MNEMO_E2E_ENABLED`.

---

## 3. Non-Goals

- Full coverage of `repository/tidb/` SQL — stays E2E only (needs live TiDB).
- Testing `opencode-plugin/src/hooks.ts` OpenCode lifecycle integration — needs
  full OpenCode runtime.
- Replacing E2E with unit tests — the two layers are complementary.

---

## 4. Proposed 4-Layer Framework

```
Layer 1: Go unit tests     (service/, middleware/, domain/)
Layer 2: Go handler tests  (handler/ via httptest)
Layer 3: TypeScript tests  (plugin logic via vitest)
Layer 4: E2E              (existing + 5 gap cases)
```

---

## 5. Layer 1 — Go Unit Tests

**Target**: `server/internal/service/`, `server/internal/middleware/`, `server/internal/domain/`

**Tools**: stdlib `testing` only. No testify — consistent with `go.mod` (no
external test deps today). Use table-driven tests throughout.

**Makefile target**: `make test` → `cd server && go test ./...`

**Note**: `go test ./...` must be run from inside `server/` (not repo root),
because the repo root is not a Go module. This is already the pattern for all
existing Go Makefile targets (`cd server && go build`, `cd server && go vet`).

### 5.1 Pure-function tests (zero mocks needed)

**`service/vclock_test.go`** — highest priority, CRDT correctness

| Test | What it covers |
|------|---------------|
| `TestCompareClocks_Dominates` | A={a:2} B={a:1} → ClockDominates |
| `TestCompareClocks_Dominated` | A={a:1} B={a:2} → ClockDominated |
| `TestCompareClocks_Concurrent` | A={a:2} B={b:2} → ClockConcurrent |
| `TestCompareClocks_Equal` | A={a:1} B={a:1} → ClockEqual |
| `TestCompareClocks_EmptyClocks` | nil / empty maps |
| `TestMergeVectorClocks` | union + max per key |
| `TestTieBreak_AgentName` | lexicographic ordering |
| `TestTieBreak_IDFallback` | same agent name → ID ordering |

~50 LoC, covers all 4 `ClockRelation` values exhaustively.

**`service/sections_test.go`**

| Test | What it covers |
|------|---------------|
| `TestMergeSectionMetadata_Disjoint` | A owns sec-01, B owns sec-02 → both survive |
| `TestMergeSectionMetadata_Conflict` | A+B both own sec-01 → incoming agent wins |
| `TestMergeSectionMetadata_NoSections` | either side nil → returns `ok=false` |
| `TestMergeSectionMetadata_ExtraKeys` | non-sections keys preserved in merged output |
| `TestRenderSectionIndex_Deterministic` | sorted by key, correct `[key] title | firstline` format |
| `TestRenderSectionIndex_MultilineBody` | only first line of body appears |

~60 LoC.

**`service/memory_test.go`** — pure helpers

| Test | What it covers |
|------|---------------|
| `TestValidateMemoryInput_Empty` | empty content → ValidationError |
| `TestValidateMemoryInput_TooLong` | content > 50000 chars |
| `TestValidateMemoryInput_TooManyTags` | > 20 tags |
| `TestValidateMemoryInput_KeyTooLong` | key > 255 chars |
| `TestRrfMerge` | rank scoring for combined vec+kw results |
| `TestPaginate` | offset/limit slicing, past-total, zero-length |
| `TestSortByScore` | deterministic descending sort |

~80 LoC.

### 5.2 Service-layer tests with mock MemoryRepo

**Prerequisite refactor** (~15 LoC): `embed.Embedder` already has exactly one
public method: `Embed(ctx context.Context, text string) ([]float32, error)`.
Add a small interface in `embed/` with a non-conflicting name (`Client`) and
change `MemoryService.embedder` from `*embed.Embedder` to that interface. The
concrete `*embed.Embedder` satisfies it unchanged — no behavioral diff.

```go
// server/internal/embed/embedder.go (addition — 3 lines)
type Client interface {
    Embed(ctx context.Context, text string) ([]float32, error)
}
```

Change in `service/memory.go`:

```go
// Before
embedder *embed.Embedder
// After
embedder embed.Client   // interface — accepts *embed.Embedder or any mock
```

**Mock strategy**: hand-written structs in `_test.go` files (no mockgen — keeps
deps zero). The `MemoryRepo` interface has 15 methods (`Create`, `Upsert`,
`GetByID`, `GetByKey`, `UpdateOptimistic`, `SoftDelete`, `List`, `Count`,
`BulkCreate`, `VectorSearch`, `AutoVectorSearch`, `KeywordSearch`, `FTSSearch`,
`CRDTUpsert`, `ListBootstrap`); use a `stubMemoryRepo` embedding a no-op base
and overriding only the methods each test needs:

```go
type stubMemoryRepo struct{ repository.MemoryRepo }
func (s *stubMemoryRepo) GetByKey(...) (*domain.Memory, error) { return s.mem, s.err }
```

**`service/memory_service_test.go`** — Search routing

| Test | Condition | Expected path |
|------|-----------|---------------|
| `TestSearch_AutoModel` | `autoModel != ""` | `AutoVectorSearch` called |
| `TestSearch_Embedder` | `embedder != nil, autoModel == ""` | `VectorSearch` + FTS/keyword both called |
| `TestSearch_FTSOnly` | `embedder == nil, ftsAvailable = true` | `FTSSearch` called |
| `TestSearch_KeywordFallback` | `embedder == nil, ftsAvailable = false` | `List` called |
| `TestSearch_EmptyQuery` | `q == ""` | `List` called regardless of embedder |
| `TestSearch_EmbedFail_FTSFallback` | embedder returns error, ftsAvailable=true | falls back to FTS |
| `TestSearch_BothLegsFail` | both vec+kw return error | returns empty, no panic |

**`middleware/auth_test.go`**

| Test | What it covers |
|------|---------------|
| Missing Authorization header → 401 | unauthenticated path |
| Space token resolves → agent + spaceID in context | normal auth flow |
| User token resolves → AuthInfo with empty SpaceID (200, not 401 — no scope enforcement at middleware layer) | known limitation: user tokens silently scope to `space_id=""` |
| Unknown token → 401 | not found path |

~80 LoC, uses `httptest.NewRecorder`.

---

## 6. Layer 2 — Go Handler Tests

**Target**: `server/internal/handler/`

**Tools**: `net/http/httptest` + stdlib `testing`

**Strategy**: Handler tests use real `*service.MemoryService` instances backed by
a `stubMemoryRepo`. This is a 2-hop approach (test → handler → service → mock
repo) that avoids extracting a `MemoryServicer` interface — which would require
touching handler wiring. The stub repo is the single seam.

This approach is preferred over extracting service interfaces because:
- It tests the handler→service→repo path, not just the handler
- It is strictly more rigorous than mocking the service
- It avoids a large refactor of the handler layer for test-only reasons

**`handler/memory_test.go`**

| Test | What it covers |
|------|---------------|
| `TestCreate_BadJSON` | malformed request body → 400 |
| `TestCreate_MissingContent` | missing required field → 400 (`ErrValidation` maps to `StatusBadRequest`) |
| `TestCreate_Success` | 201 + correct response shape `{id, content, ...}` |
| `TestSearch_ResponseShape` | GET /memories → `{memories, total, limit, offset}` all present and typed |
| `TestSearch_UserToken_EmptySpace` | user token request returns 200 with empty results (`space_id=""`, known limitation; not 401) |
| `TestSearch_PaginationParams` | `?limit=5&offset=10` propagated to filter |
| `TestDelete_NotFound` | stub returns `ErrNotFound` → 404 |
| `TestCRDTHeaders_Dominated` | `WriteResult.Dominated=true` → `X-Mnemo-Dominated: true` |
| `TestCRDTHeaders_Winner` | `WriteResult.Winner="agent-b"` → `X-Mnemo-Winner: agent-b` |
| `TestCRDTHeaders_Merged` | `WriteResult.Merged=true` → `X-Mnemo-Merged: true` |

~150 LoC.

---

## 7. Layer 3 — TypeScript Unit Tests

**Target**: Both TypeScript plugins.

**Tool**: **Vitest** — ESM-native, works with tsx directly, `vi.stubGlobal`
for fetch mocking, no compilation step. Compatible with both plugins' existing
ESM/TypeScript setup (`"type": "module"`).

**Makefile target**: `make test-ts` → runs vitest in both plugin directories.

### 7.1 opencode-plugin tests

**Vitest setup** (~7 LoC total):

```bash
cd opencode-plugin && npm i -D vitest
```

```json
// opencode-plugin/package.json — add to scripts:
"test": "vitest run"
```

```ts
// opencode-plugin/vitest.config.ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });
```

**Constructor seam for `DirectBackend`**: The constructor fires
`this.schemaReady = this.ensureSchema()` which calls `fetch`. Because all DB
access goes through the private `sql()` → `fetch` path, mocking global `fetch`
**before** calling `new DirectBackend(cfg)` absorbs all schema-init calls. No
constructor change needed.

```ts
// In test setup:
vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
  ok: true,
  json: async () => ({ types: [], rows: [] }),
  text: async () => "",
}));
const backend = new DirectBackend(testCfg); // ensureSchema() calls absorbed
await (backend as any).schemaReady;
```

| Test | What it covers |
|------|---------------|
| `memory_get` backend returns null → `{ok:false, error:"memory not found"}` |
| `memory_get` backend returns Memory → `{ok:true, memory:{...}}` |
| `memory_store` backend throws → `{ok:false, error:"..."}` |
| `memory_search` all filter params passed through to backend |
| `memory_delete` returns `{ok:true}` on success |

~80 LoC. Pass `vi.fn()` mock implementing `MemoryBackend` interface.

**`src/hooks.test.ts`**

| Test | What it covers |
|------|---------------|
| `formatMemoriesBlock([])` → empty string | pure function |
| `formatMemoriesBlock([m1, m2])` → correct format | pure function |
| TTL cache: second call within 5 min → `listRecent` not called again | cache hit |
| TTL cache: call after 5 min → `listRecent` called again | cache miss (mock `Date.now`) |
| `session.idle` event → `store` called + cache invalidated | hook behavior |

~100 LoC.

**`src/direct-backend.test.ts`** — security-sensitive `escape`/`interpolate`

| Test | What it covers |
|------|---------------|
| `escape("O'Brien")` → `"O\\'Brien"` | single-quote escaping |
| `escape(null)` → `"NULL"` | null handling |
| `escape(true/false)` → `"1"/"0"` | boolean encoding |
| `interpolate("? AND ?", ["a", "b"])` → correct substitution | placeholder replacement |
| `rowsToMemories` — TiDB response shape → Memory[] | response mapping |
| `buildFilter` with tags → SQL contains `JSON_CONTAINS` | filter generation |
| `buildFilter` with q+tags → both conditions present | combined filter |

~120 LoC. Mock global `fetch` for SQL calls.

### 7.2 openclaw-plugin tests

**Vitest setup** (~7 LoC):

```bash
cd openclaw-plugin && npm i -D vitest
```

```json
// openclaw-plugin/package.json — add to scripts:
"test": "vitest run"
```

```ts
// openclaw-plugin/vitest.config.ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["**/*.test.ts"] } });
```

**Constructor seam for `DirectBackend`**: Unlike opencode, the openclaw
constructor calls `connect()` from `@tidbcloud/serverless` (line 115), which
cannot be intercepted by `fetch` mocking — it uses a proprietary WebSocket
transport. Fix: add an optional final constructor parameter `_conn?: Connection`.
If provided, skip `connect()`. This is a ~4 LoC change and enables injection
of a stub `Connection` with controlled `execute()`.

```ts
// openclaw-plugin/direct-backend.ts — constructor addition (~4 LoC)
constructor(host, username, password, database, embedder, autoEmbedModel?, autoEmbedDims?, _conn?: Connection) {
  this.conn = _conn ?? connect({ host, username, password, database });
  // ... rest unchanged
}
```

```ts
// In tests:
const stubConn = { execute: vi.fn().mockResolvedValue([]) };
const backend = new DirectBackend("h", "u", "p", "db", null, undefined, undefined, stubConn as any);
await (backend as any).initialized;
```

**`direct-backend.test.ts`** — constructor seam + query behavior

| Test | What it covers |
|------|---------------|
| Constructor with injected `_conn` skips SDK connect side effects | deterministic offline tests |
| `search({ q, tags })` sends SQL with `JSON_CONTAINS` + query filter | combined filter correctness |
| Hybrid path enabled (`embedder` or `autoEmbedModel`) returns typed shape `{data,total,limit,offset}` | routing + contract |
| Both legs fail in hybrid path returns empty result (no throw) | failure-path stability |

~110 LoC. Uses injected stub connection + controlled `execute()` responses.

**`server-backend.test.ts`** — CRDT clock strategy (Option C)

| Test | What it covers |
|------|---------------|
| `store` with key, existing clock `{a:1}` → POST clock `{a:1, self:1}` | increment |
| `store` with key, no existing record → POST clock `{self:1}` | first write |
| `store` without key → no `fetchByKey` call | keyless write |
| `write_id` is UUID and present in POST body | idempotency field |
| Non-ok HTTP response → throws with error text | error path |

~90 LoC. Mock `fetch` with `vi.stubGlobal`.

---

## 8. Layer 4 — E2E Additions

Keep all existing Lane A/B/C cases unchanged. Add the 5 gap cases identified
in the prior gap-analysis discussion (validated by Codex review):

| Case | Lane | Priority | Script |
|------|------|----------|--------|
| A5: `q + tags` combined filter | A | P0 | `fts-hybrid-server-e2e.py` |
| B8: vector-leg hybrid with `MNEMO_EMBED_API_KEY` configured | B OpenCode | P0 | `fts-hybrid-opencode-e2e.ts` |
| B9: CRDT-written memories searchable via FTS | CRDT | P1 | `crdt-e2e-tests.sh` |
| A6: multi-word FTS — xfail marker, documents known limitation | A | P3 | `fts-hybrid-server-e2e.py` |
| LC2/LC3: same-key overwrite + near-simultaneous writes in canary | C | P2 | `fts-hybrid-openclaw-tmux-canary.sh` |

**Implementation note for A5**: The server parses `?tags=` as a comma-separated
string (e.g., `?tags=deploy,agent-a`). Tests must use this format, not JSON
array syntax.

---

## 9. Shell Hook Testing

**`claude-plugin/hooks/`** — two-tier approach:

**Immediately testable with bats-core** (`mnemo_mode`, `mnemo_check_env`):

```bash
# e.g. claude-plugin/hooks/common_test.bats
@test "mnemo_mode returns direct when MNEMO_DB_HOST is set" {
  MNEMO_DB_HOST=host MNEMO_API_URL= run mnemo_mode
  assert_output "direct"
}
```

~40 LoC. Add `bats-core` as a dev dependency or use system bats.

**Keep in Lane B-shell E2E** (heavy functions with inline Python):
- `mnemo_direct_init` — `fts-hybrid-claude-schema.sh` covers this (B6/B7)
- `mnemo_search` — covered by session-start hook behavior in Lane C canary

**Longer-term refactor** (out of scope for initial rollout): Extract inline
Python from `mnemo_search` and `mnemo_post_memory` into
`claude-plugin/hooks/lib/search.py` and `store.py`. This would enable Python
unit tests for the RRF merge logic independently.

---

## 10. CI Changes

### 10.1 New `unit-test` job (unconditional — no opt-in gate)

Add to `.github/workflows/e2e.yml` (or a new `unit-test.yml`):

```yaml
unit-test:
  name: Unit Tests (Go + TypeScript)
  runs-on: ubuntu-latest
  # NO 'if' guard — runs on every PR unconditionally

  steps:
    - uses: actions/checkout@v4

    - uses: actions/setup-go@v5
      with:
        go-version-file: server/go.mod
        cache-dependency-path: server/go.sum

    - name: Go unit tests
      run: cd server && go test ./...

    - uses: actions/setup-node@v4
      with:
        node-version: "20"

    - name: opencode-plugin unit tests
      run: cd opencode-plugin && npm ci && npm test

    - name: openclaw-plugin unit tests
      run: cd openclaw-plugin && npm ci && npm test
```

This job has zero external secrets — runs unconditionally, blocks every PR.

### 10.2 Makefile additions

```makefile
# Add to Makefile:

test:
	cd server && go test ./...

test-ts:
	cd opencode-plugin && npm ci --silent && npm test
	cd openclaw-plugin && npm ci --silent && npm test

test-all: test test-ts

check: test-all vet build
```

---

## 11. Rollout Plan

Agreed ordering after cross-agent review: TypeScript vitest setup has zero
blockers and runs in parallel with Phase 1. Handler tests depend on Phase 2
(embedder extraction) and come after. Direct-backend TS tests come last because
they require the constructor seam changes.

| Phase | Scope | Est. LoC | Blocker? | Can parallel? |
|-------|-------|----------|---------|---------------|
| Phase 1A | Pure Go unit tests: `vclock_test.go`, `sections_test.go`, helpers in `memory_test.go` | ~190 LoC | None — zero deps | Yes — parallel with 1B |
| Phase 1B | Vitest setup in both plugin packages + `tools.test.ts` + `hooks.test.ts` | ~200 LoC | None — zero deps | Yes — parallel with 1A |
| Phase 2 | `embed.Client` interface extraction (~15 LoC) + `MemoryService` routing tests | ~100 LoC | ~15 LoC refactor | After Phase 1A |
| Phase 3 | Handler tests via `httptest` + `stubMemoryRepo` | ~150 LoC | Phase 2 complete | After Phase 2 |
| Phase 4 | `direct-backend.test.ts` (opencode, fetch-mocked) + `direct-backend.test.ts` (openclaw, injected `_conn`) + `server-backend.test.ts` (openclaw, fetch-mocked) + openclaw `_conn` constructor seam | ~220 LoC | ~4 LoC seam change | After Phase 1B |
| Phase 5 | CI `unit-test` job (unconditional) + Makefile `test`/`test-ts`/`test-all`/`check` targets | ~30 LoC config | Phases 1-4 | After all above |
| Phase 6 | E2E gap cases (A5, B8, B9, A6, LC2/LC3) | ~120 LoC | None | Any time |
| Phase 7 | bats-core for `common.sh` `mnemo_mode`/`mnemo_check_env` | ~40 LoC | Install bats | Any time |

---

## 12. Key Design Decisions

1. **No testify in Go** — `go.mod` has no external test deps; stdlib `testing`
   is sufficient for table-driven tests. Add testify only if assertion verbosity
   becomes painful in Phase 3+.

2. **Vitest over Jest** — Both plugin packages use ESM (`"type": "module"`).
   Vitest is ESM-native and works directly with tsx. Jest requires additional
   transform config for ESM.

3. **2-hop handler tests over service interface extraction** — Extracting
   `MemoryServicer`/`SpaceServicer` interfaces is a non-trivial refactor for
   test-only benefit. Testing handlers through real service instances backed by
   mock repos is strictly more rigorous and avoids dead interface proliferation.

4. **bats-core scope-limited** — Only `mnemo_mode` and `mnemo_check_env` are
   suitable for bats. The heavy shell functions (`mnemo_search`, `mnemo_direct_init`)
   have too many embedded side effects; they stay in Lane B-shell E2E.

5. **Unit test job is unconditional** — Unlike E2E (opt-in, needs DB secrets),
   unit tests have zero external deps and must block every PR. They are the
   fast-feedback loop.

---

## 13. Coverage Map After Full Rollout

| Package/Module | Layer | Coverage |
|----------------|-------|---------|
| `service/vclock.go` | Unit | All 4 ClockRelation values |
| `service/sections.go` | Unit | All merge/render paths |
| `service/memory.go` helpers | Unit | validate, paginate, rrfMerge, sort |
| `service/memory.go` routing | Unit (mock repo) | 7 search dispatch combinations |
| `service/space.go` | Unit (mock repo) | Provision, CreateUser, AddToken |
| `middleware/auth.go` | Unit (mock repo) | Token resolution, scope checks |
| `handler/memory.go` | Integration (httptest) | Request parsing, CRDT headers, shape |
| `handler/space.go` | Integration (httptest) | Bootstrap, token endpoints |
| `embed/embedder.go` | Unit | nil-safety (interface extraction) |
| `repository/tidb/` | E2E | Live DB |
| `opencode-plugin/src/tools.ts` | Unit (vitest) | All 5 tools, error paths |
| `opencode-plugin/src/hooks.ts` | Unit (vitest) | formatMemoriesBlock, TTL cache |
| `opencode-plugin/src/direct-backend.ts` | Unit (vitest) | escape, interpolate, rowsToMemories, buildFilter |
| `openclaw-plugin/direct-backend.ts` | Unit (vitest) | constructor seam (`_conn`), combined filters, hybrid fallback paths |
| `openclaw-plugin/server-backend.ts` | Unit (vitest) | Clock increment, write_id, error paths |
| `claude-plugin/hooks/common.sh` | bats | mnemo_mode, mnemo_check_env |
| FTS hybrid search | E2E (Lane A/B/C) | A1-A6, B1-B9, B1b, B6-B7, LC1-LC3 |
| CRDT | E2E (CRDT suite) | 8+6+13+13 cases + new B9 |
