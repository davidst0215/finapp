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
         { "hooks": [ { "type": "command", "command": "node", "args": ["C:/Users/Dsalg/finapp/tools/claude-hooks/wabid-hook.mjs"], "async": true } ] }
       ],
       "StopFailure": [
         { "hooks": [ { "type": "command", "command": "node", "args": ["C:/Users/Dsalg/finapp/tools/claude-hooks/wabid-hook.mjs"], "async": true } ] }
       ],
       "SessionStart": [
         { "hooks": [ { "type": "command", "command": "node", "args": ["C:/Users/Dsalg/finapp/tools/claude-hooks/wabid-hook.mjs"], "async": true } ] }
       ],
       "SessionEnd": [
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
