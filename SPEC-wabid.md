# Spec: Wabid completo (mapa de módulos)

Estado: APROBADO por David el 2026-10-04. Base en producción: https://myfinai.vercel.app.

Decisiones:
- Agenda y correo: cuenta de trabajo `david@sayainvestments.co`, lectura y escritura (crear y mover eventos, borradores). Nunca enviar un correo ni invitar a terceros sin confirmación explícita.
- Avisos: push de la PWA (Web Push con VAPID), sin terceros.
- Vault: se sube y se activa la sincronización automática de Obsidian Git cada 5 min.
- Construcción con agentes en paralelo, cada uno en su worktree. Yo integro, reviso y despliego cada módulo.

## Objetivo

Wabid es el asistente personal de David (único usuario): voz o texto para finanzas, tareas, agenda, reuniones, correo, memoria de proyectos y supervisión privada de Claude Code. Hoy solo está construido finanzas + agente + voz. Este spec cubre el resto, según la maqueta aprobada de 12 pantallas (`wabid_maqueta/maqueta.html`).

Éxito: desde el celular, David consulta y actúa sobre cualquiera de estos módulos por voz en ≤ 2 s por respuesta, sin abrir otras apps, y nada de su data es visible para terceros.

## Supuestos (corregir antes de aprobar)

1. Supabase sigue siendo el único backend: edge functions + `pg_cron`. No se agregan servidores.
2. El vault de Obsidian sigue siendo la fuente de verdad de las tareas. Norte no cambia; Wabid lee y escribe el vault vía GitHub (`davidst0215/vault-private`).
3. Todo vive en la misma PWA, con la navegación de la maqueta: Wabid · Tareas · Agenda · Finanzas · Más.
4. MiMo-V2.6-Flash es el cerebro de todos los módulos. Claude Code no se usa en tiempo de ejecución.
5. Usuario único. Después del primer login de David se cierran los registros nuevos.

## Mapa de módulos

| Id | Responsabilidad | Depende de | Acceso que falta |
|---|---|---|---|
| `velocidad` | Bajar la respuesta del agente de ~5 s a ≤ 2 s (contexto cacheado, una sola llamada, voz en streaming) | — | — |
| `recibo` | Foto de boleta → gasto al centavo (UI sobre `parse-receipt`, que ya existe) | — | — |
| `vault-sync` | Índice del vault en Supabase y escritura de tareas vía GitHub; sincronización automática con la laptop | — | Token de GitHub solo para `vault-private`; sincronización Obsidian Git activa |
| `tareas` | Lista, crear, mover y completar tareas de Norte por voz (sintaxis Obsidian Tasks) | vault-sync | — |
| `memoria` | Preguntas sobre proyectos con fuente citada: la IA elige la ficha de un catálogo en su contexto (se lee completa); sin elección, full-text de Postgres | vault-sync | — |
| `avisos` | Notificaciones push a la PWA instalada | — | Permiso de notificaciones en el celular |
| `google` | OAuth de Calendar y Gmail, guardado y renovación de tokens | — | Cuenta(s) y permisos a definir |
| `agenda` | Ver el día, agendar y mover eventos, prep de reunión | google, memoria | — |
| `brief` | Resumen de las 7:00 (agenda, vencidas, pagos, esperas) en push y voz | agenda, tareas, avisos | — |
| `reuniones` | Reuniones de Fathom y seguimiento de lo que esperas de otros | vault-sync, avisos | Key de Fathom (ya existe en Norte) |
| `correo` | Clasificar Gmail y dejar borradores para aprobar | google | — |
| `claude-code` | Hooks locales → Wabid: aprobar permisos y ver sesiones desde el celular | avisos | David agrega el bloque de hooks a su config de Claude Code |

Orden de construcción: `velocidad`, `recibo` → `vault-sync` → `tareas`, `memoria` → `avisos` → `google` → `agenda` → `brief` → `reuniones` → `correo` → `claude-code`.

Cada módulo se entrega a producción por separado (rama → PR → merge → deploy) con su prueba de punta a punta.

## Contratos para la construcción

**Base ya construida (rama `wabid/fundacion`):**
- Navegación de 5 pestañas (`components/layout/TabBar.tsx`) y rutas de todos los módulos con una página provisoria en `apps/web/src/routes/modulos/<Modulo>Page.tsx`. Cada módulo reemplaza su página; `App.tsx` no se toca.
- Agente por módulos: `supabase/functions/agent/` con `types.ts` (`AgentModule`, `tool()`), `prompt.ts` (persona, `comentario`, `conComentario`), `registry.ts` y `tools/finanzas.ts` como ejemplo. Un módulo nuevo crea `agent/tools/<modulo>.ts` y agrega **una línea** en `registry.ts`.
- Helpers de edge functions: `_shared/http.ts` (`requireUser`, `json`, `preflight`, `adminClient`, `limaNow`), `_shared/llm.ts` (`llmFetch`, `parseModelJson`), `_shared/voz.ts`, `_shared/notify.ts` (`notify(db, userId, { kind, title, body, url })`).
- Tabla `notifications` (migración 004): toda alerta pasa por `notify()`.

**Propiedad de archivos (cada agente solo toca lo suyo):**

| Módulo | Migración | Archivos propios |
|---|---|---|
| recibo | — | `routes/modulos/ReciboPage.tsx`, `components/recibo/*`; en `routes/AddTransaction.tsx` solo el botón de cámara de la barra de texto |
| vault (vault-sync + tareas + memoria) | `005_vault.sql`, `015_vault_memoria_catalogo.sql` | `_shared/vault.ts`, `functions/vault/`, `agent/tools/tareas.ts`, `agent/tools/memoria.ts`, `routes/modulos/TareasPage.tsx`, `routes/modulos/BuscarPage.tsx`, `components/tareas/*`, `components/buscar/*` |
| avisos | `006_avisos.sql` | `_shared/notify.ts` (agregar el envío push), `functions/push/`, `apps/web/src/sw-push.js` y la config PWA de `vite.config.ts`, `components/avisos/*`, una fila "Avisos" en `routes/More.tsx` |
| google (agenda + correo) | `007_google.sql` | `_shared/google.ts`, `functions/google-oauth/`, `functions/google/`, `agent/tools/agenda.ts`, `agent/tools/correo.ts`, `routes/modulos/AgendaPage.tsx`, `routes/modulos/CorreoPage.tsx`, `components/agenda/*`, `components/correo/*` |
| claude-code | `008_claude_code.sql`, `012_claude_code_v2.sql` (ver `SPEC-claude-code-v2.md`) | `functions/claude-events/`, `tools/claude-hooks/*` (script local), `routes/modulos/ClaudeCodePage.tsx`, `components/claude/*` |
| reuniones (2ª ola) | `009_reuniones.sql` | `functions/fathom/`, `agent/tools/reuniones.ts`, `routes/modulos/ReunionesPage.tsx`, `components/reuniones/*` |
| brief (2ª ola) | `010_brief.sql` | `functions/brief/`, `routes/modulos/BriefPage.tsx`, `components/brief/*` |
| avisos programados (recordatorios, vencimientos, presupuestos) | `017_avisos_programados.sql` (+ `check-017.mjs`; DEPENDE de 016: `fn_a_soles`) | `functions/avisos/`, `_shared/avisosTarea.ts`, `agent/tools/avisos*.ts`, `components/avisos/{Recordatorios,AvisosAutomaticos,SwitchRow,useProgramados}.*`; toca `_shared/notify.ts` y `webpush-core.ts` (exporta dos funciones y `PUSH_FALLIDO`), `agent/tools/tareas*.ts` («recuérdame» crea el aviso), `functions/vault/index.ts` (completar o mover una tarea cancela o reubica su recordatorio) |

Archivos compartidos que se pueden tocar con una sola línea: `agent/registry.ts` (import + entrada).

**Convenciones:**
- Toda edge function nueva empieza con `preflight` + `requireUser` (o, si es un cron/webhook, valida su propio secreto). Nunca confiar en un `user_id` que mande el cliente.
- Montos con formato `S/ 45.90` en textos que se leen en voz; `NUMERIC` en la base. Fechas en `America/Lima` con `limaNow()`.
- UI: tokens de `DESIGN.md` (`slate`, `primary`, `expense`), sin hex en componentes; clases `card`, `btn-primary`, `input`; copy en español neutro (tuteo). Rojo solo para alarma.
- Lógica pura (parsers, formateo, reglas) en archivos sin globals de Deno, con pruebas `*.test.ts` que corren en Node: `node --experimental-strip-types --test <archivo>`.
- Tipos de edge functions: `cd <scratch con deno.json {"nodeModulesDir":"auto","workspace":[]}> && DENO_NO_PACKAGE_JSON=1 npx -y deno check --config <ese deno.json> <archivos>`. Web: `cd apps/web && npx tsc -b && npx vite build`.

**Prohibido a los agentes:** desplegar funciones, aplicar migraciones, cambiar configuración de Supabase, Vercel o Google, commitear en `master`, tocar archivos de otro módulo, escribir secretos en el código. Los secretos se leen con `Deno.env.get` y su nombre se reporta. Integración, migraciones y deploy los hace el hilo principal.

## Comandos

- Dev: `cd apps/web && pnpm dev` (http://localhost:5173)
- Tipos y build: `cd apps/web && npx tsc -b && npx vite build`
- Funciones: `npx supabase functions deploy <fn> --project-ref rrhyyclltgaecfyertqh`
- Producción: `cd apps/web && vercel deploy --prod`

### Avisos programados: despliegue y prueba de humo (migración 017)

Orden: 016 antes que 017 (017 suma los presupuestos con `fn_a_soles`). Secreto en DOS sitios con el MISMO valor: Vault `avisos_cron_secret` y `AVISOS_CRON_SECRET` de la función.

- **Desplegar `avisos` SIEMPRE con `--no-verify-jwt`:** `npx supabase functions deploy avisos --no-verify-jwt --project-ref rrhyyclltgaecfyertqh`. La llama pg_cron, que no tiene JWT. Sin la bandera el gateway responde 401 antes de llegar a la función: no se envía ningún aviso y la función no deja ni una línea en sus logs. No hay `config.toml` en el repo: la bandera es lo único que lo garantiza.
- **Prueba de humo, después de desplegar y aplicar 017:**
  1. Sin secreto: `curl -s -X POST https://rrhyyclltgaecfyertqh.supabase.co/functions/v1/avisos` debe responder `{"error":"No autorizado"}` (401) y dejar `avisos: 401` en los logs de la función. Si responde otra forma de 401 (`UNAUTHORIZED_NO_AUTH_HEADER`, `Invalid JWT`), falta `--no-verify-jwt`.
  2. Jobs: `select jobname, schedule, active from cron.job where jobname like 'wabid-avisos%';` → `wabid-avisos` (`* * * * *`) y `wabid-avisos-mantener` (`5 * * * *`), activos.
  3. Un envío de verdad: con la app instalada y los avisos activados en el celular, pedirle a Wabid «recuérdame probar el aviso en 2 minutos». A los ~2 min debe llegar el push; luego `select estado, detalle, intentos from avisos_programados order by created_at desc limit 3;` → `enviado`, `push`, 1.
  4. Que el cron lo disparó y no fue a mano: `select status, return_message, end_time from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'wabid-avisos') order by end_time desc limit 5;` y `select status_code, created from net._http_response order by created desc limit 5;` → 200. Un 401 ahí es secreto desparejado (Vault ≠ función).
- Los jobs no se tocan a mano: se reemplazan solos al volver a aplicar 017. El historial `cron.job_run_details` se purga a los 7 días dentro de `avisos_mantener` (si el rol no pudiera, deja un WARNING en los logs de Postgres y el resto sigue).

## Límites

- Siempre: validar el usuario en cada edge function; montos al centavo con `NUMERIC`; fechas en `America/Lima`; prueba de punta a punta antes de cada deploy.
- Preguntar antes: cambios de esquema, dependencias nuevas, permisos nuevos de Google, cualquier envío de correo o evento a terceros.
- Nunca: enviar correos o crear eventos sin confirmación de David; secretos en el repo; escribir en el vault fuera de las tareas (`pendientes.md`) y las notas por voz (`20-projects/<carpeta>/notas.md`, pedidas por David el 11-oct-2026); nunca en las fichas de `60-wiki`.

## Criterios de éxito

- Cada módulo de la tabla funciona en producción desde el celular, verificado de punta a punta.
- Respuesta del agente ≤ 2 s (p50) medida en producción.
- Ningún endpoint responde datos o gasta créditos sin el usuario de David.
- Una tarea creada en Wabid aparece en Norte (y viceversa) en ≤ 5 min.

## Preguntas abiertas

1. Agenda y correo: ¿de qué cuenta (trabajo `david@sayainvestments.co`, personal o ambas) y con qué permiso (solo leer, o también crear eventos y borradores)?
2. Avisos: ¿push de la app o Telegram?
3. Vault: ¿activo la sincronización automática de Obsidian Git y subo el vault con las fichas?
4. ¿Apruebas el mapa y el orden? ¿Lo construyo con agentes en paralelo para ir más rápido?
