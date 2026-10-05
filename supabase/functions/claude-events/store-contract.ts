// Suite de contrato del `Store`: lo que cualquier implementación debe cumplir. Se corre contra MemoryStore
// (memory-store.test.ts) y contra el adaptador de Supabase sobre un Postgres real con la migración 008.
// Solo se usa en pruebas: index.ts no la importa, así que no viaja en el despliegue.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Store } from "./store.ts";
import type { SessionRow } from "./types.ts";

export interface StoreFixture {
  store: Store;
  /** Crea el usuario si la implementación lo necesita (la base tiene llave foránea a users). */
  seedUser(userId: string): Promise<void>;
  close?(): Promise<void>;
}

const U1 = "aaaaaaaa-0000-4000-8000-000000000001";
const U2 = "bbbbbbbb-0000-4000-8000-000000000002";
const BASE = Date.parse("2026-10-04T15:00:00.000Z");
const iso = (seconds: number) => new Date(BASE + seconds * 1000).toISOString();
const same = (a: string | null | undefined, b: string) => assert.equal(Date.parse(a as string), Date.parse(b), `${a} ≠ ${b}`);

export function defineStoreContract(label: string, make: () => Promise<StoreFixture>) {
  const T = (name: string, fn: (f: StoreFixture) => Promise<void>) =>
    test(`${label}: ${name}`, async () => {
      const f = await make();
      try {
        await fn(f);
      } finally {
        await f.close?.();
      }
    });

  const newDevice = async (f: StoreFixture, userId = U1, name = "Laptop") => {
    await f.seedUser(userId);
    return f.store.insertDevice({ device_id: crypto.randomUUID(), user_id: userId, name, token_hash: "a".repeat(64) });
  };

  const session = (userId: string, deviceId: string, sessionId = "s1", over: Partial<SessionRow> = {}): SessionRow => ({
    user_id: userId,
    session_id: sessionId,
    device_id: deviceId,
    project: "finapp",
    cwd: "~/finapp",
    status: "trabajando",
    last_summary: null,
    last_role: null,
    started_at: iso(0),
    last_event_at: iso(0),
    ended_at: null,
    ...over,
  });

  const approval = (userId: string, deviceId: string, sessionId = "s1", createdSec = 0, ttlSec = 120) => ({
    approval_id: crypto.randomUUID(),
    user_id: userId,
    device_id: deviceId,
    session_id: sessionId,
    project: "finapp",
    tool_name: "Bash",
    description: null,
    preview: "ls",
    preview_truncated: false,
    created_at: iso(createdSec),
    expires_at: iso(createdSec + ttlSec),
  });

  const withSession = async (f: StoreFixture, userId = U1, sessionId = "s1") => {
    const d = await newDevice(f, userId);
    await f.store.saveSession(session(userId, d.device_id, sessionId));
    return d;
  };

  // --- Dispositivos

  T("un dispositivo nuevo nace sin revocar, sin contacto y con las aprobaciones apagadas", async (f) => {
    const d = await newDevice(f);
    const found = await f.store.findDevice(d.device_id);
    assert.equal(found!.name, "Laptop");
    assert.equal(found!.user_id, U1);
    assert.equal(found!.approvals_enabled, false);
    assert.equal(found!.revoked_at, null);
    assert.equal(found!.last_seen_at, null);
    assert.equal(found!.token_hash, "a".repeat(64));
    assert.equal(await f.store.findDevice(crypto.randomUUID()), null);
  });

  T("listDevices devuelve solo los activos del usuario, del más antiguo al más nuevo", async (f) => {
    const a = await newDevice(f, U1, "A");
    const b = await newDevice(f, U1, "B");
    await newDevice(f, U2, "ajeno");
    assert.deepEqual((await f.store.listDevices(U1)).map((d) => d.name), ["A", "B"]);
    await f.store.revokeDevice(U1, a.device_id, iso(1));
    assert.deepEqual((await f.store.listDevices(U1)).map((d) => d.device_id), [b.device_id]);
  });

  T("patchDevice cambia nombre y aprobaciones, pero no en dispositivos ajenos ni revocados", async (f) => {
    const d = await newDevice(f);
    const patched = await f.store.patchDevice(U1, d.device_id, { name: "Nueva", approvals_enabled: true });
    assert.equal(patched!.name, "Nueva");
    assert.equal(patched!.approvals_enabled, true);
    assert.equal((await f.store.patchDevice(U1, d.device_id, { name: "Solo nombre" }))!.approvals_enabled, true, "lo no enviado no cambia");
    await f.seedUser(U2);
    assert.equal(await f.store.patchDevice(U2, d.device_id, { name: "robado" }), null);
    await f.store.revokeDevice(U1, d.device_id, iso(1));
    assert.equal(await f.store.patchDevice(U1, d.device_id, { name: "revocado" }), null);
  });

  T("revokeDevice apaga las aprobaciones, no se repite y no vale para ajenos; la autenticación aún lo ve revocado", async (f) => {
    const d = await newDevice(f);
    await f.store.patchDevice(U1, d.device_id, { approvals_enabled: true });
    await f.seedUser(U2);
    assert.equal(await f.store.revokeDevice(U2, d.device_id, iso(1)), null);
    const revoked = await f.store.revokeDevice(U1, d.device_id, iso(2));
    same(revoked!.revoked_at, iso(2));
    assert.equal(revoked!.approvals_enabled, false);
    assert.equal(await f.store.revokeDevice(U1, d.device_id, iso(3)), null);
    same((await f.store.findDevice(d.device_id))!.revoked_at, iso(2));
  });

  T("touchDevice guarda el último contacto", async (f) => {
    const d = await newDevice(f);
    await f.store.touchDevice(d.device_id, iso(5));
    same((await f.store.findDevice(d.device_id))!.last_seen_at, iso(5));
  });

  // --- Sesiones y eventos

  T("saveSession inserta y luego reemplaza por (usuario, sesión); la misma sesión de otro usuario es otra fila", async (f) => {
    const d = await newDevice(f);
    await f.store.saveSession(session(U1, d.device_id, "s1"));
    await f.store.saveSession(session(U1, d.device_id, "s1", { status: "esperando", last_summary: "listo", last_event_at: iso(30) }));
    const s = await f.store.getSession(U1, "s1");
    assert.equal(s!.status, "esperando");
    assert.equal(s!.last_summary, "listo");
    same(s!.started_at, iso(0));
    same(s!.last_event_at, iso(30));
    assert.equal((await f.store.listSessions(U1, 10)).length, 1);
    assert.equal(await f.store.getSession(U2, "s1"), null);
    const d2 = await newDevice(f, U2, "otra");
    await f.store.saveSession(session(U2, d2.device_id, "s1", { project: "otro" }));
    assert.equal((await f.store.getSession(U2, "s1"))!.project, "otro");
    assert.equal((await f.store.getSession(U1, "s1"))!.project, "finapp");
  });

  T("una sesión terminada guarda ended_at y puede reanudarse (ended_at vuelve a null)", async (f) => {
    const d = await newDevice(f);
    await f.store.saveSession(session(U1, d.device_id, "s1", { status: "terminada", ended_at: iso(10) }));
    same((await f.store.getSession(U1, "s1"))!.ended_at, iso(10));
    await f.store.saveSession(session(U1, d.device_id, "s1", { status: "trabajando", ended_at: null }));
    assert.equal((await f.store.getSession(U1, "s1"))!.ended_at, null);
  });

  T("un evento exige que la sesión exista", async (f) => {
    const d = await newDevice(f);
    await assert.rejects(() =>
      f.store.insertEvent({ user_id: U1, session_id: "no-existe", device_id: d.device_id, kind: "stop", detail: null, summary: "x", created_at: iso(0) })
    );
  });

  T("countEventsSince cuenta por dispositivo y desde la fecha dada", async (f) => {
    const a = await withSession(f);
    const b = await newDevice(f, U1, "otro");
    await f.store.saveSession(session(U1, b.device_id, "s2"));
    const ev = (device: string, s: string, sec: number) =>
      f.store.insertEvent({ user_id: U1, session_id: s, device_id: device, kind: "notification", detail: "t", summary: "x", created_at: iso(sec) });
    await ev(a.device_id, "s1", 0);
    await ev(a.device_id, "s1", 30);
    await ev(a.device_id, "s1", 60);
    await ev(b.device_id, "s2", 60);
    assert.equal(await f.store.countEventsSince(a.device_id, iso(0)), 3);
    assert.equal(await f.store.countEventsSince(a.device_id, iso(31)), 1);
    assert.equal(await f.store.countEventsSince(a.device_id, iso(61)), 0);
    assert.equal(await f.store.countEventsSince(b.device_id, iso(0)), 1);
    assert.equal(await f.store.countEventsSince(a.device_id, iso(0), ["stop"]), 0);
    assert.equal(await f.store.countEventsSince(a.device_id, iso(0), ["notification", "stop"]), 3);
    assert.equal(await f.store.countSessionsSince(a.device_id, iso(0)), 1);
    assert.equal(await f.store.countSessionsSince(a.device_id, iso(1)), 0);
  });

  T("listSessions y listEvents ordenan del más reciente, respetan el límite y el usuario", async (f) => {
    const d = await newDevice(f);
    for (const [id, sec] of [["viejo", 0], ["medio", 50], ["nuevo", 100]] as const) {
      await f.store.saveSession(session(U1, d.device_id, id, { last_event_at: iso(sec) }));
    }
    assert.deepEqual((await f.store.listSessions(U1, 10)).map((s) => s.session_id), ["nuevo", "medio", "viejo"]);
    assert.deepEqual((await f.store.listSessions(U1, 2)).map((s) => s.session_id), ["nuevo", "medio"]);
    assert.deepEqual(await f.store.listSessions(U2, 10), []);

    for (const sec of [1, 3, 2]) {
      await f.store.insertEvent({ user_id: U1, session_id: "nuevo", device_id: d.device_id, kind: "stop", detail: null, summary: `e${sec}`, created_at: iso(sec) });
    }
    assert.deepEqual((await f.store.listEvents(U1, "nuevo", 10)).map((e) => e.summary), ["e3", "e2", "e1"]);
    assert.equal((await f.store.listEvents(U1, "nuevo", 2)).length, 2);
    assert.deepEqual(await f.store.listEvents(U2, "nuevo", 10), []);
  });

  // --- Aprobaciones

  T("una aprobación exige sesión y solo la ve su dueño", async (f) => {
    const d = await newDevice(f);
    await assert.rejects(() => f.store.insertApproval(approval(U1, d.device_id, "no-existe")));
    await f.store.saveSession(session(U1, d.device_id));
    const a = await f.store.insertApproval(approval(U1, d.device_id));
    assert.equal(a.status, "pendiente");
    assert.equal(a.decided_at, null);
    assert.equal(a.decided_by, null);
    assert.equal(a.description, null);
    assert.equal((await f.store.findApproval(U1, a.approval_id))!.preview, "ls");
    assert.equal(await f.store.findApproval(U2, a.approval_id), null);
  });

  T("decideApproval cambia una sola vez, deja quién y cuándo, y respeta dueño y vencimiento", async (f) => {
    const d = await withSession(f);
    await f.seedUser(U2);
    const a = await f.store.insertApproval(approval(U1, d.device_id));
    assert.equal(await f.store.decideApproval(U2, a.approval_id, "aprobada", U2, iso(10)), null, "otro usuario");
    assert.equal(await f.store.decideApproval(U1, a.approval_id, "aprobada", U1, iso(120)), null, "justo al vencer ya no vale");
    const ok = await f.store.decideApproval(U1, a.approval_id, "aprobada", U1, iso(10));
    assert.equal(ok!.status, "aprobada");
    assert.equal(ok!.decided_by, U1);
    same(ok!.decided_at, iso(10));
    assert.equal(await f.store.decideApproval(U1, a.approval_id, "denegada", U1, iso(11)), null, "ya decidida");
    assert.equal((await f.store.findApproval(U1, a.approval_id))!.status, "aprobada");
  });

  T("dos decisiones simultáneas: solo una gana", async (f) => {
    const d = await withSession(f);
    const a = await f.store.insertApproval(approval(U1, d.device_id));
    const results = await Promise.all([
      f.store.decideApproval(U1, a.approval_id, "aprobada", U1, iso(5)),
      f.store.decideApproval(U1, a.approval_id, "denegada", U1, iso(5)),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
  });

  T("expireApprovals vence solo lo que pasó su plazo, salvo con all; respeta alcance y no toca lo decidido", async (f) => {
    const d1 = await withSession(f, U1, "s1");
    const d2 = await newDevice(f, U1, "otro");
    await f.store.saveSession(session(U1, d2.device_id, "s2"));
    const due = await f.store.insertApproval(approval(U1, d1.device_id, "s1", 0, 60));
    const later = await f.store.insertApproval(approval(U1, d1.device_id, "s1", 0, 600));
    const other = await f.store.insertApproval(approval(U1, d2.device_id, "s2", 0, 600));
    const decided = await f.store.insertApproval(approval(U1, d1.device_id, "s1", 0, 30));
    await f.store.decideApproval(U1, decided.approval_id, "aprobada", U1, iso(1));

    await f.store.expireApprovals(U1, iso(100));
    const status = async (id: string) => (await f.store.findApproval(U1, id))!.status;
    assert.equal(await status(due.approval_id), "vencida");
    same((await f.store.findApproval(U1, due.approval_id))!.decided_at, iso(100));
    assert.equal(await status(later.approval_id), "pendiente", "aún no vence");
    assert.equal(await status(decided.approval_id), "aprobada", "lo decidido no se toca");

    await f.store.expireApprovals(U1, iso(101), { sessionId: "s1", all: true });
    assert.equal(await status(later.approval_id), "vencida");
    assert.equal(await status(other.approval_id), "pendiente", "otra sesión intacta");
    await f.store.expireApprovals(U1, iso(102), { deviceId: d2.device_id, all: true });
    assert.equal(await status(other.approval_id), "vencida");
  });

  T("expireApprovals no toca aprobaciones de otro usuario", async (f) => {
    const d = await withSession(f, U1);
    const a = await f.store.insertApproval(approval(U1, d.device_id));
    await f.seedUser(U2);
    await f.store.expireApprovals(U2, iso(1000), { all: true });
    assert.equal((await f.store.findApproval(U1, a.approval_id))!.status, "pendiente");
  });

  T("countPending ignora las vencidas, las decididas y filtra por sesión", async (f) => {
    const d = await withSession(f, U1, "s1");
    await f.store.saveSession(session(U1, d.device_id, "s2"));
    await f.store.insertApproval(approval(U1, d.device_id, "s1", 0, 120));
    await f.store.insertApproval(approval(U1, d.device_id, "s2", 0, 120));
    const gone = await f.store.insertApproval(approval(U1, d.device_id, "s1", 0, 30));
    const done = await f.store.insertApproval(approval(U1, d.device_id, "s1", 0, 120));
    await f.store.decideApproval(U1, done.approval_id, "denegada", U1, iso(1));
    assert.equal(await f.store.countPending(U1, iso(10)), 3);
    assert.equal(await f.store.countPending(U1, iso(10), { sessionId: "s1" }), 2);
    assert.equal(await f.store.countPending(U1, iso(10), { deviceId: d.device_id }), 3);
    assert.equal(await f.store.countPending(U1, iso(10), { deviceId: crypto.randomUUID() }), 0);
    assert.equal(await f.store.countPending(U1, iso(40)), 2, "la de 30 s ya venció");
    assert.equal(await f.store.countPending(U2, iso(10)), 0);
    assert.ok(gone);
  });

  T("listApprovals filtra por estado y fecha, ordena del más reciente y respeta el límite", async (f) => {
    const d = await withSession(f);
    const a1 = await f.store.insertApproval(approval(U1, d.device_id, "s1", 0));
    const a2 = await f.store.insertApproval(approval(U1, d.device_id, "s1", 100));
    const a3 = await f.store.insertApproval(approval(U1, d.device_id, "s1", 200));
    await f.store.decideApproval(U1, a2.approval_id, "aprobada", U1, iso(101));
    await f.store.decideApproval(U1, a3.approval_id, "denegada", U1, iso(201));
    assert.deepEqual((await f.store.listApprovals(U1, { statuses: ["pendiente"], limit: 10 })).map((a) => a.approval_id), [a1.approval_id]);
    assert.deepEqual(
      (await f.store.listApprovals(U1, { statuses: ["aprobada", "denegada"], limit: 10 })).map((a) => a.approval_id),
      [a3.approval_id, a2.approval_id],
    );
    assert.deepEqual((await f.store.listApprovals(U1, { statuses: ["aprobada", "denegada"], sinceIso: iso(150), limit: 10 })).map((a) => a.approval_id), [a3.approval_id]);
    assert.equal((await f.store.listApprovals(U1, { statuses: ["aprobada", "denegada"], limit: 1 })).length, 1);
    assert.deepEqual(await f.store.listApprovals(U2, { statuses: ["pendiente"], limit: 10 }), []);
  });

  T("prune borra sesiones viejas con sus eventos y aprobaciones, y eventos y aprobaciones decididas viejos; respeta lo pendiente y lo reciente", async (f) => {
    const d = await newDevice(f);
    await f.store.saveSession(session(U1, d.device_id, "vieja", { last_event_at: iso(-1000) }));
    await f.store.saveSession(session(U1, d.device_id, "activa", { last_event_at: iso(0) }));
    const ev = (s: string, sec: number) =>
      f.store.insertEvent({ user_id: U1, session_id: s, device_id: d.device_id, kind: "stop", detail: null, summary: `${s}@${sec}`, created_at: iso(sec) });
    await ev("vieja", -999);
    await ev("activa", -500); // evento viejo en sesión activa
    await ev("activa", 0); // evento reciente
    const oldDecided = await f.store.insertApproval(approval(U1, d.device_id, "activa", -600, 60));
    await f.store.decideApproval(U1, oldDecided.approval_id, "aprobada", U1, iso(-599));
    const oldPending = await f.store.insertApproval(approval(U1, d.device_id, "activa", -600, 10_000));
    const fresh = await f.store.insertApproval(approval(U1, d.device_id, "activa", 0, 120));
    const onOldSession = await f.store.insertApproval(approval(U1, d.device_id, "vieja", -1000, 60));

    await f.store.prune(U1, { events: iso(-100), approvals: iso(-100), sessions: iso(-500) });

    assert.equal(await f.store.getSession(U1, "vieja"), null);
    assert.ok(await f.store.getSession(U1, "activa"));
    assert.deepEqual((await f.store.listEvents(U1, "activa", 10)).map((e) => e.summary), ["activa@0"]);
    assert.equal(await f.store.findApproval(U1, onOldSession.approval_id), null, "cae con su sesión");
    assert.equal(await f.store.findApproval(U1, oldDecided.approval_id), null);
    assert.ok(await f.store.findApproval(U1, oldPending.approval_id), "lo pendiente no se borra por antigüedad");
    assert.ok(await f.store.findApproval(U1, fresh.approval_id));
  });

  T("prune solo afecta al usuario indicado", async (f) => {
    const d1 = await newDevice(f, U1);
    const d2 = await newDevice(f, U2);
    await f.store.saveSession(session(U1, d1.device_id, "s", { last_event_at: iso(-1000) }));
    await f.store.saveSession(session(U2, d2.device_id, "s", { last_event_at: iso(-1000) }));
    await f.store.prune(U1, { events: iso(-100), approvals: iso(-100), sessions: iso(-500) });
    assert.equal(await f.store.getSession(U1, "s"), null);
    assert.ok(await f.store.getSession(U2, "s"));
  });

  // --- v2 (012): mensajes

  const msg = (userId: string, deviceId: string, sessionId: string, body: string, createdSec: number, ttlSec = 3600) => ({
    message_id: crypto.randomUUID(),
    user_id: userId,
    session_id: sessionId,
    device_id: deviceId,
    body,
    created_at: iso(createdSec),
    expires_at: iso(createdSec + ttlSec),
  });

  T("mensajes: se reclaman en orden, una sola vez; el texto se borra solo al confirmar (ack)", async (f) => {
    const d = await withSession(f);
    await f.store.insertMessage(msg(U1, d.device_id, "s1", "primero", 0));
    await f.store.insertMessage(msg(U1, d.device_id, "s1", "segundo", 1));
    assert.equal(await f.store.countQueuedMessages(U1, "s1", iso(2)), 2);
    const a = await f.store.claimNextMessage(U1, "s1", iso(2));
    assert.equal(a?.text, "primero");
    const b = await f.store.claimNextMessage(U1, "s1", iso(3));
    assert.equal(b?.text, "segundo");
    assert.equal(await f.store.claimNextMessage(U1, "s1", iso(4)), null, "no hay entrega doble");
    assert.deepEqual((await f.store.listMessages(U1, 10)).map((m) => m.status), ["entregando", "entregando"]);
    assert.equal(await f.store.countQueuedMessages(U1, "s1", iso(4)), 2, "entregando sigue contando contra el tope");
    assert.equal(await f.store.ackMessage(U1, a!.messageId, d.device_id, iso(5)), true);
    assert.equal(await f.store.ackMessage(U1, a!.messageId, d.device_id, iso(6)), false, "el ack no se repite");
    const other = await newDevice(f, U1, "otra");
    assert.equal(await f.store.ackMessage(U1, b!.messageId, other.device_id, iso(6)), false, "otro dispositivo no confirma");
    const listed = await f.store.listMessages(U1, 10);
    assert.deepEqual(listed.map((m) => m.status).sort(), ["entregado", "entregando"]);
    assert.ok(listed.every((m) => m.body === null), "el texto nunca sale de listMessages");
  });

  T("013: touchSessionPreview cambia solo last_summary y last_role", async (f) => {
    const d = await withSession(f);
    await f.store.saveSession(session(U1, d.device_id, "s1", { status: "esperando", last_event_at: iso(30), last_summary: "viejo" }));
    await f.store.touchSessionPreview(U1, "s1", "nuevo", "usuario");
    const s = (await f.store.getSession(U1, "s1"))!;
    assert.deepEqual([s.last_summary, s.last_role, s.status, s.last_event_at], ["nuevo", "usuario", "esperando", iso(30)]);
    await f.seedUser(U2);
    await f.store.touchSessionPreview(U2, "s1", "ajeno", "claude");
    assert.equal((await f.store.getSession(U1, "s1"))!.last_summary, "nuevo", "no cruza usuarios");
  });

  T("013: listSessionMessages trae el texto (también tras entregar) solo de esa sesión y de ese usuario; vencer lo borra", async (f) => {
    const d = await withSession(f);
    await f.store.saveSession(session(U1, d.device_id, "s2"));
    await f.store.insertMessage(msg(U1, d.device_id, "s1", "uno", 0, 60));
    await f.store.insertMessage(msg(U1, d.device_id, "s1", "dos", 1));
    await f.store.insertMessage(msg(U1, d.device_id, "s2", "de otra sesión", 2));
    const claimed = await f.store.claimNextMessage(U1, "s1", iso(3));
    assert.equal(await f.store.ackMessage(U1, claimed!.messageId, d.device_id, iso(4)), true);
    const rows = await f.store.listSessionMessages(U1, "s1", 10);
    assert.deepEqual(rows.map((m) => [m.body, m.status]), [["dos", "en_cola"], ["uno", "entregado"]], "el entregado conserva el texto");
    await f.seedUser(U2);
    assert.deepEqual(await f.store.listSessionMessages(U2, "s1", 10), []);
    assert.equal((await f.store.listSessionMessages(U1, "s1", 1)).length, 1, "respeta el límite");
    await f.store.expireMessages(U1, iso(4000));
    assert.ok((await f.store.listSessionMessages(U1, "s1", 10)).every((m) => m.status === "entregado" || m.body === null));
  });

  T("013: listSessionApprovals trae todos los estados de una sesión, más recientes primero, sin mezclar usuarios", async (f) => {
    const d = await withSession(f);
    await f.store.saveSession(session(U1, d.device_id, "s2"));
    const a = await f.store.insertApproval(approval(U1, d.device_id, "s1", 0));
    await f.store.insertApproval(approval(U1, d.device_id, "s1", 5));
    await f.store.insertApproval(approval(U1, d.device_id, "s2", 6));
    await f.store.decideApproval(U1, a.approval_id, "aprobada", U1, iso(10));
    const rows = await f.store.listSessionApprovals(U1, "s1", 10);
    assert.deepEqual(rows.map((r) => r.status), ["pendiente", "aprobada"]);
    await f.seedUser(U2);
    assert.deepEqual(await f.store.listSessionApprovals(U2, "s1", 10), []);
  });

  T("mensajes: un reclamo sin ack vuelve a la cola pasado el plazo y se puede reclamar otra vez", async (f) => {
    const d = await withSession(f);
    await f.store.insertMessage(msg(U1, d.device_id, "s1", "uno", 0));
    assert.equal((await f.store.claimNextMessage(U1, "s1", iso(1)))?.text, "uno");
    await f.store.requeueStaleMessages(U1, iso(0));
    assert.equal(await f.store.claimNextMessage(U1, "s1", iso(2)), null, "aún no es viejo");
    await f.store.requeueStaleMessages(U1, iso(30));
    assert.equal((await f.store.claimNextMessage(U1, "s1", iso(31)))?.text, "uno");
  });

  T("mensajes: dos reclamos simultáneos entregan el texto una sola vez", async (f) => {
    const d = await withSession(f);
    await f.store.insertMessage(msg(U1, d.device_id, "s1", "uno", 0));
    const results = await Promise.all([f.store.claimNextMessage(U1, "s1", iso(1)), f.store.claimNextMessage(U1, "s1", iso(1))]);
    assert.equal(results.filter((r) => r !== null).length, 1);
  });

  T("mensajes: no se reclaman los ajenos, los de otra sesión ni los vencidos; vencer borra el texto", async (f) => {
    const d = await withSession(f);
    await f.store.saveSession(session(U1, d.device_id, "s2"));
    await f.store.insertMessage(msg(U1, d.device_id, "s1", "de s1", 0, 60));
    assert.equal(await f.store.claimNextMessage(U1, "s2", iso(1)), null);
    await f.seedUser(U2);
    assert.equal(await f.store.claimNextMessage(U2, "s1", iso(1)), null);
    assert.equal(await f.store.claimNextMessage(U1, "s1", iso(61)), null, "vencido");
    await f.store.expireMessages(U1, iso(61));
    assert.equal((await f.store.listMessages(U1, 10))[0]!.status, "vencido");
    assert.equal(await f.store.countQueuedMessages(U1, "s1", iso(61)), 0);
  });

  T("mensajes: prune borra los entregados viejos y deja los que siguen en cola", async (f) => {
    const d = await withSession(f);
    await f.store.insertMessage(msg(U1, d.device_id, "s1", "viejo", -1000, 100000));
    const claimed = await f.store.claimNextMessage(U1, "s1", iso(0));
    await f.store.ackMessage(U1, claimed!.messageId, d.device_id, iso(1));
    const pending = await f.store.insertMessage(msg(U1, d.device_id, "s1", "en cola", -900, 100000));
    await f.store.prune(U1, { events: iso(-5000), approvals: iso(-5000), sessions: iso(-5000), messages: iso(-100), tasks: iso(-100) });
    assert.deepEqual((await f.store.listMessages(U1, 10)).map((m) => m.message_id), [pending.message_id]);
  });

  // --- v2 (012): tareas

  const task = (userId: string, deviceId: string, project: string, createdSec: number, ttlSec = 3600) => ({
    task_id: crypto.randomUUID(),
    user_id: userId,
    device_id: deviceId,
    project,
    prompt: `haz algo en ${project}`,
    created_at: iso(createdSec),
    expires_at: iso(createdSec + ttlSec),
  });

  T("tareas: claimNextTask reclama la más antigua del dispositivo una sola vez", async (f) => {
    const d = await newDevice(f);
    const other = await newDevice(f, U1, "Otra");
    const a = await f.store.insertTask(task(U1, d.device_id, "a", 0));
    await f.store.insertTask(task(U1, d.device_id, "b", 1));
    await f.store.insertTask(task(U1, other.device_id, "c", -5));
    const claimed = await f.store.claimNextTask(U1, d.device_id, iso(2));
    assert.equal(claimed!.task_id, a.task_id);
    assert.equal(claimed!.status, "ejecutando");
    same(claimed!.started_at, iso(2));
    assert.equal(await f.store.claimNextTask(U1, d.device_id, iso(3)), null, "una sola ejecutándose por dispositivo");
    await f.store.updateTask(U1, claimed!.task_id, { status: "terminada", finished_at: iso(3) }, ["ejecutando"]);
    assert.equal((await f.store.claimNextTask(U1, d.device_id, iso(4)))!.project, "b");
    assert.equal(await f.store.claimNextTask(U1, d.device_id, iso(5)), null);
  });

  T("tareas: dos reclamos simultáneos no entregan la misma tarea", async (f) => {
    const d = await newDevice(f);
    await f.store.insertTask(task(U1, d.device_id, "a", 0));
    const results = await Promise.all([f.store.claimNextTask(U1, d.device_id, iso(1)), f.store.claimNextTask(U1, d.device_id, iso(1))]);
    assert.equal(results.filter((r) => r !== null).length, 1);
  });

  T("tareas: updateTask solo transiciona desde los estados permitidos y no toca las de otro usuario", async (f) => {
    const d = await newDevice(f);
    const t = await f.store.insertTask(task(U1, d.device_id, "a", 0));
    assert.equal(await f.store.updateTask(U1, t.task_id, { status: "terminada", finished_at: iso(5) }, ["ejecutando"]), null, "en cola no termina");
    const c = await f.store.updateTask(U1, t.task_id, { status: "cancelada", finished_at: iso(5) }, ["en_cola"]);
    assert.equal(c!.status, "cancelada");
    await f.seedUser(U2);
    assert.equal(await f.store.updateTask(U2, t.task_id, { cancel_requested: true }, ["cancelada"]), null);
  });

  T("tareas: sweepTasks vence las no reclamadas y falla las que perdieron el latido", async (f) => {
    const d = await newDevice(f);
    const old = await f.store.insertTask(task(U1, d.device_id, "vieja", 0, 60));
    const run = await f.store.insertTask(task(U1, d.device_id, "corriendo", 100, 3600));
    await f.store.claimNextTask(U1, d.device_id, iso(100));
    const changed = await f.store.sweepTasks(U1, d.device_id, iso(1000), iso(900));
    assert.deepEqual(changed.map((t) => t.status).sort(), ["fallida", "vencida"], "devuelve las filas que cambió");
    assert.equal((await f.store.findTask(U1, old.task_id))!.status, "vencida");
    const swept = await f.store.findTask(U1, run.task_id);
    assert.equal(swept!.status, "fallida");
    assert.ok(swept!.finished_at);
  });

  T("tareas: prune borra las terminadas viejas y no las vivas", async (f) => {
    const d = await newDevice(f);
    const done = await f.store.insertTask(task(U1, d.device_id, "hecha", -1000));
    await f.store.updateTask(U1, done.task_id, { status: "cancelada", finished_at: iso(-900) }, ["en_cola"]);
    const live = await f.store.insertTask(task(U1, d.device_id, "viva", -1000, 100000));
    await f.store.prune(U1, { events: iso(-5000), approvals: iso(-5000), sessions: iso(-5000), messages: iso(-100), tasks: iso(-100) });
    assert.deepEqual((await f.store.listTasks(U1, 10)).map((t) => t.task_id), [live.task_id]);
  });

  T("runner: setRunnerState guarda los nombres y el último contacto", async (f) => {
    const d = await newDevice(f);
    await f.store.setRunnerState(d.device_id, ["finapp", "vera"], iso(5));
    const found = await f.store.findDevice(d.device_id);
    assert.deepEqual(found!.runner_projects, ["finapp", "vera"]);
    same(found!.runner_seen_at, iso(5));
  });

  // --- 014: retomar

  T("retomar: el reclamo para retomar y el del hook Stop son excluyentes (un solo ganador)", async (f) => {
    const d = await withSession(f);
    const m = await f.store.insertMessage(msg(U1, d.device_id, "s1", "hola", 0));
    const taskId = crypto.randomUUID();
    assert.equal(await f.store.claimMessageForResume(U1, m.message_id, taskId, iso(5)), true);
    assert.equal(await f.store.claimMessageForResume(U1, m.message_id, crypto.randomUUID(), iso(6)), false, "ya lo tiene otra tarea");
    assert.equal(await f.store.claimNextMessage(U1, "s1", iso(10)), null, "el hook Stop ya no lo ve");

    const m2 = await f.store.insertMessage(msg(U1, d.device_id, "s1", "otro", 1));
    assert.ok(await f.store.claimNextMessage(U1, "s1", iso(10)), "el Stop reclama primero");
    assert.equal(await f.store.claimMessageForResume(U1, m2.message_id, crypto.randomUUID(), iso(11)), false, "entonces el runner no lo retoma");
  });

  T("retomar: listStalledMessages respeta umbral, dispositivo, usuario, vencimiento y estado", async (f) => {
    const d = await withSession(f);
    const other = await newDevice(f, U2);
    await f.store.saveSession(session(U2, other.device_id, "s1"));
    await f.store.insertMessage(msg(U1, d.device_id, "s1", "viejo", 0));
    await f.store.insertMessage(msg(U1, d.device_id, "s1", "reciente", 50));
    await f.store.insertMessage(msg(U1, d.device_id, "s1", "vence", 1, 5));
    await f.store.insertMessage(msg(U2, other.device_id, "s1", "ajeno", 0));
    const rows = await f.store.listStalledMessages(U1, d.device_id, iso(30), iso(20), 10);
    assert.deepEqual(rows.map((m) => m.body), ["viejo"], "reciente (50 s > umbral), vencido y ajeno quedan fuera");
    assert.deepEqual((await f.store.listStalledMessages(U1, d.device_id, iso(30), iso(3), 10)).map((m) => m.body), ["viejo", "vence"], "más viejos primero; sin vencer todavía");
    assert.deepEqual((await f.store.listStalledMessages(U1, d.device_id, iso(30), iso(4000), 10)).map((m) => m.body), [], "vencidos fuera");
  });

  T("retomar: liberar devuelve a la cola; cerrar marca entregado o no_retomado con el motivo", async (f) => {
    const d = await withSession(f);
    const a = await f.store.insertMessage(msg(U1, d.device_id, "s1", "a", 0));
    const b = await f.store.insertMessage(msg(U1, d.device_id, "s1", "b", 1));
    const t1 = crypto.randomUUID();
    const t2 = crypto.randomUUID();
    await f.store.claimMessageForResume(U1, a.message_id, t1, iso(20));
    await f.store.claimMessageForResume(U1, b.message_id, t2, iso(20));
    await f.store.releaseResumeMessages(U1, t1);
    await f.store.settleResumeMessages(U1, t2, { ok: false, error: "proyecto no autorizado en la laptop" });
    const rows = await f.store.listSessionMessages(U1, "s1", 10);
    const byBody = Object.fromEntries(rows.map((m) => [m.body, m]));
    assert.equal(byBody["a"]!.status, "en_cola");
    assert.equal(byBody["a"]!.resume_task_id, null);
    assert.equal(byBody["b"]!.status, "no_retomado");
    assert.equal(byBody["b"]!.error, "proyecto no autorizado en la laptop");
    await f.store.claimMessageForResume(U1, a.message_id, t1, iso(20));
    await f.store.settleResumeMessages(U1, t1, { ok: true, atIso: iso(50) });
    const done = (await f.store.listSessionMessages(U1, "s1", 10)).find((m) => m.body === "a")!;
    assert.equal(done.status, "entregado");
    same(done.delivered_at, iso(50));
  });
}
