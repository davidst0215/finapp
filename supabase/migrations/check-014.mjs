// Prueba la migración 014 contra un Postgres real (PGlite, WASM): aplica 008, 012, 013 y 014 (014 dos veces: idempotencia) y corre el
// SQL equivalente a lo que manda supabase-store.ts en cada transición de un mensaje, incluida la carrera Stop vs runner.
// No es una dependencia del repo: PGlite se carga desde PGLITE_DIR (carpeta del paquete @electric-sql/pglite).
//   PGLITE_DIR=<...>/node_modules/@electric-sql/pglite node supabase/migrations/check-014.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

if (!process.env.PGLITE_DIR) {
  console.log("PGLITE_DIR no está definido: se omite (instala @electric-sql/pglite en una carpeta temporal y apúntalo ahí).");
  process.exit(0);
}
const { PGlite } = await import(pathToFileURL(path.join(process.env.PGLITE_DIR, "dist", "index.js")).href);
const dir = import.meta.dirname;
const db = new PGlite();

await db.exec(`
  CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA auth;
  CREATE TABLE auth.users (id uuid primary key);
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  CREATE TABLE users (user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE, display_name VARCHAR(100) NOT NULL DEFAULT 'x');
`);
const run = (f) => db.exec(readFileSync(path.join(dir, f), "utf8"));
for (const f of ["008_claude_code.sql", "012_claude_code_v2.sql", "013_claude_chat.sql", "014_claude_retomar.sql"]) await run(f);
await run("014_claude_retomar.sql"); // idempotente
await run("013_claude_chat.sql"); // y 013 sigue pudiendo volver a correr encima
await run("014_claude_retomar.sql");

const U = "aaaaaaaa-0000-4000-8000-000000000001";
const DEV = "dddddddd-0000-4000-8000-000000000001";
await db.exec(`
  INSERT INTO auth.users VALUES ('${U}'); INSERT INTO users (user_id) VALUES ('${U}');
  INSERT INTO claude_devices (device_id, user_id, name, token_hash) VALUES ('${DEV}', '${U}', 'Laptop', '${"a".repeat(64)}');
  INSERT INTO claude_sessions (user_id, session_id, device_id, project, cwd, start_cwd) VALUES ('${U}', 's1', '${DEV}', 'finapp', '~\\finapp\\apps', '~\\finapp');
`);

const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const fails = async (sql, params, re) => {
  await assert.rejects(() => db.query(sql, params), re);
};
let n = 0;
const newMsg = async (body = "hola") => {
  const id = crypto.randomUUID();
  await q(
    `INSERT INTO claude_messages (message_id, user_id, session_id, device_id, body, created_at, expires_at)
     VALUES ($1, $2, 's1', $3, $4, now() - interval '5 minutes', now() + interval '6 hours')`,
    [id, U, DEV, body],
  );
  n++;
  return id;
};
const row = async (id) => (await q(`SELECT * FROM claude_messages WHERE message_id = $1`, [id]))[0];
const task = async (extra = {}) => {
  const id = extra.id ?? crypto.randomUUID();
  await q(
    `INSERT INTO claude_tasks (task_id, user_id, device_id, project, prompt, kind, resume_session_id, resume_cwd, expires_at)
     VALUES ($1, $2, $3, 'finapp', 'hola', 'resume', 's1', '~\\finapp', now() + interval '1 hour')`,
    [id, U, DEV],
  );
  return id;
};

// SQL tal como lo emite supabase-store.ts (PostgREST):
const SQL = {
  stopClaim: `UPDATE claude_messages SET status='entregando', claimed_at=now() WHERE message_id=$1 AND user_id=$2 AND status='en_cola' RETURNING message_id`,
  ack: `UPDATE claude_messages SET status='entregado', claimed_at=NULL, delivered_at=now() WHERE message_id=$1 AND user_id=$2 AND device_id=$3 AND status='entregando' RETURNING message_id`,
  requeueStop: `UPDATE claude_messages SET status='en_cola', claimed_at=NULL WHERE user_id=$1 AND status='entregando' AND claimed_at < now() + interval '1 minute'`,
  expire: `UPDATE claude_messages SET status='vencido', body=NULL, claimed_at=NULL WHERE user_id=$1 AND status IN ('en_cola','entregando') AND expires_at <= $2`,
  resumeClaim: `UPDATE claude_messages SET status='retomando', resume_task_id=$3, resume_claimed_at=now() WHERE message_id=$1 AND user_id=$2 AND status='en_cola' RETURNING message_id`,
  release: `UPDATE claude_messages SET status='en_cola', resume_task_id=NULL, resume_claimed_at=NULL WHERE user_id=$1 AND status='retomando' AND resume_task_id=$2`,
  settleOk: `UPDATE claude_messages SET status='entregado', delivered_at=now() WHERE user_id=$1 AND status='retomando' AND resume_task_id=$2`,
  settleOkErr: `UPDATE claude_messages SET status='entregado', delivered_at=now(), error=$3 WHERE user_id=$1 AND status='retomando' AND resume_task_id=$2`,
  settleFail: `UPDATE claude_messages SET status='no_retomado', error=$3 WHERE user_id=$1 AND status='retomando' AND resume_task_id=$2`,
  stale: `SELECT * FROM claude_messages WHERE user_id=$1 AND status='retomando' AND resume_claimed_at < $2`,
};

// 1. en_cola -> retomando conserva el texto (el CHECK de cuerpo de 012 lo exigía solo para en_cola/entregando)
{
  const id = await newMsg("Sí hazlo");
  const t = crypto.randomUUID();
  assert.equal((await q(SQL.resumeClaim, [id, U, t])).length, 1);
  const r = await row(id);
  assert.deepEqual([r.status, r.body, r.resume_task_id === t, r.resume_claimed_at !== null, r.claimed_at], ["retomando", "Sí hazlo", true, true, null]);
  console.log("ok  en_cola -> retomando (texto conservado, claimed_at NULL)");

  // 2. retomando -> en_cola con el texto intacto
  await q(SQL.release, [U, t]);
  const back = await row(id);
  assert.deepEqual([back.status, back.body, back.resume_task_id, back.resume_claimed_at], ["en_cola", "Sí hazlo", null, null]);
  console.log("ok  retomando -> en_cola (texto intacto)");

  // 3. retomando -> entregado (delivered_at lo exige el CHECK)
  await q(SQL.resumeClaim, [id, U, t]);
  await q(SQL.settleOk, [U, t]);
  const d = await row(id);
  assert.equal(d.status, "entregado");
  assert.ok(d.delivered_at);
  console.log("ok  retomando -> entregado (delivered_at fijado)");
}
{
  // 4. retomando -> no_retomado (11 caracteres: cabe porque la columna se ensanchó a 12) con motivo
  const id = await newMsg();
  const t = crypto.randomUUID();
  await q(SQL.resumeClaim, [id, U, t]);
  await q(SQL.settleFail, [U, t, "proyecto no autorizado en la laptop"]);
  const r = await row(id);
  assert.deepEqual([r.status, r.error, r.delivered_at], ["no_retomado", "proyecto no autorizado en la laptop", null]);
  const col = (await q(`SELECT character_maximum_length AS n FROM information_schema.columns WHERE table_name='claude_messages' AND column_name='status'`))[0];
  assert.ok(col.n >= 12);
  console.log(`ok  retomando -> no_retomado (status VARCHAR(${col.n}))`);

  // 5. retomando -> entregado con error (continuación abierta que terminó mal)
  const id2 = await newMsg();
  const t2 = crypto.randomUUID();
  await q(SQL.resumeClaim, [id2, U, t2]);
  await q(SQL.settleOkErr, [U, t2, "Claude terminó con error: error_max_turns"]);
  const r2 = await row(id2);
  assert.deepEqual([r2.status, r2.error], ["entregado", "Claude terminó con error: error_max_turns"]);
  console.log("ok  retomando -> entregado con error");
}
{
  // 6. Las transiciones de siempre (Stop) siguen valiendo con los CHECK recreados
  const id = await newMsg();
  assert.equal((await q(SQL.stopClaim, [id, U])).length, 1);
  assert.equal((await row(id)).status, "entregando");
  await q(SQL.requeueStop, [U]);
  assert.equal((await row(id)).status, "en_cola");
  await q(SQL.stopClaim, [id, U]);
  assert.equal((await q(SQL.ack, [id, U, DEV])).length, 1);
  const r = await row(id);
  assert.deepEqual([r.status, r.body !== null, r.delivered_at !== null], ["entregado", true, true]); // 013: el texto se conserva
  const old = await newMsg();
  await q(`UPDATE claude_messages SET expires_at = now() - interval '1 minute' WHERE message_id = $1`, [old]);
  await q(SQL.expire, [U, new Date().toISOString()]);
  const e = await row(old);
  assert.deepEqual([e.status, e.body], ["vencido", null]);
  console.log("ok  transiciones del hook Stop (reclamo, reencola, ack, vencer) siguen valiendo");

  // 7. Los CHECK siguen protegiendo combinaciones imposibles
  const x = await newMsg();
  await fails(`UPDATE claude_messages SET status='retomando', claimed_at=now() WHERE message_id=$1`, [x], /claude_messages_claimed_check/);
  await fails(`UPDATE claude_messages SET status='entregado' WHERE message_id=$1`, [x], /claude_messages_delivered_check/);
  await fails(`UPDATE claude_messages SET status='en_cola', body=NULL WHERE message_id=$1`, [x], /claude_messages_body_queued_check/);
  await fails(`UPDATE claude_messages SET status='inventado' WHERE message_id=$1`, [x], /claude_messages_status_check/);
  console.log("ok  CHECK con nombre rechazan estados/columnas incoherentes");
}
{
  // 8. Huérfanos: 'retomando' reclamado hace rato sin tarea
  const id = await newMsg();
  await q(SQL.resumeClaim, [id, U, crypto.randomUUID()]);
  assert.equal((await q(SQL.stale, [U, new Date(Date.now() - 60_000).toISOString()])).length, 0, "recién reclamado: no es huérfano");
  assert.equal((await q(SQL.stale, [U, new Date(Date.now() + 60_000).toISOString()])).filter((m) => m.message_id === id).length, 1);
  console.log("ok  consulta de huérfanos (listStaleResumeMessages)");
}
{
  // 9. Tareas y sesiones: columnas nuevas y CHECK
  await task();
  await fails(`INSERT INTO claude_tasks (user_id, device_id, project, prompt, kind, expires_at) VALUES ($1, $2, 'p', 'x', 'resume', now())`, [U, DEV], /claude_tasks_resume_check/);
  await fails(`INSERT INTO claude_tasks (user_id, device_id, project, prompt, kind, expires_at) VALUES ($1, $2, 'p', 'x', 'otro', now())`, [U, DEV], /claude_tasks_kind_check/);
  await q(`UPDATE claude_sessions SET continued_from = 's0' WHERE session_id = 's1'`);
  const s = (await q(`SELECT cwd, start_cwd, continued_from FROM claude_sessions WHERE session_id='s1'`))[0];
  assert.deepEqual([s.start_cwd, s.continued_from], ["~\\finapp", "s0"]);
  for (const v of ["en_cola", "ejecutando", "terminada", "fallida", "cancelada", "rechazada", "vencida"]) {
    const t = crypto.randomUUID();
    await q(`INSERT INTO claude_tasks (task_id, user_id, device_id, project, prompt, status, expires_at, finished_at) VALUES ($1,$2,$3,'p','x',$4::varchar, now(), CASE WHEN $4::varchar IN ('terminada','fallida','cancelada','rechazada','vencida') THEN now() END)`, [t, U, DEV, v]);
  }
  console.log("ok  claude_tasks.status (VARCHAR(10)) y kind (VARCHAR(8)) alojan todos los valores");
}

// 10. Idempotencia: los CHECK quedan una sola vez y con nombre
{
  const names = (await q(`SELECT conname FROM pg_constraint WHERE conrelid='claude_messages'::regclass AND contype='c' ORDER BY 1`)).map((r) => r.conname);
  assert.deepEqual(names, [
    "claude_messages_body_check", "claude_messages_body_expired_check", "claude_messages_body_queued_check",
    "claude_messages_claimed_check", "claude_messages_delivered_check", "claude_messages_status_check",
  ].filter((x) => names.includes(x)).sort());
  assert.equal(new Set(names).size, names.length);
  assert.ok(["body_queued", "claimed", "delivered", "status", "body_expired"].every((k) => names.includes(`claude_messages_${k}_check`)), names.join(","));
  assert.equal(names.length, 6, `CHECK inesperados: ${names.join(", ")}`);
  console.log("ok  014 (x3, con 013 en medio) idempotente:", names.join(", "));
}

// 11. La carrera: Stop (en_cola -> entregando) contra el runner (en_cola -> retomando) sobre el mismo mensaje.
//     Es la misma sentencia condicional en las dos vías: el segundo UPDATE re-evalúa `status='en_cola'` y afecta 0 filas.
//     PGlite es de una sola conexión (serializa); en Postgres real el segundo espera el bloqueo de fila y re-evalúa el WHERE
//     (READ COMMITTED), con el mismo resultado.
for (let i = 0; i < 50; i++) {
  const id = await newMsg();
  const t = crypto.randomUUID();
  const [a, b] = await Promise.all([db.query(SQL.stopClaim, [id, U]), db.query(SQL.resumeClaim, [id, U, t])]);
  assert.equal(a.rows.length + b.rows.length, 1, `iteración ${i}: Stop=${a.rows.length} runner=${b.rows.length}`);
  const r = await row(id);
  assert.equal(r.status, a.rows.length ? "entregando" : "retomando");
  assert.equal(r.resume_task_id, a.rows.length ? null : t);
}
{
  const id = await newMsg();
  await q(SQL.stopClaim, [id, U]);
  assert.equal((await q(SQL.resumeClaim, [id, U, crypto.randomUUID()])).length, 0, "Stop primero: el runner afecta 0 filas");
  const id2 = await newMsg();
  await q(SQL.resumeClaim, [id2, U, crypto.randomUUID()]);
  assert.equal((await q(SQL.stopClaim, [id2, U])).length, 0, "runner primero: el Stop afecta 0 filas");
}
console.log("ok  carrera Stop vs runner: 50 repeticiones concurrentes, una sola vía gana; secuencial en ambos órdenes afecta 0 filas");
console.log(`TODO BIEN (${n} mensajes de prueba)`);
