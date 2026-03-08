---
name: mem9
version: 1.0.0
description: |
  Install, configure, verify, migrate, or troubleshoot the mnemo (`mem9`) memory
  plugin for OpenClaw. Use this skill whenever the user wants OpenClaw persistent
  memory via mnemo-server, needs `openclaw.json` updated with
  `plugins.slots.memory = "mnemo"` and `plugins.entries.mnemo`, needs a `tenantID`
  provisioned, wants to migrate existing OpenClaw memory/session files, or is
  debugging OpenClaw startup logs such as `[mnemo] Server mode` or
  `No mode configured`.
  Do NOT use for non-OpenClaw platforms or for ordinary memory CRUD operations
  after setup is already complete.
compatibility: |
  Requires OpenClaw >=2026.1.26, curl, and jq.
  Default server: https://api.mem9.ai (no self-hosting required for basic use).
author: qiffang
keywords: [mem9, mnemo, openclaw, memory, plugin, install, setup, onboarding]
metadata:
  openclaw:
    emoji: "⚡"
---

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│   ███╗   ███╗███████╗███╗   ███╗ █████╗                      │
│   ████╗ ████║██╔════╝████╗ ████║██╔══██╗                     │
│   ██╔████╔██║█████╗  ██╔████╔██║╚██████║                     │
│   ██║╚██╔╝██║██╔══╝  ██║╚██╔╝██║ ╚═══██║                     │
│   ██║ ╚═╝ ██║███████╗██║ ╚═╝ ██║ █████╔╝                     │
│   ╚═╝     ╚═╝╚══════╝╚═╝     ╚═╝ ╚════╝                      │
│                                                              │
│   persistent memory for ai agents                            │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

# mem9-setup

Your agent forgets nothing. Stateless plugin → REST API → DB.

## What You Get

| Tool            | When                                                      |
| --------------- | --------------------------------------------------------- |
| `memory_store`  | Persist facts, decisions, context                         |
| `memory_search` | Hybrid vector + keyword search                            |
| `memory_get`    | Retrieve by ID                                            |
| `memory_update` | Modify existing memory (fully replaces tags and metadata) |
| `memory_delete` | Remove                                                    |

Lifecycle hooks (automatic — no agent action needed):

| Hook                  | Trigger         | What happens                          |
| --------------------- | --------------- | ------------------------------------- |
| `before_prompt_build` | Every LLM call  | Relevant memories injected as context |
| `before_reset`        | Before `/reset` | Session summary saved                 |
| `agent_end`           | Agent finishes  | Last response captured                |

---

## Onboarding

Step labels:

- `[AGENT]` — steps you perform directly (file edits, curl, shell)
- `[HUMAN]` — steps the user must perform (restart OpenClaw, browser actions)

1. **Provision tenant** — `[AGENT]` run `curl -sX POST https://api.mem9.ai/v1alpha1/mem9s | jq .`, save `id` as `TENANT_ID`.
2. **Install plugin** — `[AGENT]` run `openclaw plugins install @mem9/openclaw`
3. **Configure `openclaw.json`** — `[AGENT]` patch in `plugins.slots.memory = "mnemo"` and `plugins.entries.mnemo` with your `apiUrl` and `tenantID`
4. **Restart** — `[HUMAN]` restart OpenClaw
5. **Verify** — `[AGENT]` confirm `[mnemo] Server mode` in startup logs, then run the round-trip check in Step 6

---

## Setup Workflow

### 1. Preflight

| Check                    | Command                 | If missing                                                                         |
| ------------------------ | ----------------------- | ---------------------------------------------------------------------------------- |
| OpenClaw `>=2026.1.26`   | `openclaw --version`    | `[HUMAN]` install OpenClaw first — stop here                                       |
| `curl`                   | `curl --version`        | `[HUMAN]` install curl — stop here                                                 |
| `jq`                     | `jq --version`          | `[AGENT]` `brew install jq` or `apt-get install -y jq`; abort if still unavailable |
| `openclaw.json` location | resolve per rules below | `[AGENT]` will create `./openclaw.json` in step 4                                  |

Resolve `OPENCLAW_JSON` in this order:

1. User-provided path
2. `./openclaw.json` in current working directory
3. `~/.openclaw/openclaw.json`
4. `find . -maxdepth 3 -name "openclaw.json" 2>/dev/null | head -1`
5. If none found, create `./openclaw.json` in step 4

### 2. Reuse or provision a tenant

If `openclaw.json` already has `plugins.entries.mnemo.config.tenantID`, reuse it.

Otherwise provision:

```bash
API_URL="https://api.mem9.ai"
PROVISION_RESPONSE="$(
  curl -fsS -X POST "$API_URL/v1alpha1/mem9s" \
    -H "Content-Type: application/json" \
    -d '{"name":"openclaw-tenant"}'
)" || { echo "ERROR: curl failed with exit code $?"; exit 1; }
TENANT_ID="$(echo "$PROVISION_RESPONSE" | jq -r '.id')"
test -n "$TENANT_ID" && test "$TENANT_ID" != "null" \
  || { echo "ERROR: tenant ID not found: $PROVISION_RESPONSE"; exit 1; }
```

**Verify**: `$TENANT_ID` is a non-empty UUID string.

If self-hosted, replace `API_URL` with your server's base URL.

### 3. Install the plugin

`[AGENT]` Try npm first, from the directory containing `openclaw.json`:

```bash
npm install mnemo-openclaw --prefix "$(dirname "$OPENCLAW_JSON")"
```

**Verify**: exits with code 0.

#### OpenClaw ≥2.2.0

`[AGENT]` Patch existing config (merge-safe, preserves other keys):
If that fails and the mnemos repo is present locally, fall back to source:

```bash
jq --arg tid "$TENANT_ID" '
  .plugins.slots.memory = "mem9" |
  .plugins.entries.mem9 = {
    enabled: true,
    config: { apiUrl: "https://api.mem9.ai", tenantID: $tid }
  } |
  .plugins.allow = ((.plugins.allow // []) + ["mem9"] | unique)
' openclaw.json > tmp.json && mv tmp.json openclaw.json
cd /path/to/mnemos/openclaw-plugin && npm install
```

**Note:** The `allow` array is additive—existing entries are preserved, `mem9` is appended (deduplicated).

Or if no `openclaw.json` exists, create:

**Verify**: exits with code 0. Do not mark this step complete unless one path succeeds.

### 4. Update openclaw.json

Patch only the plugin keys — preserve everything else:

```bash
TMP_JSON="${OPENCLAW_JSON}.tmp"
jq \
  --arg api_url "$API_URL" \
  --arg tenant_id "$TENANT_ID" \
  '
  .plugins |= (. // {}) |
  .plugins.slots |= ((. // {}) | .memory = "mnemo") |
  .plugins.entries |= (. // {}) |
  .plugins.entries.mnemo |= (. // {}) |
  .plugins.entries.mnemo.enabled = true |
  .plugins.entries.mnemo.config |= (. // {}) |
  .plugins.entries.mnemo.config.apiUrl = $api_url |
  .plugins.entries.mnemo.config.tenantID = $tenant_id
  ' \
  "$OPENCLAW_JSON" > "$TMP_JSON" && mv "$TMP_JSON" "$OPENCLAW_JSON"
```

**Verify**: `jq '.plugins.slots.memory, .plugins.entries.mnemo.enabled' "$OPENCLAW_JSON"` outputs `"mnemo"` and `true`.

If `openclaw.json` does not exist yet, create the minimal file:

```json
{
  "plugins": {
    "slots": { "memory": "mnemo" },
    "entries": {
      "mnemo": {
        "enabled": true,
        "config": {
          "apiUrl": "https://api.mem9.ai",
          "tenantID": "replace-me"
        }
      }
    },
    "allow": ["mem9"]
  }
}
```

#### OpenClaw <2.2.0

`[AGENT]` No `allow` array needed:

```bash
jq --arg tid "$TENANT_ID" '
  .plugins.slots.memory = "mem9" |
  .plugins.entries.mem9 = {
    enabled: true,
    config: { apiUrl: "https://api.mem9.ai", tenantID: $tid }
  }
' openclaw.json > tmp.json && mv tmp.json openclaw.json
```

If result returns stored memory → setup successful.

### 5. Optional migration of existing OpenClaw data

Run only when the user asked to import existing data. Reuse `$API_URL`, `$TENANT_ID`,
`$OPENCLAW_JSON` from earlier steps.

**Before starting**: tell the user upfront:

> "Starting import. Uploading files now — all requests fire in parallel. Server processes
> session files in the background (LLM extraction, ~30–60s per session chunk). I'll check
> progress and report back when done."

**CRITICAL — execution rule**: Write ALL upload commands into a **single bash script file**
and execute it with one Bash call. Never issue curl commands one by one as separate tool
calls — that serialises every upload and defeats parallelism entirely.

The imports API accepts file uploads and processes them asynchronously. Upload returns
immediately with a task ID; a background worker picks it up within 5 seconds.

Two file types are supported:

**session** — conversation history. JSON schema:

```json
{
  "agent_id": "main",
  "session_id": "ses-001",
  "messages": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ]
}
```

The server runs LLM extraction on the messages and distils them into memories.
Actual processing time: `ceil(message_count / 50) × 30–60s` per task (each 50-message
chunk requires one LLM extract + one LLM reconcile call, processed serially on the server).

**memory** — pre-extracted memories. JSON schema:

```json
{
  "agent_id": "main",
  "memories": [
    {
      "content": "User prefers TypeScript over JavaScript",
      "source": "my-agent",
      "tags": ["preferences"],
      "memory_type": "insight"
    }
  ]
}
```

Memories are bulk-inserted directly — no LLM pass, completes in seconds.

To minimise total processing time:

- Always upload `memory.json` first — bulk insert, no LLM, completes instantly.
- **Merge small sessions before uploading**: sessions with ≤50 messages are batched into
  a single combined file per agent (one LLM pass instead of N).
- **Fire all curl uploads in parallel** — do not wait for each upload to return before
  starting the next. All uploads return `202 Accepted` immediately.

```bash
AGENTS=$(jq -r '.agents.list // [] | .[].id // empty' "$OPENCLAW_JSON")

# Collect all upload pids for parallel wait
PIDS=()

for AGENT in $AGENTS; do
  WORKSPACE=$(jq -r ".agents.list[] | select(.id == \"$AGENT\") | .workspace // \"./\"" "$OPENCLAW_JSON")

  # 1. Memory file — direct bulk insert, no LLM, upload first.
  if [ -f "$WORKSPACE/memory.json" ]; then
    echo "Queuing memory.json for agent $AGENT"
    curl -fsS -X POST "$API_URL/v1alpha1/mem9s/$TENANT_ID/imports" \
      -F "file=@$WORKSPACE/memory.json" \
      -F "agent_id=$AGENT" \
      -F "file_type=memory" | jq '{id,status}' &
    PIDS+=($!)
  fi

  # 2. Session files — merge small ones (≤50 messages) into one upload.
  SESSIONS_DIR="$WORKSPACE/sessions"
  [ -d "$SESSIONS_DIR" ] || continue

  COMBINED=$(mktemp /tmp/mnemo-combined-XXXXXX.json)
  LARGE_LIST=$(mktemp /tmp/mnemo-large-XXXXXX.txt)

  python3 - "$SESSIONS_DIR" "$AGENT" "$COMBINED" "$LARGE_LIST" <<'PYEOF'
import json, os, sys, glob

sessions_dir, agent_id, combined_out, large_out = sys.argv[1:]
SMALL = 50

small_msgs, large_files = [], []
for path in sorted(glob.glob(os.path.join(sessions_dir, "*.json"))):
    try:
        data = json.load(open(path))
    except Exception:
        continue
    msgs = data.get("messages") or []
    if len(msgs) <= SMALL:
        small_msgs.extend(msgs)
    else:
        large_files.append(path)

json.dump({"agent_id": agent_id, "session_id": "combined", "messages": small_msgs}, open(combined_out, "w"))
open(large_out, "w").write("\n".join(large_files))
PYEOF

  COMBINED_MSGS=$(python3 -c "import json; print(len(json.load(open('$COMBINED'))['messages']))")
  if [ "$COMBINED_MSGS" -gt 0 ]; then
    echo "Queuing combined session ($COMBINED_MSGS messages) for agent $AGENT"
    curl -fsS -X POST "$API_URL/v1alpha1/mem9s/$TENANT_ID/imports" \
      -F "file=@$COMBINED" \
      -F "agent_id=$AGENT" \
      -F "session_id=combined" \
      -F "file_type=session" | jq '{id,status}' &
    PIDS+=($!)
  fi

  while IFS= read -r SESSION; do
    [ -n "$SESSION" ] || continue
    echo "Queuing large session $(basename "$SESSION") for agent $AGENT"
    curl -fsS -X POST "$API_URL/v1alpha1/mem9s/$TENANT_ID/imports" \
      -F "file=@$SESSION" \
      -F "agent_id=$AGENT" \
      -F "session_id=$(basename "$SESSION" .json)" \
      -F "file_type=session" | jq '{id,status}' &
    PIDS+=($!)
  done < "$LARGE_LIST"

  rm -f "$COMBINED" "$LARGE_LIST"
done

# Wait for all uploads to complete, then report
echo "Waiting for ${#PIDS[@]} upload(s) to finish..."
for PID in "${PIDS[@]}"; do wait "$PID"; done
echo "All uploads submitted."
```

Each upload returns `202 Accepted`:

```json
{ "id": "uuid", "status": "pending" }
```

**After all uploads are submitted**, tell the user:

> "All N files uploaded. Server is processing session tasks in the background — each
> 50-message chunk takes ~30–60s (LLM extraction). I'll poll progress now."

Then poll until done (see Check progress below). Do not leave the user waiting silently.

Check progress:

```bash
# All imports for this tenant
curl -fsS "$API_URL/v1alpha1/mem9s/$TENANT_ID/imports" | jq '{status: .status, tasks: [.tasks[] | {id, file, status, done, total, error}]}'

# Single import by ID
curl -fsS "$API_URL/v1alpha1/mem9s/$TENANT_ID/imports/$IMPORT_ID" | jq .
```

Task `status` values: `pending` → `processing` → `done` | `failed`.
Aggregate `status` on list: `empty` | `processing` | `done` | `partial` (some failed).

Report import IDs and final status to the user.

### 6. Verify

`[HUMAN]` Restart OpenClaw.

`[AGENT]` Check startup logs for:

```
[mnemo] Server mode (tenant-scoped mem9 API)
```

If logs are unavailable, use the functional round-trip check:

```bash
# Store a memory
curl -fsS -X POST "$API_URL/v1alpha1/mem9s/$TENANT_ID/memories" \
  -H "Content-Type: application/json" \
  -H "X-Mnemo-Agent-Id: verify-agent" \
  -d '{"content":"mem9 setup verified","tags":["setup-check"]}' | jq .id

# Search for it
curl -fsS "$API_URL/v1alpha1/mem9s/$TENANT_ID/memories?q=setup+verified&limit=5" | jq .
```

**Verify**: the search response contains the memory you just stored. Setup is complete.

---

## Default Import Behavior

When the user says "import memories to mem9" without specifying files:

1. Scan agent workspace for memory/session files
2. Upload **5 most recent** (by mtime)
3. **Upload in parallel** for speed

Paths to scan:

```
./memory.json         → file_type=memory
./memories.json       → file_type=memory
./memories/*.json     → file_type=memory
./sessions/*.json     → file_type=session (session_id = filename)
./session/*.json      → file_type=session (session_id = filename)
```

---

## Quick API Reference

All requests use `$API_URL/v1alpha1/mem9s/$TENANT_ID/...`.
No bearer token required — tenant ID in the URL path is the only auth.
Use `X-Mnemo-Agent-Id: <name>` to identify the calling agent (optional but useful).

```bash
# Store a memory
curl -fsS -X POST "$API_URL/v1alpha1/mem9s/$TENANT_ID/memories" \
  -H "Content-Type: application/json" \
  -H "X-Mnemo-Agent-Id: my-agent" \
  -d '{"content":"text","tags":["tag1"],"metadata":{}}' | jq .

# Search memories (hybrid vector + keyword)
curl -fsS "$API_URL/v1alpha1/mem9s/$TENANT_ID/memories?q=your+query&limit=10" | jq .

# Get by ID
curl -fsS "$API_URL/v1alpha1/mem9s/$TENANT_ID/memories/$MEMORY_ID" | jq .

# Update (tags and metadata fully replace existing values)
curl -fsS -X PUT "$API_URL/v1alpha1/mem9s/$TENANT_ID/memories/$MEMORY_ID" \
  -H "Content-Type: application/json" \
  -d '{"content":"updated text","tags":["new-tag"]}' | jq .

# Delete
curl -fsS -X DELETE "$API_URL/v1alpha1/mem9s/$TENANT_ID/memories/$MEMORY_ID"

# Upload a session file for async ingest (returns 202 + task id)
curl -fsS -X POST "$API_URL/v1alpha1/mem9s/$TENANT_ID/imports" \
  -F "file=@session.json" \
  -F "agent_id=my-agent" \
  -F "session_id=ses-001" \
  -F "file_type=session" | jq .

# Upload a memory file for direct bulk insert
curl -fsS -X POST "$API_URL/v1alpha1/mem9s/$TENANT_ID/imports" \
  -F "file=@memory.json" \
  -F "agent_id=my-agent" \
  -F "file_type=memory" | jq .

# List all imports (aggregate status: empty|processing|done|partial)
curl -fsS "$API_URL/v1alpha1/mem9s/$TENANT_ID/imports" | jq .

# Get single import status
curl -fsS "$API_URL/v1alpha1/mem9s/$TENANT_ID/imports/$IMPORT_ID" | jq .

# Health check
curl -fsS "$API_URL/healthz" | jq .
```

---

## Troubleshooting

| Symptom                       | Likely cause                   | Fix                                                                             |
| ----------------------------- | ------------------------------ | ------------------------------------------------------------------------------- |
| `[mnemo] No mode configured`  | Missing plugin config          | Ensure `plugins.entries.mnemo.config.apiUrl` and `tenantID` are set             |
| `Server mode requires...`     | Missing tenant ID              | Set `tenantID` in plugin config                                                 |
| Plugin not loading            | Wrong slot or missing entry    | Set `plugins.slots.memory = "mnemo"` and `plugins.entries.mnemo.enabled = true` |
| `404` or `connection refused` | Wrong `API_URL` or server down | Run `curl "$API_URL/healthz"` — must return `{"status":"ok"}`                   |
| Migration produced no imports | No source files matched        | Confirm `memory.json` or `sessions/*.json` exist in each agent workspace        |
| npm install failed            | Registry unavailable           | Fall back to source install from `openclaw-plugin/` if repo is present locally  |

---

## Next Steps

After first read, do this immediately:

1. **Print** — Tell the user:
   > mem9 ready. I can `memory_store`, `memory_search`, `memory_get`, `memory_update`, `memory_delete`. Memories auto-recall on every prompt and auto-capture on session end.
2. **Test** — Ask the user to tell you something to remember. Store it. Start a new session. Verify recall.
3. **Explore** — `curl -s "https://api.mem9.ai/v1alpha1/mem9s/$TENANT_ID/memories?limit=10" | jq .`

---

## Daily Update Check

```bash
curl -s https://raw.githubusercontent.com/qiffang/mnemos/main/clawhub-skill/mem9/SKILL.md \
  -o ~/.openclaw/skills/mem9/SKILL.md
```

---

```
░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
░  stateless agents · cloud memory · zero amnesia              ░
░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
```
