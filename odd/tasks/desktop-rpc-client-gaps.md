# Desktop RPC — additive methods the Desktop client needs

Follow-up to `odd/tasks/desktop-rpc.md`. Adds five methods and one event so Gentle Shell Desktop can render worktree changes, MCP inventory, the active agent-model profile, the native action vocabulary and truthful session state without parsing TUI text and without duplicating any existing owner. Transport, schema, correlation, lifecycle, gating and event ordering stay exactly as slice 1 defined them.
Companion app document: `gentle-shell-desktop` `odd/tasks/desktop-rpc-client.md`. This document authorizes no application change and no publication.

## Specs

S1. Authorization (verbatim, from the desktop owner): "Si tenemos todo bien definido y acotado generamos la documentación pertienente para la posterior implementacion porque entiendo que los cuatro bloqueos del unto 4 tienen su solución propuesta." Document ownership (verbatim): "la documentació odd que afecte a gentle-shell debe vivir en ../gentle-pi y se trabajará con una sesión en su propio repo". Implementation of this document happens in this repository, by a session rooted here; the desktop repository is read for context only.

S2. Inheritance: `odd/tasks/desktop-rpc.md` S2 (extend through the public extension API; no fork, no runtime source change, no `node_modules` edit), S4 (reuse existing owners; never create a parallel store, fetcher, registry or process manager), S6 (no credentials, tokens, arbitrary paths or raw provider errors cross the contract) and S11 (local work-unit commits only; no push, PR or merge) all still bind. Every method here is additive: a new advertised method, never a silent one, and never a change to an announced one.

S3. `get_worktree_changes` returns the worktree state Gentle Shell already computes — branch, changed files, additions and deletions — for a requested root, reusing `lib/shell-changes.ts` (`WorktreeChangesTracker`, `parseNumstat`, `parsePorcelain`, `changesModel`). Read-only, no git mutation, no branch or worktree policy, no new policy owner. The Desktop app renders these numbers and never spawns git itself.

S4. `mcp_status` reports inventory only: servers configured in `<agentDir>/mcp.json`, servers registered through `pi.getMcpServers()` (extension-registered only), and tool namespaces derived from `pi.getAllTools()` (`mcp__<server>__<tool>`). `health` is reported as `"unknown"` and no field may imply a connection state, because `pi.getMcpStatus()` and `pi.onMcpStatusChanged` do not exist in the pi builds this repository resolves. Reuse the same `mcp.json` read as `extensions/startup-banner.ts:723-730`, honoring `PI_CODING_AGENT_DIR`; do not add a second reader.

S5. `get_active_profile` reports the session-effective agent-model profile label that the footer already shows — the pinned/bound label, `(local)`, `(repo)` or the bare global name (`extensions/gentle-shell.ts:216-289`, `lib/shell-bar.ts:383-384`) — not an account identity. `get_config{store:"profiles"}` keeps returning the global `active`; this method exists because the two differ when a session binds a profile.

S6. `tool_vocabulary` publishes the native action classification as data: tool name or pattern mapped to a category (`read`, `edit`, `write`, `search`, `list`, `bash`, `delegation`, `rdd`, `memory`) with the native glyph. Sources to consolidate, without importing the rendering modules: `extensions/quiet-tools.ts:44-52` (`TOOL_GLYPH`), `extensions/gentle-agents.ts:533-552` (`ACTION_GLYPH`, `ACTION_HEADING`), `lib/gentle-ai-renderer.ts:68-75` (rdd) and the Engram `mem_*` memory family, which stays absent until a provider publishes it rather than being invented here.

S7. `session_state_changed` is a push event carrying model, thinking level, context usage and cost when they change, so a client does not poll during a run. It must state availability per field: an unavailable value is omitted, never zero. Model and thinking are the effective values, not the requested ones. This is the only behavioural change in this document that is not purely additive to a status quo; it must not alter existing events or their ordering.

S8. No second MCP client. Owning our own connector to measure health was evaluated and rejected: it duplicates pi's transports and OAuth, races the built-in connector, and is only honest by replacing it. `mcp_status` is inventory until pi exposes status.

S9. Verification per method: the method appears in `capabilities`; the slice's allowlist test and the maintainer capability probe are updated; a limits section is added to `docs/desktop-rpc.md`; test-first coverage for malformed params, unknown root, absent config, unavailable fields and read-only behaviour. `mcp_status` and `get_worktree_changes` must be proven non-mutating.

S10. High-risk items: item 3 for `get_worktree_changes` and `mcp_status` only if they change any announced contract (they must not) and for `session_state_changed` (adds traffic to every client); item 4 for anything that reads shared owners concurrently with the agent; item 1 is not present because nothing here writes stored data.

## Tasks

T1 | S1-S3,S9 | slice: `get_worktree_changes` — new `lib/desktop-rpc-worktree.ts`, `DESKTOP_WORKTREE_METHODS`, router array entry, doc section + limits, tests with a fake git runner | pending | route: delegated writer with independent verification (read-only git boundary) | commit: pending.
T2 | S1-S2,S4,S8-S9 | slice: `mcp_status` inventory — reuses the existing `mcp.json` reader and `getMcpServers`/`getAllTools`; no health field beyond `"unknown"` | pending | route: delegated writer | commit: pending.
T3 | S1-S2,S5,S9 | slice: `get_active_profile` — reuses the active-profile reader, returns the session-effective label plus the global active name | pending | route: inline (small, one owner) | commit: pending.
T4 | S1-S2,S6,S9 | slice: `tool_vocabulary` — consolidates the three constant tables into one published projection; no import of pi-tui modules; unaudited families stay absent | pending | route: inline | commit: pending.
T5 | S1-S2,S7,S9-S10 | slice: `session_state_changed` — emit on real change only, coalesced, with per-field availability; no polling contract introduced | pending | route: delegated writer with independent verification (event ordering, item 4) | commit: pending.
T6 | S9 | slice: `capabilities` and `docs/desktop-rpc.md` refreshed for the five additions; maintainer probe updated; no earlier method altered | pending | route: inline | commit: pending.

## Slices

Slice 1 (this commit): this document only.

Slice 2 (T1, T2): the two read-only inventory methods the Desktop footer needs. Independent of each other, both shut out any health claim.

Slice 3 (T3, T4): the two small projections, one owner each.

Slice 4 (T5, T6): the push event and the contract refresh. T5 is the only unit with concurrency exposure, so it commits alone.

Delivery: local work-unit commits on a feature branch, per `odd/tasks/desktop-rpc.md` S11. Publication and the Desktop client itself remain separate decisions.

## Log

L1. Original user request (verbatim): "Si tenemos todo bien definido y acotado generamos la documentación pertienente para la posterior implementacion porque entiendo que los cuatro bloqueos del unto 4 tienen su solución propuesta. Corrige también las dos rutas de README.md y types.ts. gentle-shell tiene su propio repo como bien dices en ../gentle-pi pero no sé porque necesitas apuntar a esas rutas, la documentació odd que afecte a gentle-shell debe vivir en ../gentle-pi y se trabajará con una sesión en su propio repo y la documentación odd que afecte a gentle-shell-desktop vivira es este mismo repo y se trabajará con sesiones en este mismo repo (no sé si es a esto a lo que me refieres)".

L2. Ownership decisions taken by the same owner earlier in the exchange and binding on this document (verbatim): "¿Cómo solventamos el footer de changes? ¿Lo trabajamos en gentle-shell o trabajo propio en gentle-shell-desktop?" (answer: gathering stays here); "¿Cómo solventmos los glifos semánticos read/edit/memory/delegation/rdd que están implementados en gentle-shell?" (answer: publish the classification, render glyphs in the app); "profile-name es el nombre del perfil que el usuario tiene activo desde /gentle:profiles, no la identidad del usuario".

L3. Evidence gathered before this document, read-only: three separate glyph tables with no unified classifier; `worktree list --porcelain -z`, `diff --numstat HEAD` and `status --porcelain=v1 ... -z` behind an injected runner with pure parsers; `createActiveProfileReader` distinguishing global, bound, local and repo labels; `pi.getMcpStatus`/`onMcpStatusChanged` absent from the pi builds resolved here, with `getMcpServers()` covering extension registrations only; `mcp-status.md` already warning that config counts and `getAllTools()` are not health.

L4. Scope limit carried forward: this document adds read-only projections and one push event. It does not add MCP health, does not add a git writer, does not change the schema version and does not touch any method announced by slice 1.
