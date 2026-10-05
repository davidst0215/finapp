# SPEC · claude-code v2 (responder desde el celular + lanzar tareas)

Extiende el módulo `claude-code` (008). Todo va laptop <-> `claude-events` <-> celular; nada pasa por claude.ai.

## Objetivo
1. **Responderle a una sesión**: David escribe en la app; el hook Stop de la laptop entrega el texto y Claude sigue trabajando.
2. **Lanzar tareas**: David elige un proyecto y escribe un prompt; un programa local (`wabid-runner.mjs`) corre `claude -p` en esa carpeta y reporta avance y resultado.

## Formatos verificados (docs oficiales, 2026-10-05)
Fuente: https://code.claude.com/docs/en/hooks (secciones Stop, PermissionRequest, hook handler fields), /headless, /cli-reference, /agent-sdk/typescript (SDKResultMessage).
- **Stop, entrada**: `stop_hook_active` (true si Claude ya continúa por un stop hook), `last_assistant_message`. Tope oficial: 8 continuaciones seguidas sin llamar herramientas (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`).
- **Stop, salida para seguir trabajando**: exit 0 y stdout `{"decision":"block","reason":"<texto>"}`. Sin `decision` Claude termina.
- **Hook handler**: `timeout` en segundos (defecto 600); `async: true` corre en segundo plano y NO puede devolver decisiones. Por eso Stop pasa a síncrono con `timeout: 900`.
- **`claude -p`**: `--output-format stream-json --verbose` emite una línea JSON por evento: `system/init` (con `session_id`), `assistant` (`message.content[]` con bloques `text` / `tool_use`), `result` (`subtype`, `is_error`, `result`, `session_id`, `permission_denials`). `--permission-mode default|acceptEdits|plan|auto|dontAsk|bypassPermissions`; sin flag un `-p` puede arrancar en `auto`, así que se fija `default`. `--permission-prompts none` (v2.1.259+): lo que pediría permiso se deniega y Claude sabe que no debe reintentar. `--session-id <uuid>`.
- **Permisos en `-p`**: los hooks `PermissionRequest` SÍ corren en `-p` ("Claude Code still runs these hooks, and if no hook returns a decision, it denies the tool call"). Se reutiliza el flujo existente (tarjeta en el celular). Sin modo ausente, sin respuesta o vencido: **se deniega**.
- SIGTERM sobre `claude -p` termina el turno sin resultado (exit 143).

## Contrato (edge function `claude-events`)
Dispositivo (token `x-wabid-device-token`):
- `POST /device/events` (tipo `stop`) ahora responde `{ok, away}` (`away` = modo ausente).
- `POST /device/sessions/:id/messages/next` -> `{message: {id, text}|null, away}`. Fase 1 de la entrega: reclamo atómico (en_cola -> entregando); la sesión debe ser del dispositivo.
- `POST /device/messages/:id/ack` -> `{ok}`. Fase 2: el hook ya escribió stdout; entregando -> entregado y se borra el texto. Sin ack en 60 s el mensaje vuelve a la cola.
- `POST /device/tasks/next` body `{projects: [nombres]}` -> `{task: {id, project, prompt}|null}`; registra los nombres (no rutas) y `runner_seen_at`.
- `POST /device/tasks/:id/events` body `{type: start|progress|finish, ...}` -> `{ok, cancel_requested}`.
App (JWT; las rutas de escritura exigen además `user.id == WABID_OWNER_ID`):
- `POST /ui/sessions/:id/messages {text}` (<= 2000) · `POST /ui/tasks {project, prompt}` (<= 4000) · `POST /ui/tasks/:id/cancel`.
- `GET /ui/overview` suma `messages` (sin texto), `tasks`, y `runner` por dispositivo.

## Seguridad
- Crear mensajes/tareas = ejecutar cosas en la laptop: solo el dueño (`WABID_OWNER_ID`; sin configurar = 503, falla cerrado). Inserts solo desde la función; RLS solo-lectura; el texto del mensaje no tiene permiso de lectura por columna para `authenticated`.
- **Mensaje**: el texto vive solo hasta la confirmación (`en_cola`/`entregando`, CHECK en la base); se borra al confirmar la entrega o al vencer (6 h). Justificación: tras la entrega el texto ya está en la transcripción local de Claude Code; no hay razón para guardarlo en la nube. La fila (sin texto) se poda a los 7 días. Nunca se loguea el texto.
- **Reclamo atómico**: `UPDATE ... WHERE status='en_cola' RETURNING` condicional; dos Stop simultáneos no entregan dos veces. Una tarea `ejecutando` por dispositivo la garantiza un índice único parcial (`23505` = ocupado).
- **Allowlist** nombre -> ruta absoluta solo en `%LOCALAPPDATA%\Wabid\claude-runner.json`, se edita en la laptop. El servidor solo ve nombres; el runner revalida y rechaza lo que no esté.
- Runner: una tarea a la vez (más un archivo de bloqueo: un solo runner), tope 30 min con kill del árbol de procesos (y cierre forzado a los 10 s si `close` no llega), `spawn` sin shell, prompt como único argumento posicional tras `--` con stdin cerrado, `--max-turns 40 --max-budget-usd 2 --setting-sources user`, sin `--dangerously-skip-permissions` ni modos que salten permisos. La allowlist se relee en cada vuelta. Exige Claude Code >= 2.1.259. Los hooks y el runner corren desde una copia en `%LOCALAPPDATA%\Wabid\bin`, no desde el repo. Las reglas `allow` globales de David aplican sin tarjeta. Tareas en cola > 1 h vencen (laptop apagada). Tarea `ejecutando` sin latido > 3 min = fallida.
- Progreso/resultado redactados en la laptop y otra vez en el servidor. Al terminar, el prompt se reduce a un resumen redactado (<= 120) y el resultado a <= 600; vencidas/fallidas por latido conservan el prompt hasta la poda (14 días).
- El hook Stop dentro de una tarea del runner (`WABID_RUNNER=1`) no espera mensajes.

## Hook Stop (modo ausente)
Con modo ausente: CADA turno espera, sondeando cada 3 s, hasta `stop_wait_minutes` (config local, defecto 2, máx 14, 0 = no esperar) y deja terminar. El POST inicial del stop tiene timeout de 3 s. Sin modo ausente: solo entrega lo que ya estaba en cola. `stop_hook_active` no bloquea la entrega: cada continuación consume un mensaje nuevo (un solo uso), así que no hay bucle posible; el respaldo es el tope oficial de 8.

## Límites / fuera de alcance
- Un mensaje se entrega al siguiente Stop de esa sesión; no interrumpe a Claude a media tarea.
- No se despliega ni se aplica la migración 012 (lo hace el hilo principal; migración antes que la función).
- El runner no reanuda sesiones ni acepta preguntas interactivas (`AskUserQuestion` no existe sin host).
- `--` antes del prompt no figura en la referencia oficial de la CLI (solo `claude -p "query"`): se usa por convención y se rechazan prompts que empiecen con `-`. Sin ejecutar `claude` real, no está comprobado de extremo a extremo.
