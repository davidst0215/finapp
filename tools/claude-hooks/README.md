# Hooks de Claude Code para Wabid

Supervisa tus sesiones de Claude Code desde el celular y aprueba permisos sin pasar por claude.ai ni Remote Control.
Flujo: hooks locales (esta carpeta) -> edge function `claude-events` -> app Wabid (`/claude`).

El script `wabid-hook.mjs` no tiene dependencias (Node 18+). Nunca decide por su cuenta: solo imprime
"allow" o "deny" si tú lo decidiste en el celular. Si Wabid no responde, falla o vence (2 min), no imprime
nada y Claude Code te pregunta en la terminal como siempre. Los secretos obvios (llaves con prefijo conocido, JWT, Bearer, claves en URLs, `-p<clave>`, `-u user:clave`, `--password=`, `sshpass -p`,
`echo x | ... --password-stdin`) se redactan en la laptop antes de enviar, y el servidor vuelve a redactar antes de guardar.
**La redacción es de mejor esfuerzo**: no detecta cualquier formato (p. ej. `docker login -p clave` con espacio). Revisa el comando en la tarjeta.

## Instalación

1. En Wabid abre Más > Claude Code > **Conectar esta laptop**. Copia la URL y el token (se muestran una sola vez).
2. En PowerShell, desde la carpeta del repo `finapp`:
   ```powershell
   node tools/claude-hooks/wabid-hook.mjs setup
   ```
   Pega la URL y el token. Se guardan en `%LOCALAPPDATA%\Wabid\claude-hook.json` (fuera del repo) y se prueba la conexión.
3. Pega este bloque en tu `~/.claude/settings.json` (fusiónalo con la clave `hooks` si ya la tienes).
   Ajusta la ruta si tu repo no está en `C:/Users/Dsalg/finapp`; usa barras `/`.
   ```json
   {
     "hooks": {
       "PermissionRequest": [
         { "hooks": [ { "type": "command", "command": "node", "args": ["C:/Users/Dsalg/finapp/tools/claude-hooks/wabid-hook.mjs"], "timeout": 150 } ] }
       ],
       "Notification": [
         { "hooks": [ { "type": "command", "command": "node", "args": ["C:/Users/Dsalg/finapp/tools/claude-hooks/wabid-hook.mjs"], "async": true } ] }
       ],
       "Stop": [
         { "hooks": [ { "type": "command", "command": "node", "args": ["C:/Users/Dsalg/finapp/tools/claude-hooks/wabid-hook.mjs"], "timeout": 900 } ] }
       ],
       "StopFailure": [
         { "hooks": [ { "type": "command", "command": "node", "args": ["C:/Users/Dsalg/finapp/tools/claude-hooks/wabid-hook.mjs"], "async": true } ] }
       ],
       "SessionStart": [
         { "hooks": [ { "type": "command", "command": "node", "args": ["C:/Users/Dsalg/finapp/tools/claude-hooks/wabid-hook.mjs"], "async": true } ] }
       ],
       "SessionEnd": [
         { "hooks": [ { "type": "command", "command": "node", "args": ["C:/Users/Dsalg/finapp/tools/claude-hooks/wabid-hook.mjs"], "timeout": 5 } ] }
       ],
       "UserPromptSubmit": [
         { "hooks": [ { "type": "command", "command": "node", "args": ["C:/Users/Dsalg/finapp/tools/claude-hooks/wabid-hook.mjs"], "timeout": 5 } ] }
       ]
     }
   }
   ```
4. Reinicia Claude Code. Verifica con `node tools/claude-hooks/wabid-hook.mjs test`: aparece la sesión "Prueba de conexión" en la app.

## Cómo se usa

- Por defecto Wabid solo **observa** (sesiones, avisos cuando Claude te espera o falla).
- Cuando te alejes, activa **Aprobar desde el celular** en la app. Cada permiso llega como tarjeta con el comando exacto,
  Aprobar/Rechazar y cuenta regresiva de 2 min. Sin respuesta, se pregunta en la terminal.
- Preguntas (`AskUserQuestion`) y planes (`ExitPlanMode`) siempre se contestan en la terminal. En modos `bypassPermissions`,
  `auto` y `dontAsk` no se espera nada del celular.

## Notas y límites conocidos

- La documentación no aclara si el diálogo de la terminal aparece mientras el hook espera. Prueba una vez con el interruptor
  activado: si la terminal queda esperando 2 min, usa el modo ausente solo cuando te alejes.
- Si respondes en la terminal antes, la tarjeta del celular queda pendiente hasta vencer (es inofensiva).
- Con el interruptor apagado, cada permiso hace una consulta corta a Wabid (~0.5 s).
- Un comando recortado (largo) no se puede aprobar desde el celular: se resuelve en la terminal.
- El archivo de configuración se crea con modo 0600, que en Windows no aplica: lo protegen los permisos de `%LOCALAPPDATA%` (carpeta de tu usuario).
- La forma `"command": "node", "args": [...]` (sin shell) está en la referencia oficial de hooks y en el changelog de Claude Code; tu versión (2.1.280) la soporta.
- No renombres ni dividas `wabid-hook.mjs`. Para revocar una laptop: Wabid > Claude Code > ícono de desconectar.
- Pruebas: `node --test tools/claude-hooks/wabid-hook.test.mjs tools/claude-hooks/wabid-hook.cli.test.mjs`.
- Despliegue de la función (lo hace el hilo principal): `npx supabase functions deploy claude-events --no-verify-jwt --project-ref rrhyyclltgaecfyertqh`.

## v2: responderle a una sesión y lanzar tareas desde el celular

Especificación y formatos verificados: `SPEC-claude-code-v2.md` (raíz del repo).

**Instalar / actualizar los hooks (Stop pasa a síncrono, timeout 900 s)**
```powershell
node tools/claude-hooks/instalar-hooks.mjs --dry-run   # muestra qué cambiaría; no copia ni escribe nada
node tools/claude-hooks/instalar-hooks.mjs             # copia los scripts a %LOCALAPPDATA%\Wabid\bin y actualiza solo los hooks de Wabid
```
Reinicia Claude Code. Es idempotente, no toca hooks ajenos, hace respaldo (`settings.json.antes-de-wabid-<fecha>`, con sufijo si ya existe) y escribe de forma atómica.
Los hooks apuntan a la **copia en `%LOCALAPPDATA%\Wabid\bin`**, no al repo: una tarea con permiso de edición sobre `finapp` no puede reescribir el código que corre en
cada sesión. Tras actualizar `finapp`, vuelve a correr el instalador. **No agregues `finapp` ni esa carpeta `bin` a la allowlist del runner.**
(`WABID_CLAUDE_SETTINGS=<ruta>` y `WABID_BIN_DIR=<carpeta>` apuntan a otro settings.json / carpeta, para probar.)

**Escribirle a una sesión**: en la app, abre la sesión y usa «Escríbele» (máx. 2000 caracteres). Se entrega una sola vez cuando Claude termina su turno
(hook Stop, `{"decision":"block","reason":...}`) y en dos fases: el hook reclama el mensaje (estado «Entregando…»), lo escribe en stdout y recién entonces lo
confirma (ack) → «Entregado» y se borra el texto. Sin ack en 60 s vuelve a la cola. **La entrega es «al menos una vez»**: si el ack falla (red caída justo después de escribir stdout), Claude puede recibir el mismo mensaje dos veces. Los mensajes sin recoger vencen a las 6 h (el texto se borra).

- **Con «Aprobar desde el celular» activo, CADA turno de Claude espera hasta 2 min (`stop_wait_minutes` en `claude-hook.json`, máx. 14, `0` = no esperar)** a que
  llegue un mensaje (sondeo cada 3 s) antes de terminar. Con el modo apagado no espera: solo entrega lo que ya estaba en cola.
- El aviso inicial del Stop tiene timeout de 3 s; si Wabid no responde, el turno termina normal.
- `stop_hook_active` **se ignora a propósito**: cada mensaje es de un solo uso (cola ≤ 5 por sesión), así que entregar no puede hacer un bucle; el respaldo es el
  tope oficial de Claude Code de 8 continuaciones seguidas sin usar herramientas.

**Lanzar tareas**
1. Permite proyectos (nombre -> ruta) en esta laptop; nunca se editan desde el celular:
   `node tools/claude-hooks/wabid-runner.mjs add finapp-demo C:\ruta\al\proyecto` (`list`, `remove`, `check`). Archivo: `%LOCALAPPDATA%\Wabid\claude-runner.json`.
   El runner **relee el archivo en cada vuelta** (por fecha de modificación): `remove` revoca un proyecto sin reiniciar, incluso para tareas ya en cola.
   Opcionales: `claudeCommand` (ruta de claude.exe o `["node","...\\cli.js"]`; un `.cmd` no se puede lanzar sin shell; sin esto se busca `claude.exe` en el PATH y, en Windows, en `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`, porque el shim `claude` de npm no se puede lanzar sin shell), `maxMinutes` (30), `pollSeconds` (10),
   `maxTurns` (40) y `maxBudgetUsd` (2).
2. `node tools/claude-hooks/wabid-runner.mjs check` verifica la conexión, encuentra `claude` y exige **Claude Code ≥ 2.1.259** (`--permission-prompts`).
3. Arranque al iniciar sesión (oculto): `node tools/claude-hooks/instalar-runner.mjs --dry-run`, luego sin `--dry-run` (copia a `bin` y crea la tarea). Quitar: `--quitar`.
4. Requiere `WABID_OWNER_ID` en los secretos de la función y la migración 012 aplicada antes de desplegar.

Cómo se ejecuta cada tarea (sin shell; un solo runner por laptop, con archivo de bloqueo; una tarea a la vez):
`claude -p --output-format stream-json --verbose --permission-mode default --permission-prompts none --setting-sources user --max-turns N --max-budget-usd X --session-id <uuid> -- "<prompt>"`
con stdin cerrado. El prompt es el único argumento posicional y va tras `--` (`claude -p "query"` es la forma documentada; `--` es la convención estándar de
CLIs y no aparece en la referencia oficial, por eso además se rechazan prompts que empiecen con `-`).

Qué aplica y qué no:
- `--setting-sources user`: no se cargan hooks, MCP ni permisos del `.claude/` del proyecto. **Sí aplican tus reglas `allow` globales de `~/.claude/settings.json`: lo
  que ya permites ahí se ejecuta sin tarjeta en el celular.** Lo demás pasa por el hook PermissionRequest (tarjeta, requiere modo ausente); sin respuesta, se deniega.
- Tiempo máximo 30 min: se mata el árbol de procesos; si el proceso no cierra en 10 s se fuerza y se reporta fallida. Ctrl+C, cierre de sesión (SIGHUP) o apagado hacen lo mismo.
- Al terminar, el servidor reduce el prompt a un resumen redactado (≤ 120) y recorta el resultado (≤ 600). Las tareas vencidas o fallidas por falta de latido conservan el prompt hasta la poda (14 días).

Pruebas: `node --experimental-strip-types --test tools/claude-hooks/*.test.mjs supabase/functions/claude-events/*.test.ts`.

## v3: Claude Code como chat (migración 013)

La pestaña Claude Code es una lista de conversaciones: cada sesión es un chat con lo que escribiste (en la laptop o en el celular), las respuestas de Claude, los permisos y los avisos.

**Hook nuevo `UserPromptSubmit`**: manda lo que escribes en la laptop (redactado y recortado a ~2000 caracteres) para verlo en el chat. Vuelve a correr el instalador para agregarlo (los demás hooks siguen igual):
```powershell
node tools/claude-hooks/instalar-hooks.mjs --dry-run   # debe decir "agregaría 1"
node tools/claude-hooks/instalar-hooks.mjs
```
Reinicia Claude Code. Verificado en https://code.claude.com/docs/en/hooks (5-oct-2026):
- Entrada: `prompt`, `turn_number`, `prompt_id`, `session_id`, `cwd`, `permission_mode`, `transcript_path`, `hook_event_name`.
- **No admite `async: true`**: corre antes de que Claude reciba tu mensaje. Por eso es síncrono con `timeout: 5` y el envío tiene tope de 2,5 s; si Wabid no contesta, tu mensaje sigue su camino sin registrarse. Cuesta lo que tarde esa consulta (~0,5 s con Wabid arriba).
- **No imprime nada por stdout** (en este evento todo lo que salga se agrega al contexto de Claude) ni bloquea nunca el mensaje.
- Disyuntor: si un envío falla (Wabid caído, timeout, error HTTP), los siguientes se saltan 60 s para no sumar 2,5 s a cada mensaje. Estado: archivo `prompt-breaker` junto a `claude-hook.json`.
- Los mensajes que escribes desde el celular se redactan (secretos → `[oculto]`) al guardarse; Claude recibe el texto redactado. Los push de permisos, fallos y tareas abren la conversación (`/claude/s/:id`).
- Un comando suelto (`/clear`, `/model`) no se envía. Dentro de una tarea del runner (`WABID_RUNNER=1`) tampoco: el encargo ya aparece como mensaje «tarea».
- Hasta que vuelvas a correr el instalador todo sigue funcionando: solo faltan en el chat los mensajes que escribes en la laptop.

**Respuestas de Claude completas**: el hook Stop ahora envía el último mensaje del asistente con saltos de línea, redactado y de hasta ~2000 caracteres (antes 280). Los demás avisos siguen en una línea de 300.

**Retención (cambia respecto de v2)**: el texto de un mensaje enviado desde el celular **ya no se borra al entregarlo**: el chat lo necesita. Se conserva hasta la poda (14 días, igual que eventos y tareas); solo se borra si vence sin entregarse. Lo escrito en la laptop se guarda como evento (14 días). La lista de mensajes de la vista general sigue sin traer texto; la vista previa de la lista de conversaciones sí muestra el último mensaje (300 caracteres). Lo que David escribió pasa por las reglas de secretos al mostrarse en el chat.

**Endpoint**: `GET /ui/sessions/:id/timeline?limit=60` (máx. 200), solo el dueño (JWT + `WABID_OWNER_ID`). Devuelve los últimos N elementos en orden (`user` laptop/celular/tarea, `claude`, `system`, `approval`) y `has_more`.

**Despliegue (lo hace el hilo principal, en este orden)**: aplicar `supabase/migrations/013_claude_chat.sql` y luego desplegar `claude-events`. Un servidor viejo rechaza el tipo `user_prompt` con 400 (el hook lo ignora); un hook viejo funciona con el servidor nuevo.
