# Comandos ejecutables por el desktop

Contrato aditivo en `get_snapshot.commands` (`runnable`) más un método `run_command`, para que un cliente GUI pinte y ejecute el catálogo completo de pi sin mantener nombres propios.

## Specs

S1 — El catálogo es del host. `get_snapshot` sección `commands` sigue siendo la única fuente de comandos de un chat: builtins de pi, comandos de extensión, plantillas de prompt y skills. El cliente no mantiene listas ni réplicas.

S2 — Cada ítem del catálogo declara si el cliente puede ejecutarlo. Forma (aditiva, un campo nuevo por ítem):

```
commands: {
  items: [{ name, description, args, terminal, source, runnable }],
  truncated: boolean
}
```

`source` sigue siendo `"builtin" | "extension" | "prompt" | "skill"`. `runnable: true` significa exactamente: "el cliente puede llamar a `run_command` con este `name` (más `args` cuando la entrada los documente) y obtener `executed: true`". Es un hecho declarado por el host, nunca inferido por el cliente desde `source`.

S3 — Método `run_command`. Petición `{ name: string, args?: string }`. Respuestas:

```
{ executed: true }
{ executed: false, reason: "terminal_only" | "unknown_command" }
```

`reason` es un conjunto cerrado de dos valores. `terminal_only` = el comando existe pero su ejecución vive en la TUI de pi; `unknown_command` = el nombre no está en el catálogo del host.

S4 — Mapeo de ejecución del host. El host ejecuta con la autoridad de `ExtensionCommandContext` y de la API de extensión, nunca con texto hacia el modelo:

| comando | ejecución |
| --- | --- |
| `new` | `ctx.newSession()` |
| `resume` | `ctx.switchSession(path)` con el `args` recibido |
| `compact` | `ctx.compact(...)` |
| `reload` | `ctx.reload()` |
| `model`, `thinking` | `pi.setModel` / `pi.setThinkingLevel` según `args` |
| `name` | `pi.setSessionName(args)` |
| resto de builtins (`settings`, `hotkeys`, `changelog`, `copy`, `share`, `bug`, `trust`, `quit`, `login`, `logout`, `import`, `export`, `tree`, `fork`, `clone`, `session`, `scoped-models`) | `runnable: false`, responden `terminal_only` |
| comandos de extensión y prompt/skill | `runnable: false`, responden `terminal_only` |

S4a — `scoped-models` NO es ejecutable. pi lo expone únicamente como la instantánea de solo lectura `ctx.scopedModels`, sin API para cambiar el alcance de modelos, así que se declara `runnable: false` y responde `terminal_only`. Declararlo ejecutable sería una promesa que el host no puede cumplir (corrección de la v1 de esta spec, ver L5).

S5 — El cliente no inventa comandos. `/new` y `/resume` dejan de existir como entradas propias del cliente: llegan desde el catálogo y se ejecutan por `run_command`. El cliente solo conserva su flujo de selección de sesión (lista y elige), aportando el `path` como `args`.

S6 — Compatibilidad. Un cliente que ignore `runnable` sigue funcionando: la sección conserva sus campos actuales, el recorte a 200 y `truncated`. `capabilities.methods` anuncia `run_command`, y el cliente lo consulta antes de usarlo como ya hace con el resto.

## Tasks

| ID | Specs | Ruta | Commit |
| --- | --- | --- | --- |
| T1 | S1, S2, S6 | `runnable` en el catálogo (`lib/desktop-feed.ts`) + `docs/desktop-feed.md` + tests | — |
| T2 | S3, S4, S6 | Método `run_command` (`lib/desktop-rpc-commands.ts`, `lib/desktop-commands-service.ts`, dispatch en `extensions/gentle-desktop-rpc.ts`) + `docs/desktop-rpc.md` + tests | — |
| T3 | S5 | Consumo en `../gentle-shell-desktop` (documento propio allí) | — |

## Log

L1 (petición original, verbatim):

> En la lista de comandos ofrecidos por el spotlight no veo que se estén listando absolutamente todos. Por ejemplo me falta el comando /new para iniciar una nueva sesión de chat y otros comandos como /gentle:profiles no hacen nada

> Haz una investigación profunda para analizar cuál es la mejor solución. Tocar una aplicaciónde terceros que no controlamos nosotros como pi es una opción que ni siquiera considero porque no tiene sentido. La solución para mi pasa por utilizar el canal rpc ya implementado en ../gentle-pi pero quiero validarlo

L2 (decisión del dueño, verbatim):

> 1. ¿Confirmas esta forma de contrato para gentle-pi? — Sí: runnable + run_command
> 2. ¿Hasta dónde puedo escribir en ../gentle-pi? — Sí, contrato y ejecución allí

L3 (evidencia de la investigación previa, resumida): `lib/desktop-feed.ts:299-302` ya publica `{name, description, args, terminal, source}` para 23 builtins (`:78-102`, sin `/quit`) fusionados con `pi.getCommands()` (`shapeCommands:594-607`), con guarda anti-deriva en `tests/desktop-feed.test.ts:506-511`. Precedente de ejecución desde extensión: `lib/desktop-sessions-service.ts:48,223` (`host.switchSession`). pi no expone login/logout, import/export ni `getSessionStats` a extensiones, de ahí que S4 los marque `runnable: false`. Punto abierto: `/resume` requiere que el cliente aporte el `path`; si en la práctica necesita un tercer `reason`, se abre como cambio de spec, no se implementa por iniciativa.

L5 (corrección de spec, decidida por el orquestador con evidencia del worker): `scoped-models` pasa de ejecutable a `runnable: false` (nueva S4a). La v1 de S4 lo agrupaba con `model` y `thinking`, pero pi solo ofrece el alcance de modelos como instantánea de solo lectura `ctx.scopedModels`, sin API para cambiarlo: el host no podía cumplir `executed: true`. Se prefiere una lista de ejecutables más corta y verdadera a una promesa rota. Lado cerrado: los tests de `capabilities` que fijan la lista de métodos por `deepEqual` en seis archivos fuera de la superficie de edición del worker se autorizan como actualización de una línea cada uno (`run_command` añadido), porque el contrato cambió y fijarlo es parte del cambio, no alcance nuevo.
L4 (T1+T2 implemented; nothing committed). Implemented: (a) T1 — `runnable` on every `commands` item of the feed snapshot (`lib/desktop-feed.ts`: builtin table entries, the `DesktopFeedSnapshot` wire type, and `shapeCommands` registry entries all get `runnable: false`), true for exactly `new`, `resume`, `compact`, `reload`, `model`, `thinking`, `scoped-models`, `name`; `HIDDEN_COMMANDS` exported for reuse; documented in `docs/desktop-feed.md` including the "client can call `run_command` and expect `executed: true`" meaning and that it is not derivable from `source` or `terminal`. (b) T2 — new contract module `lib/desktop-rpc-commands.ts` (method/event lists, closed `{executed}` result type, param parser) and new bridge `lib/desktop-commands-service.ts` (S4 execution mapping: `new`→`ctx.newSession`, `resume`→`ctx.switchSession(args)` (missing/empty `args` is `terminal_only`), `compact`→`ctx.compact()`, `reload`→`ctx.reload()` un-awaited, `model`→`pi.setModel` after registry resolution of a `provider/id` or bare `id`, `thinking`→`pi.setThinkingLevel` (levels reused from `lib/model-routing-authority.ts`), `name`→`pi.setSessionName`; every other catalog name → `terminal_only`; absent from catalog → `unknown_command`; every capability checked before use, catalog names never throw); `extensions/gentle-desktop-rpc.ts` dispatches it with the `requestId`, folds its in-flight token into the `session_switching` gate and the shutdown `abandonPending` keep-rule, and advertises `run_command` through the derived capabilities list; docs section + Commands limits added to `docs/desktop-rpc.md`. (c) Tests: new `tests/desktop-rpc-commands.test.ts` (25 tests: contract, every S4 row, unknown/terminal refusals, missing-args `resume`, missing capabilities degrade to `terminal_only`, throwing capabilities, cancelled replacement, in-flight exposure); `tests/desktop-feed.test.ts` runnable pinning + updated wire-shape deepEquals; `tests/desktop-rpc.test.ts` and `tests/maintainer/desktop-rpc.maintest.ts` capabilities lists updated plus one live probe (`run_command` answers `unknown_command` for an unknown name, `terminal_only` for `login`, and executes `name` through the real runtime with `executed: true`). Observed RED→GREEN: RED 1 module-not-found for `lib/desktop-rpc-commands.ts`; RED 2 feed runnable list empty before implementation; GREEN 30/30 focused (commands + capabilities), feed 20/21 with the one failure (`S2: desktop RPC jobs answers and events are byte-identical`) proven pre-existing by rerunning HEAD in a scratch copy; maintainer suite 14/14. Full suite (`pnpm test`): provider-contract and runtime-harness PASS; unit stage 11 500 tests / 35 fail — 29 failures proven pre-existing by name-matching a HEAD scratch run, and 6 capabilities-pinning tests in files OUTSIDE this task's allowed edit surfaces (`tests/desktop-rpc-{agents,config,design,jobs,permissions,usage}.test.ts`, one deepEqual each) now fail solely on the missing `run_command` entry; they need the parent to add those files to the edit surfaces. Typecheck: the ratchet reports 3 diagnostics, all proven pre-existing at HEAD (peer-dependency type drift in files this task never touched); this change adds none. Open items: (1) the six capabilities-pinning test files above need one-line updates; (2) spec tension recorded, not resolved: S2 says `runnable: true` means the client can expect `executed: true`, but pi exposes scoped models only as the read-only `ctx.scopedModels` snapshot, so `run_command` answers `terminal_only` for `scoped-models` while the catalog still declares it `runnable: true` (both sides were pinned verbatim by T1/T2; documented in `docs/desktop-rpc.md` under `run_command`); (3) `reload`'s answer is published before the runtime replacement because pi offers no `withSession` on `ctx.reload()`; (4) a scratch HEAD copy remains at `/tmp/gpOsU8qj/gaB8vLzu/tmp.jFAu7iJe3n` (scratch removal was blocked by the child safety guard; parent may delete it).
L6 (final, after the parent's authorization of L4's open items and S4a): S4a applied — `scoped-models` is now `runnable: false` in `lib/desktop-feed.ts` (the runnable list is exactly `new`, `resume`, `compact`, `reload`, `model`, `thinking`, `name`), the commands bridge states the contract instead of a gap, and `docs/desktop-feed.md`/`docs/desktop-rpc.md`/`tests/desktop-feed.test.ts`/`tests/desktop-rpc-commands.test.ts` were updated to the S4a wording. The six capabilities-pinning tests were updated under the parent's explicit one-line authorization (`run_command` appended to each methods `deepEqual`): `tests/desktop-rpc-{agents,config,design,jobs,permissions,usage}.test.ts`. Final numbers: focused `tests/desktop-rpc-commands.test.ts` + `tests/desktop-rpc.test.ts` + `tests/desktop-feed.test.ts` 50/51 with the single failure being the pre-existing `S2: desktop RPC jobs answers and events are byte-identical`; the six updated files together 202/202; `tests/maintainer/desktop-rpc.maintest.ts` 14/14 (the live `run_command` probe still executes `name` with `executed: true`); full unit stage 11 500 tests / 28 fail, every one name-matched against the HEAD scratch run (0 new); `pnpm test` stages provider-contract and runtime-harness PASS; typecheck ratchet reports exactly the same 3 diagnostics proven pre-existing at HEAD (none introduced). Scratch note: the deletion of `/tmp/gpOsU8qj/gaB8vLzu/tmp.jFAu7iJe3n` was blocked again by the child safety guard even with the parent's authorization; the parent still needs to remove it. Nothing is committed.
