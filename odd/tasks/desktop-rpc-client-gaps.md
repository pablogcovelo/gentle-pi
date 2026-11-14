# Desktop RPC — additive methods the Desktop client needs

Follow-up to `odd/tasks/desktop-rpc.md`. Adds five methods and one event so Gentle Shell Desktop can render worktree changes, MCP inventory, the active agent-model profile, the native action vocabulary and truthful session state without parsing TUI text and without duplicating any existing owner. Transport, schema, correlation, lifecycle, gating and event ordering stay exactly as slice 1 defined them. The five methods and the event are additive; T0 is the one prerequisite refactor, recorded in S2.
Companion app document: `gentle-shell-desktop` `odd/tasks/desktop-rpc-client.md`. This document authorizes no application change and no publication.

## Specs

S1. Authorization (verbatim, from the desktop owner): "Si tenemos todo bien definido y acotado generamos la documentación pertienente para la posterior implementacion porque entiendo que los cuatro bloqueos del unto 4 tienen su solución propuesta." Document ownership (verbatim): "la documentació odd que afecte a gentle-shell debe vivir en ../gentle-pi y se trabajará con una sesión en su propio repo". Implementation of this document happens in this repository, by a session rooted here; the desktop repository is read for context only.

S2. Inheritance: `odd/tasks/desktop-rpc.md` S2 (extend through the public extension API; no fork, no runtime source change, no `node_modules` edit), S4 (reuse existing owners; never create a parallel store, fetcher, registry or process manager), S6 (no credentials, tokens, arbitrary paths or raw provider errors cross the contract) and S11 (local work-unit commits only; no push, PR or merge) all still bind. Every method here is additive: a new advertised method, never a silent one, and never a change to an announced one. The delivery as a whole is not purely additive, and this spec says so: T0 hoists the `<agentDir>/mcp.json` read out of `extensions/startup-banner.ts` into a shared `lib/` reader the banner then consumes, because S4 forbids a second reader. T0 changes no announced contract, no RPC schema and no banner output; it is its own work unit with a regression test pinning the current banner output.

S3. `get_worktree_changes` returns the worktree state Gentle Shell already computes, for a requested root, reusing `lib/shell-changes.ts` (`WorktreeChangesTracker`, `parseNumstat`, `parsePorcelain`, `changesModel`). The real shapes, not an idealized one: `WorktreeChanges` is `{ root, branch?, model: ChangesModel }` and there are no flat `additions`/`deletions` fields — the counts live in `model.added` and `model.deleted`, beside `model.digest` and the per-file `countsUnavailable`. `WorktreeChangesTracker` takes two injected runners, `discover: GitRunner` and `gitForRoot: (root) => GitRunner`, so the read-only proof must fake both: discovery runs `worktree list --porcelain -z`, and the per-root runner runs `HEAD`, `status --porcelain` and `diff --numstat`. `failedRoots` and `unbornRoots` are part of the contract, not an omission: a failed or unborn root is labeled, never rendered as zero files or zero lines. `UNKNOWN_BRANCH` is the spelling when the branch is unknown. Read-only, no git mutation, no branch or worktree policy, no new policy owner. The Desktop app renders these numbers and never spawns git itself.

S4. `mcp_status` reports inventory only: servers configured in `<agentDir>/mcp.json`, servers registered through `pi.getMcpServers()` (its own contract reads "every MCP server registered by extensions"), and tool namespaces derived from `pi.getAllTools()` (`mcp__<server>__<tool>`, the naming the shipped MCP extension produces). `health` is reported as `"unknown"` and no field may imply a connection state, because `pi.getMcpStatus()` and `pi.onMcpStatusChanged` do not exist in the pi builds this repository resolves — pi `1.4.0` is installed and neither symbol appears anywhere in its `dist` — and `docs/mcp-status.md` already states that configured-server counts and `getAllTools()` are not connection health. The `<agentDir>/mcp.json` read exists only as an inline block inside a `setTimeout` of `extensions/startup-banner.ts` (~723-730), honoring `PI_CODING_AGENT_DIR` through `getAgentDir()`; it is not an exported reader, so "reuse that read" and "do not add a second reader" only hold together if T0 hoists it into `lib/` and the banner consumes it. T2 depends on T0.

S5. `get_active_profile` reports the session-effective agent-model profile label the footer already shows. The spelling authority is `sessionProfileLabel` in `lib/session-profile-freeze.ts`, applied at `extensions/gentle-shell.ts:259`; `createActiveProfileReader` (`extensions/gentle-shell.ts:216`) is only the reader. The spellings are `name (session)`, `name (local)`, `name (repo)` and the bare global name. The label exists only after the reader is bound — `bind(cwd, resolveWorktree, sessionId)` and then `refresh()` — because an unbound reader returns exactly the global `active` that `get_config{store:"profiles"}` already returns (`lib/desktop-rpc-config.ts:237-246`). Acceptance test that decides whether the method exists at all: with a bound profile, the response must differ from `get_config{store:"profiles"}.active`. If it cannot differ, T3 is deleted rather than delivered as a decorative duplicate. `lib/desktop-rpc-profiles.ts` exposes `apply_profile` only, so this is genuinely additive and must not route through the profiles bridge.

S6. `tool_vocabulary` publishes the native action classification as data: tool name or pattern mapped to a category and its native glyph. The categories are `read`, `edit`, `write`, `search`, `list`, `bash`, `delegation` and `rdd`. There is no `memory` category: no `mem_*` tool is registered anywhere in this repository — the only occurrence is a readiness *detection* at `extensions/gentle-ai.ts:2286`, and Engram ships as a separate companion package — so the test certifies that the family is absent instead of inventing it, and the category is added the day a provider publishes it. Sources to consolidate, without importing the rendering modules: `extensions/quiet-tools.ts:44-52` (`TOOL_GLYPH`), `extensions/gentle-agents.ts:533-552` (`ACTION_GLYPH`, `ACTION_HEADING`) and `lib/gentle-ai-renderer.ts:68-75` (rdd). All three are module-private constants, so consolidating without drift means inverting the dependency: the tables move into `lib/` and the three modules consume them. That moves code the TUI render already uses, so it is risk item 3 and requires a regression test pinning the three current renderings unchanged, beside the published-vocabulary test.

S7. `session_state_changed` is a push event carrying model, thinking level, context usage and cost when they change, so a client does not poll during a run. It must state availability per field: an unavailable value is omitted, never zero. Model and thinking are the effective values, not the requested ones. This is the only behavioural change in this document that is not purely additive to a status quo; it must not alter existing events or their ordering.

S8. No second MCP client. Owning our own connector to measure health was evaluated and rejected: it duplicates pi's transports and OAuth, races the built-in connector, and is only honest by replacing it. `mcp_status` is inventory until pi exposes status.

S9. Verification per method: the method appears in `capabilities`; the slice's exact-methods assertion (the per-domain `assert.deepEqual` over `["capabilities", "get_snapshot", ...DOMAIN_METHODS]`) and the maintainer capability probe are updated; tests cover malformed params, unknown root, absent config, unavailable fields and read-only behaviour. `mcp_status` and `get_worktree_changes` must be proven non-mutating. Two corrections to the documentation convention, because the earlier wording assumed a shape that does not exist: limits are a `## <Domain> limits` section per domain (`docs/desktop-rpc.md:1139-1212`, with anchors from the `capabilities` prose), not a subsection per method; and `capabilities` is refreshed in two places under strict `assert.deepEqual` — the documented arrays (`docs/desktop-rpc.md:60-61`, plus the prose at `:62` and the `## Verification` list at `:1213-1226`) and the maintainer probe (`tests/maintainer/desktop-rpc.maintest.ts:183-184`, methods and events). Method sections go between `apply_profile` and `## Responses`; the event section goes after `profile_applied`, before the limits blocks, and keeps the `seq` contract and the response-before-event ordering documented at `docs/desktop-rpc.md:972`. MCP assertions live in their own test file and are never appended to `tests/desktop-rpc-safety.test.ts`, which pins job-label redaction, permission confirmation and late-owner disposal only: no server URLs, no environment values, `health` always `"unknown"`.

S10. High-risk items: item 3 for `get_worktree_changes` and `mcp_status` only if they change any announced contract (they must not), for `session_state_changed` (adds traffic to every client), and for T4 (moves the glyph tables the TUI render already consumes); T0 is item 3 for the same reason, since it changes code every banner render runs, and it carries the banner regression test. Item 4 for anything that reads shared owners concurrently with the agent. Item 1 is not present because nothing here writes stored data.

## Tasks

T0 | S2,S4,S9 | slice: prerequisite — hoist the `<agentDir>/mcp.json` read out of `extensions/startup-banner.ts` into a shared `lib/` reader the banner consumes; regression test pins the current banner output; no contract or schema change | done | route: inline, own commit | commit: 02dc6e8f7.
T1 | S1-S3,S9 | slice: `get_worktree_changes` — new `lib/desktop-rpc-worktree.ts`, `DESKTOP_WORKTREE_METHODS`, router array entry, doc section + limits, tests with a fake git runner pair (discovery + per-root) | done | route: delegated writer with independent verification (read-only git boundary) | commit: a19dfbd9d.
T2 | S1-S2,S4,S8-S9 | slice: `mcp_status` inventory — consumes the T0 reader and `getMcpServers`/`getAllTools`; no health field beyond `"unknown"`; own test file | pending | route: delegated writer; blocked until T0 lands | commit: pending.
T3 | S1-S2,S5,S9 | slice: `get_active_profile` — binds the reader, returns the session-effective label plus the global active name; carries the differ-from-global acceptance test and is deleted instead of delivered if it cannot differ | pending | route: inline, repriced after bind semantics | commit: pending.
T4 | S1-S2,S6,S9 | slice: `tool_vocabulary` — inverts the dependency so one `lib/` projection feeds the three consumers; no import of pi-tui modules; unpublished families stay absent and the test certifies their absence | pending | route: inline with independent verification (item 3) | commit: pending.
T5 | S1-S2,S7,S9-S10 | slice: `session_state_changed` — emit on real change only, coalesced, with per-field availability; no polling contract introduced | pending | route: delegated writer with independent verification (event ordering, item 4) | commit: pending.
T6 | S9 | slice: `capabilities` and `docs/desktop-rpc.md` refreshed for the five additions — five method sections, one event section, two limits blocks, both capabilities points, maintainer probe; no earlier method altered | pending | route: inline (one document), repriced larger than the earlier wording implied | commit: pending.

## Slices

Slice 1: this document.

Slice 2: T0 first and alone in its own commit, then T1 and T2 — the two read-only inventory methods the Desktop footer needs, independent of each other, both shut out any health claim. Boundary recorded so the review slices stay readable: T0 `02dc6e8f7`, T1 `a19dfbd9d`, T2 pending.

Slice 3: T3 and T4, the two small projections, one owner each. T4 commits alone because it is item 3.

Slice 4: T5 and T6. T5 is the only unit with concurrency exposure, so it commits alone.

Delivery: local work-unit commits on `feat/desktop-rpc-additive-methods`, branched from `develop`, per `odd/tasks/desktop-rpc.md` S11. Publication and the Desktop client itself remain separate decisions.

## Log

L1. Original user request (verbatim): "Si tenemos todo bien definido y acotado generamos la documentación pertienente para la posterior implementacion porque entiendo que los cuatro bloqueos del unto 4 tienen su solución propuesta. Corrige también las dos rutas de README.md y types.ts. gentle-shell tiene su propio repo como bien dices en ../gentle-pi pero no sé porque necesitas apuntar a esas rutas, la documentació odd que afecte a gentle-shell debe vivir en ../gentle-pi y se trabajará con una sesión en su propio repo y la documentación odd que afecte a gentle-shell-desktop vivira es este mismo repo y se trabajará con sesiones en este mismo repo (no sé si es a esto a lo que me refieres)".

L2. Ownership decisions taken by the same owner earlier in the exchange and binding on this document (verbatim): "¿Cómo solventamos el footer de changes? ¿Lo trabajamos en gentle-shell o trabajo propio en gentle-shell-desktop?" (answer: gathering stays here); "¿Cómo solventmos los glifos semánticos read/edit/memory/delegation/rdd que están implementados en gentle-shell?" (answer: publish the classification, render glyphs in the app); "profile-name es el nombre del perfil que el usuario tiene activo desde /gentle:profiles, no la identidad del usuario".

L3. Evidence gathered before this document, read-only: three separate glyph tables with no unified classifier; `worktree list --porcelain -z`, `diff --numstat HEAD` and `status --porcelain=v1 ... -z` behind an injected runner with pure parsers; `createActiveProfileReader` distinguishing global, bound, local and repo labels; `pi.getMcpStatus`/`onMcpStatusChanged` absent from the pi builds resolved here, with `getMcpServers()` covering extension registrations only; `mcp-status.md` already warning that config counts and `getAllTools()` are not health.

L4. Scope limit carried forward: this document adds read-only projections and one push event. It does not add MCP health, does not add a git writer, does not change the schema version and does not touch any method announced by slice 1.

L5. Requirement change, relayed by the desktop-side document owner, verbatim (it binds; S3, S4, S5, S6 and S9 were rewritten accordingly, S2 and S10 gained the consequences the decisions force, T0 was added, T2/T3/T4/T6 were reopened and repriced, and T1/T5 were repriced only):

"Decisiones

 1. Lector de mcp.json: extraer a lib/. Es la única opción que conserva el invariante. Aceptar una segunda lectura garantiza que el banner y el footer se contradigan algún
 día sin que nadie lo note, y ese es exactamente el fallo que el método debía evitar. Condiciones: la extracción es una unidad propia, con su commit solo, y una prueba de
 regresión que fije la salida del banner sin cambios. Consecuencia honesta: el documento deja de ser "puramente aditivo" y su S2 lo tiene que decir. Reprecio: la extracción
 es T0, T2 depende de ella.

 2. Enmienda del documento: autorizada, con las reglas de siempre: L5 con esta evidencia verbatim, reescritura solo de S3, S4, S5, S6, S9, y reapertura solo de las tareas
 afectadas (T0 nueva, T2, T3, T4, T6). T1 y T5 solo se reprecian, no se reescriben.

 3. Topología: rama de feature desde develop, no sobre develop. El tracker padre (desktop-rpc.md S11) ya estableció cadena tracker + slices con commits locales, y cinco
 métodos más un evento más cuatro bloques de límites más capabilities en dos puntos no son un slice. feat/desktop-rpc-additive-methods está bien como nombre.

 Lo que agrego a sus correcciones

 Cinco precisiones que la reescritura debe incorporar para que quede probable, no solo reescrita:

 - S3: usar las formas reales. WorktreeChanges es {root, branch?, model} y las cifras viven en model.added / model.deleted junto con digest y countsUnavailable. El tracker
   recibe dos runners (discover y gitForRoot): la prueba de read-only debe falsificar ambos, no uno. Y failedRoots / unbornRoots entran en el contrato, no en el olvido.
 - S5/T3: la autoridad del spelling es sessionProfileLabel en lib/session-profile-freeze.ts, no el reader. Y la prueba de aceptación que decide si el método existe: con un
   perfil bound, la respuesta debe diferir de get_config{store:"profiles"}.active. Si no difiere, T3 se elimina en lugar de entregarse como duplicado decorativo.
 - T4: acepto la inversión de dependencia (tablas a lib/, tres módulos las consumen). Pero eso agrega un riesgo que el informe no nombra: mueve código que el render de la
   TUI ya usa. Es item 3 por mi propia regla, y exige una prueba de regresión que fije las tres renderizaciones actuales sin cambios, además de la prueba del vocabulario
   publicado.
 - S6: elimino memory del enum de categorías. La prueba certifica su ausencia, no la inventa; se agrega el día que un proveedor la publique.
 - S9: corrigo la convención (secciones ## <Dominio> limits por dominio con anclas desde capabilities, no una por método) y los dos puntos de refresh de capabilities con
   sus assert.deepEqual estrictos. Y las aserciones de MCP van en archivo propio —sin URLs, sin env, health siempre "unknown"— no colgadas del test de seguridad. T6 queda
   repreciada.

 Confirma los riesgos declarados: item 3 para session_state_changed y ahora también para el movimiento del vocabulario; item 4 para trabajo con owners compartidos; item 1
 ausente y correcto, porque nada escribe datos almacenados.

 Lo que ya cambié de mi lado

 2b3c524 en este repo: dos reglas de honestidad en el footer, consecuencia directa de lo que la sesión de gentle-pi encontró.

 - Los conteos de worktree se renderizan solo si el hijo los entrega: countsUnavailable o un root fallido/unborn se etiquetan, nunca se muestran como cero archivos o cero
   líneas.
 - El perfil muestra la etiqueta que la sesión resolvió y debe ser distinguible del active global.

 Así el lado app ya espera esos estados en vez de descubrirlos al implementar. Ninguno de mis documentos cita números S# del documento de gentle-pi, así que su reescritura
 no rompe enlaces de este lado."

Evidence for L5, gathered read-only in this repository before the rewrite (path:line): `lib/shell-changes.ts:216,221-225,272-334`; `lib/desktop-rpc-config.ts:237-246`; `lib/desktop-rpc-profiles.ts:12,152`; `extensions/startup-banner.ts:723-730`; `extensions/gentle-shell.ts:216-289`; `lib/session-profile-freeze.ts` via `extensions/gentle-shell.ts:15,259`; `extensions/quiet-tools.ts:44-52`; `extensions/gentle-agents.ts:533-552`; `lib/gentle-ai-renderer.ts:68-75`; `extensions/gentle-ai.ts:2286`; `extensions/gentle-desktop-rpc.ts:78`; `lib/desktop-rpc.ts:148,173`; `docs/desktop-rpc.md:60-62,839-905,972,1139-1212,1213-1226`; `docs/mcp-status.md:11`; `tests/maintainer/desktop-rpc.maintest.ts:183-184`; `tests/desktop-rpc-safety.test.ts:47-140`; pi `1.4.0` `dist/core/extensions/types.d.ts:1391-1392` and absent `getMcpStatus` in `dist`.

L6. T0 review receipt, from the native gate (the revision hash stays in the native record; it is not retyped here):

```text
state: approved
lineage_id: review-be4ae50e320b1882
target_identity: sha256:0c75321e43627cf77d537e7a2d56c7ec3c4d4e5a4fd17bc8c8f3eae936aa881f
risk_tier: medium
selected_lenses: ["review-reliability"]
changed_files: 4
original_changed_lines: 252
correction_budget: 126 (untouched: no correction was opened)
authority: burned (gentle-ai.review-acknowledged/v1)
delivery: ordinary-repository-policy
```

One model run, `opencode-go/deepseek-v4.1-flash`, 196 s, 43 925 tokens. Two advisory findings, recorded with the gate's own statement, verbatim: "This review is approved and its receipt stands. Every finding listed here is non-blocking: none opened a correction, none reopens this review, and no correction transition is offered for this candidate. Treat them as separate later work, never as a reason to re-run review on this candidate."

- R3-001 | reliability | WARNING | `lib/mcp-config.ts:27-28` | informational
- R3-002 | reliability | SUGGESTION | `tests/mcp-config.test.ts:38-51` | informational

Follow-up ownership, so neither finding is lost and neither reopens T0: R3-001 is that a failed or malformed `mcp.json` reads as no servers with no signal, which belongs to T2 because T2 must already distinguish an absent config from an unusable one; R3-002 is that the two structural invariants scan the source with regular expressions, which is recorded here and not scheduled, with the condition that the single-reader invariant must keep some enforcing check if it is ever rewritten. Neither finding authorizes a fresh review of this candidate.
