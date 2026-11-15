# Desktop GUI parity — host channels the Desktop app still needs

Single host-side index for `../gentle-shell-desktop`. Companion app index: `gentle-shell-desktop` `odd/plans/pending-work.md`.
Documentation only: this authorizes no code, no publication and no review.

## Specs

S1. Owner scope rule (verbatim): "Toda la información que podamos obtener del estado actual de gentle-shell extendiendo el canal RPC y que necesite la GUI se implementa" and "no quiero agregar funcionalidades nuevas a este repo solo quiero implementar las comunicaciones pertinentes, RPC u otras, para que la GUI sea plenamente funcional".
The adapter/feature line is the one this document enforces: a new **read** method or an added field over an owner that already computes the value is an adaptation (allowed); anything that creates state, persistence, a file protocol, a watcher, a policy or a new owner is a new feature (S9, out of scope).

S2. Document ownership (verbatim, carried from `odd/tasks/desktop-rpc-client-gaps.md` S1): "la documentació odd que afecte a gentle-shell debe vivir en ../gentle-pi y se trabajará con una sesión en su propio repo". Every host-side need the app records must land here, not in the app repository.

S3. Inherited specs still bind: `odd/tasks/desktop-rpc.md` S2 (public extension API only; no fork, no `node_modules` edit), S4 (reuse existing owners; never a parallel store, fetcher, registry or process manager), S6 (no credentials, tokens, arbitrary paths or raw provider errors), S11 (local work-unit commits only). `odd/tasks/desktop-rpc-client-gaps.md` S9 defines the documentation and verification convention this document reuses.

S4. Slash-command catalog — **no host work established**. pi's RPC mode already answers `get_commands` (`node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js`), so the composer's `/` menu is app-side work. T4 is a read-only probe of the real child to confirm the answer includes extension-registered commands (`/gentle:*`). Only if the probe proves them absent does a host method become necessary, and then it is additive and bounded. The app must never keep a hardcoded replica of `/gentle:*`.

S5. Changes/diff — **files and counts only are in scope for v1**. `get_worktree_changes` already publishes `branch`, `model.added`/`model.deleted`, per-file counts, `countsUnavailable`, `failedRoots` and `unbornRoots`. Patch text is **not** published anywhere, and adding it would be a new method over data no owner produces today: it is a new feature and stays out until the owner asks for it explicitly. The app renders files and counts and must never spawn git itself. The rendering decision for an unmeasured root lives on the app side and is recorded there (`gentle-shell-desktop` `desktop-rpc-client.md` L33): the footer renders zeros rather than a label, while this host keeps `failedRoots`, `unbornRoots` and `countsUnavailable` in the payload untouched. No host change follows from it.

S6. Review/RDD — **v2** by owner decision (Log L2.4). When scheduled, the host must read the review switch and lineage through the existing owner. An Electron review engine, an app-owned switch or a synthetic consent route is forbidden regardless of schedule.

S7. ODD phase — **v1**, and it is the only new field v1 requires. Project the value `lib/odd-phase.ts` already computes into the existing `session_state_changed` as `oddPhase`, omitted when unknown, cleared by omission, never inferred from transcript text or from a tool name.

S8. Honesty rules for every added field and list: availability per field (omit when the owner answers nothing, keep an owner-reported `0`); every list bounded at the source with `truncated: true` beside it; an unavailable capability carries a `reason` string so an empty panel is distinguishable from a missing channel.

S9. Explicitly out of scope — new features, declined by the owner's rule even where the reference PR ships them: snapshot feed / file publisher, action inbox-outbox, desktop-folder guard, Herdr installer, layout, keys and mods, `ancestors` pid chain, roots registry, durable outbox with dedupe, JSONL offset reading, a session-identity method (the app's workspaces are user folders chosen in the GUI, not `~/.pi/agent` or `~/.gentle-shell/agent`), diff/patch text, persona (no such store in `DESKTOP_CONFIG_STORES`; it lives privately in `extensions/gentle-ai.ts`), extension installation, provider authentication and cross-process session ownership.

S10. Verification per task, reusing `desktop-rpc-client-gaps.md` S9: the method or field appears in `capabilities` in **both** documented places plus the maintainer probe under strict `assert.deepEqual`; a `## <Domain> limits` section carries the bounds; a new field pins its own omission case, not only its populated case.

S11. Risk: item 3 for S7 (a field on an event every client consumes, and the TUI's own shell state must not change) and for S8 wherever an announced payload gains a key; item 4 for any read that runs concurrently with the agent's owners; item 1 is absent because nothing here writes stored data.

## Tasks

| ID | Specs | Slice | State | Route | Commit |
| --- | --- | --- | --- | --- | --- |
| T1 | S8, S10, S11 | bounds + `truncated` in `list_subagents`, `list_jobs`, `get_worktree_changes`, `tool_vocabulary`: per-list maxima, text clipping, `truncated: true` beside every clipped array, one `limits` section per touched domain | pending | inline, own commit | — |
| T2 | S7, S10, S11 | `oddPhase` inside `session_state_changed`: project `lib/odd-phase.ts`, omit when unknown, event table row, payload example, `## Session state limits` row, omission test | pending | inline, own commit (item 3) | — |
| T3 | S8, S10 | availability reasons: generalize the `permission_unavailable` pattern to `usage_unavailable`, `agents_unavailable`, `worktree_unavailable` with a `reason`; no panel may show an empty success | pending | inline, own commit | — |
| T4 | S4, S10 | read-only probe: capture a real child's `get_commands` answer and record whether extension commands (`/gentle:*`) appear. Evidence only; no code. If they are absent, this task is replaced by an additive `get_commands`-shaped method, specified here before implementation | pending | inline, evidence in this document's Log | — |
| T5 | S6, S10, S11 | review/RDD read: switch state and lineage through the existing owner, availability preserved | deferred (v2) | — | — |

Nothing above is scheduled until the owner asks for it; T1–T3 are independent and each fits one commit.

## Log

L1. Original owner request (verbatim): "IMPORTANTE tú no implementas nada en ningun repo solo tienes que que trabajar con la documentación odd, revisar lo implementado, lo pendiente y homogeneizar la documentación de ambos repos para que otros agentes hagan las implementaciones, deja todo centralizado y acotado porque por ejemplo en ../gentle-shell-desktop creo que hay varias implementaciones todavía pendienes repartidos en varios documentos y se pierde el orden de trabajo y la trazabilidad de lo pendiente".

L2. Scope decisions taken by the same owner in the same exchange (verbatim except where marked):
1. "A día de hoy no quiero agregar funcionaliades nuevas a este repo solo quiero implementar las comunicaciones pertinentes, RPC u otras, para que la GUI sea plenamente funcional".
2. "Toda la información que podamos obtener del estado actual de gentle-shell extendiendo el canal RPC y que necesite la GUI se implementa".
3. Changes/diff: "en el punto 5 changes/diff está implementado actualmente en gentle-shell y lo necesita la GUI" — files and counts are in v1; patch text is constrained by S5.
4. "Review/RDD si puede quedar para v2".
5. "el punto 6 también está implementado e gentle-shell y seguramente lo necesite la GUI" — statuses and notifications are already published through pi's `setStatus`/`notify` (app T2a/T2b); persona has no owner to read (S9).
6. "el punto 7 los comandos con / tanto de gentle-shell como de pi también los necesitará gentle-shell-desktop ¿sino en el chat de la GUI como se listan los comandos cuando el usuario escriba una / en el chat?" — answered by S4.
7. "el indicador de fase de ODD entra en v1" — S7.
8. "la GUI muestra paths que representan carpetas "espacios de trabajo" del usuario en su equipo, nada tiene que ver con las rutas ~/.pi/agent o ~/.gentle-shell/agent" — no identity method is needed; the earlier proposal is withdrawn.
9. "entiendo que el proveedor de modelos no debería pedir que acepte nada y solo debería recibir autorizaciones de mantenimiento, tal como sucede actualmente en gentle-shell en este repo" — the provider-consent distinction is withdrawn; a maintenance authorization is the only high-authority prompt the GUI answers, rendered with its exact emitted text, no default choice, one use.
10. "IMPORTANTE, recuerda que las ramas actuales de trabajo de ambos repositorios son develop".

L3. Evidence gathered read-only before writing this document (path:line):
- `node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js` answers `get_commands` (S4). Not captured from a live child yet: that is T4.
- `lib/desktop-rpc-config.ts:52,121` — `DESKTOP_CONFIG_STORES` and `AUTHORITATIVE_STORES` (`profiles`, `profile_fallbacks`, `pins`) carry no persona store.
- `lib/desktop-rpc-worktree.ts` — `get_worktree_changes` is the only changes surface; no diff text.
- `lib/desktop-rpc-session-state.ts` — `session_state_changed` payload is model, thinkingLevel, context, cost, all per-field optional; `odd-phase.ts` is not projected.
- `lib/desktop-rpc-agents.ts`, `lib/desktop-rpc-jobs.ts`, `lib/desktop-rpc-tools.ts` — list answers carry no bound and no `truncated`.
- `docs/desktop-rpc.md` — the protocol reference that T1–T3 must update, not replace.

L4. Reference PR #3277 (`feat/herdr-gentle-shell`) was analysed and is **not** adopted as a source of contract: its file feed, action inbox, folder guard and Herdr mods all fall under S9. Two of its ideas survive as rules rather than code: `truncated`/bounded-at-source (S8, T1) and the bounded-snapshot discipline already present in our events. Its `ancestors` identity and JSONL offset reading are declined for the reasons in S9.

L5. Consolidation: the app-side backlog is now one document (`gentle-shell-desktop` `odd/plans/pending-work.md`); this document is its only host dependency. `desktop-ade-deferred-contracts.md` keeps only capability history and points here for anything that requires a host change.

L6. App-side rendering decision recorded for coherence, no host work implied (owner, verbatim): "0 files · +0/-0 también en la raíz fallida, no omitimos el grupo". The footer now renders zeros for a failed, unborn or partial answer instead of a label or an omitted group, so `desktop-rpc-client.md` T8b's "never as zero" criterion is superseded there by L33. What S5 still guarantees here: the payload keeps `failedRoots`, `unbornRoots`, per-file `countsUnavailable` and the file paths, so the distinction is unrendered rather than destroyed, and the app may surface it through `title`/`aria-label` without a contract change. Read this entry before proposing a host change to satisfy that rendering.
