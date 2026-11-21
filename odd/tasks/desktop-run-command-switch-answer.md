# desktop-run-command-switch-answer

Corrige la respuesta de un `run_command` que reemplaza la sesión (`new`, `resume`): hoy esa
respuesta nunca se publica, y la petición que la provocó se queda sin contestación.

## Specs

S1 — Un `run_command` cuyo nombre reemplaza la sesión (`new`, `resume`) responde **exactamente
una vez**, desde la sesión de reemplazo, con `{"executed": true}` y correlacionado por el
`requestId` original, siempre que el reemplazo ocurra de verdad. Una ejecución cancelada, sin
capacidad en el host o que lanza antes del teardown responde `terminal_only`, como ya fija
`odd/tasks/desktop-run-command.md`. La petición que lo provocó no puede quedar sin respuesta ni
recibir dos.

S2 — La publicación desde el reemplazo usa la misma polaridad que `switch_session`
(`lib/desktop-sessions-service.ts`): se publica cuando la `generation` cambió, es decir cuando el
teardown de la sesión anterior ya corrió; no se publica cuando la generación no cambió ni cuando no
hay `requestId`.

S3 — Un `run_command` que no reemplaza la sesión conserva su comportamiento: responde por el
router, una sola vez, con el mismo resultado cerrado (`executed`, `terminal_only`,
`unknown_command`).

S4 — El mensaje que ve el usuario en la GUI (`gentle-shell is switching sessions right now — retry
/resume in a moment.`) queda reservado a las peticiones que de verdad llegan durante el cambio de
sesión. Con S1 cumplida, el `/resume` que la GUI dispara deja de producir ese mensaje.

## Tasks

| ID | Specs | Ruta | Commit |
| --- | --- | --- | --- |
| T1 | S1, S2, S3 | `lib/desktop-commands-service.ts` + RED/GREEN en `tests/desktop-rpc-commands.test.ts` | — |
| T2 | S1, S4 | sonda en vivo de `resume` y `new` con una petición de seguimiento en `tests/maintainer/desktop-rpc.maintest.ts` | — |
| T3 | S1, S4 | `extensions/gentle-desktop-rpc.ts`: el `requestId` del despacho se captura sincrónicamente en el dominio | — |
| T4 | S1, S3, S4 | `tests/desktop-rpc-command-switch.test.ts`: el reemplazo y la puerta a través del despacho real de la extensión | — |
| T5 | S1, S4 | sonda en vivo por comando ejecutable en `tests/maintainer/desktop-rpc.maintest.ts` (sin `reload`, que reemplaza el runtime y no es seguro de sondear dentro de la suite) | — |
| T6 | S1 | publicar la respuesta de `reload` antes de disparar la recarga (ver L10) | — |

## Log

L1 (petición original del dueño, verbatim):

> Tras los últimos cambios revisa todos los comandos que somos capaces de recuperar y cuales funcionan y cuales no y necesitan trabjo adicional. Por ejemplo antes /resume funcionaba correctamente y ahora la GUI devuelve este error "gentle-shell is switching sessions right now — retry /resume in a moment."

L2 (decisión del dueño, verbatim, sobre dónde arreglar):

> B: arreglar la causa raíz en el host

L3 (evidencia de la investigación, resumida): el `/resume` de la GUI entra por `run_command` y el
host ejecuta `ctx.switchSession(args)` (`lib/desktop-commands-service.ts`, `runResume`). La
secuencia real de pi está en `@earendil-works/pi-coding-agent/dist/core/agent-session-runtime.js`:
`switchSession` → `teardownCurrent` (que emite `session_shutdown` y por tanto `commands.reset()`,
`generation += 1`) → `createRuntime` (instancia de extensión nueva, con su `retiredPublish` vacío)
→ `finishSessionReplacement` (que recién ahí llama a `withSession`). `publishReplacement` captura la
`generation` del despacho y **no publica cuando cambió**, que es siempre; el resultado del router se
descarta porque `stop()` ya lo dio por contestado. Resultado: la petición que provocó el cambio no
recibe ninguna respuesta. El hermano probado hace lo contrario y es correcto:
`lib/desktop-sessions-service.ts` publica cuando la generación **cambió**, y
`tests/maintainer/desktop-rpc.maintest.ts` lo pina con `switch_session` contra pi instalado.

L4 (cobertura existente, resumida): `tests/desktop-rpc-commands.test.ts` asserta la publicación del
reemplazo, pero con un host falso que nunca dispara `session_shutdown`; por eso pasa con la
comparación invertida. `tests/maintainer/desktop-rpc.maintest.ts` ejecuta `run_command` en vivo solo
para `name`, `login` y nombres desconocidos: `resume` y `new` nunca se probaron contra pi instalado.

L5 (segunda causa, encontrada por la sonda en vivo de T2 con el arreglo de T1 ya aplicado): la sonda
reprodujo el mensaje exacto del dueño —`run_command {name:"resume"}` respondió
`{"ok":false,"error":{"code":"session_switching"}}`—. El `requestId` del despacho se lee de una
variable compartida (`dispatchingRequestId`) que el handler limpia en su `finally` apenas
`router.handle` devuelve la promesa, y el slice de comandos se consulta al final de una cadena que ya
hizo `await` de otros bridges: recibía `null`. Con `requestId` nulo, `abandonPending` no exceptúa la
propia petición y la responde `session_switching`, y `publishReplacement` no publica nunca. El slice
de sesiones no cae en esto porque lee el binding de forma sincrónica, en la primera línea del dominio.
T3 captura el valor en la primera línea del dominio, igual que el slice de sesiones.

L6 (verificación final, con T1+T3 aplicados): unidad enfocada `tests/desktop-rpc-commands.test.ts` +
`tests/desktop-rpc.test.ts` + `tests/desktop-rpc-sessions.test.ts` 58/58;
`tests/maintainer/desktop-rpc.maintest.ts` 15/15 contra pi instalado, con la sonda de T2 verde (un
`executed: true` para `resume` y otro para `new`, `get_snapshot` posterior servido con `sequence: 0`,
cero `session_switching` en el cable, una respuesta por `requestId`) y las tres sondas de carrera del
cambio de sesión intactas. El único fallo del foco unitario (`desktop-feed.test.ts`, "S2: desktop RPC
jobs answers and events are byte-identical with the feed loaded") y el de la suite completa de
maintainer (`provider-relay.maintest.ts:386`) se reproducen idénticos en un worktree en HEAD,
así que son preexistentes. Typecheck: los mismos 3 diagnósticos ya registrados en L4, ninguno nuevo.
Nothing is committed.

L7 (revisión independiente y cierre del hueco de cobertura): el verificador independiente dio
**PASS** sobre T1+T3, con tres avisos. (a) Un reemplazo que falla *después* del teardown responde
cero veces: preexistente (idéntico con la comparación anterior) y con la misma forma que el hermano
`switch_session`; queda como follow-up, fuera de este cambio. (b) La captura del `requestId` (T3) no
tenía test unitario, solo la sonda en vivo. (c) La S1 no distinguía "reemplazo real" de los rechazos.
Se abrió T4 (`tests/desktop-rpc-command-switch.test.ts`, dos casos sobre el despacho real de la
extensión: el reemplazo responde una vez tras el teardown, y la puerta rechaza solo lo que llega
durante el cambio) y se corrigió la redacción de S1. Causa probada en ambas direcciones: los dos casos
de T4 fallan en un worktree en HEAD con el mensaje exacto del dueño
(`{"ok":false,"error":{"code":"session_switching"}}`) y pasan con el arreglo.

L8 (T5, tabla por comando contra pi instalado): sonda nueva que recorre cada nombre ejecutable alcanzable
por el escritorio sin `args`. Respuestas reales observadas: `compact` → `executed: true`; `name` →
`terminal_only`; `model` → `terminal_only`; `thinking` → `terminal_only`; `thinking` con `args:"low"` →
`executed: true`; `fork` → `terminal_only`; `scoped-models` → `terminal_only`; `resume` con un path
inexistente → `terminal_only`, sin throw y sin eco del path en el cable. Una respuesta por `requestId`,
cero eventos, salida limpia; el archivo de maintainer queda en 16/16. `reload` sigue sin sondearse:
reemplaza el runtime dentro del hijo y puede colgar la suite, así que queda **sin verificar**.
Consecuencia para el cliente: `name`, `model` y `thinking` son ejecutables en el catálogo pero
inutilizables desde la paleta, porque el cliente no envía `args` y el host los rechaza como
`terminal_only`; hace falta una superficie de argumentos (decisión del dueño, fuera de esta unidad).

L9 (T5bis, `reload` sondeado en un entorno aislado): con una sonda acotada por timeout y una copia del
repo en `/tmp`, `run_command {name:"reload"}` **no responde nada** — sin respuesta en 8 s — y el cable
solo lleva la respuesta del `get_snapshot` posterior, que sí llega (`sequence: 0`, router nuevo), con el
hijo cerrando en status 0. Esto contradice L4(3): la respuesta no se publica antes del reemplazo, se
pierde con el router que la recarga reemplaza, porque `ctx.reload()` no ofrece `withSession`. Efecto en
el cliente: `PiSession.runCommand` espera para siempre y la línea de estado nunca se asienta. Es la
misma clase de defecto que T1/T3 con `new`/`resume`, y queda como T6, sin implementar hasta que el dueño
decida.

L10 (T6 entregado, con corrección de contrato): el dueño eligió «Arreglar `reload` primero». Implementado:
`runReload` mantiene la comprobación sincrónica de capacidad y el conjunto cerrado de respuestas, y mueve
solo la invocación de `reload()` a un macrotask envuelto, para que la respuesta cruce el cable antes de
que la recarga reemplace el router que la publicaría. Evidencia: el test de despacho real de la extensión
observó RED (cero respuestas, el fallo de L9) y quedó verde; unidad 22/22 y 3/3, router y sesiones 37/37, y
la sonda por comando ahora incluye `reload` en vivo (archivo de maintainer 16/16) con una sola respuesta,
`executed: true` y un `get_snapshot` posterior servido con `sequence: 0`. El verificador independiente dio
FAIL por honestidad de la respuesta: con el arreglo, un `reload` que lanza antes de nada responde
`executed`, mientras el contrato escrito (`docs/desktop-rpc.md`, cabecera del módulo) decía que un fallo
responde `terminal_only`. Se resolvió como reconciliación explícita y no como silencio: la fila de `reload`
y los límites de Commands en `docs/desktop-rpc.md` más la cabecera del módulo dicen ahora que en `reload`
`executed` significa «recarga programada», que un fallo posterior no se retrae y que la falta de capacidad
sigue siendo `terminal_only`, y el test que lo pina cita ese contrato. Aviso abierto y aceptado: el
macrotask no se cancela en `reset()`, así que en una carrera de cierre la recarga puede ejecutarse sobre un
contexto ya viejo o perderse; no es alcanzable en un viaje de ida y vuelta normal.
