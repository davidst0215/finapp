// Pruebas de la orquestación de notify(): base de datos y fetch simulados. Se corren con Deno, no con Node:
//   deno test -A --config <deno.json> supabase/functions/_shared/notify_test.ts
// Lo que se comprueba es el contrato: notify() deja el aviso en la bandeja pase lo que pase con el push, y el push
// deja constancia (último envío bueno, fallos, suscripciones caducadas, pushed_at).
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createECDH, randomBytes } from "node:crypto";
import { notify, notifyDetailed } from "./notify.ts";

const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");

// Claves VAPID de la prueba
const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const VAPID_PUBLIC = b64u(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
const VAPID_PRIVATE = (await crypto.subtle.exportKey("jwk", kp.privateKey)).d!;
const configurar = () => {
  Deno.env.set("VAPID_PUBLIC_KEY", VAPID_PUBLIC);
  Deno.env.set("VAPID_PRIVATE_KEY", VAPID_PRIVATE);
  Deno.env.set("VAPID_SUBJECT", "mailto:salguedotarazona@gmail.com");
};
configurar();

// Dispositivo simulado (claves de navegador válidas para poder cifrar)
function suscripcion(id: string, endpoint: string, failures = 0) {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  return { subscription_id: id, endpoint, p256dh: b64u(ua.getPublicKey()), auth: b64u(randomBytes(16)), failures };
}

// fetch simulado: responde según el endpoint y recuerda a quién se le envió
const estados = new Map<string, number | "red">();
const enviados: string[] = [];
const fetchOriginal = globalThis.fetch;
function simularFetch() {
  estados.clear();
  enviados.length = 0;
  globalThis.fetch = (input: string | URL | Request) => {
    const url = String(input);
    enviados.push(url);
    const estado = estados.get(url) ?? 201;
    if (estado === "red") return Promise.reject(new TypeError("fetch failed"));
    return Promise.resolve(new Response(null, { status: estado }));
  };
}

// Base de datos simulada con la cadena mínima de supabase-js
type Op = { table: string; op: string; values?: Record<string, unknown>; filters: Array<[string, string, unknown]> };
function bdSimulada(opts: { subs?: unknown[]; fallaLeerSubs?: boolean; fallaInsert?: boolean }) {
  const ops: Op[] = [];
  const from = (table: string) => {
    const estado: Op = { table, op: "select", filters: [] };
    // deno-lint-ignore no-explicit-any
    const api: any = {
      insert: (values: Record<string, unknown>) => ((estado.op = "insert"), (estado.values = values), api),
      update: (values: Record<string, unknown>) => ((estado.op = "update"), (estado.values = values), api),
      delete: () => ((estado.op = "delete"), api),
      select: () => api,
      single: () => api,
      eq: (col: string, val: unknown) => (estado.filters.push(["eq", col, val]), api),
      in: (col: string, val: unknown) => (estado.filters.push(["in", col, val]), api),
      // deno-lint-ignore no-explicit-any
      then: (resolve: (v: any) => void) => {
        ops.push(estado);
        if (table === "notifications" && estado.op === "insert") {
          resolve(opts.fallaInsert ? { data: null, error: { message: "boom" } } : { data: { notification_id: "n-1" }, error: null });
        } else if (table === "push_subscriptions" && estado.op === "select") {
          resolve(opts.fallaLeerSubs ? { data: null, error: { message: "la tabla no existe" } } : { data: opts.subs ?? [], error: null });
        } else resolve({ data: null, error: null });
      },
    };
    return api;
  };
  // deno-lint-ignore no-explicit-any
  return { db: { from } as any, ops };
}

const aviso = { kind: "pago" as const, title: "Netflix vence mañana", body: "S/ 45.90", url: "/recurring" };
const soloPush = (ops: Op[], op: string) => ops.filter((o) => o.table === "push_subscriptions" && o.op === op);

async function conFetchSimulado(prueba: () => Promise<void>) {
  simularFetch();
  configurar();
  try {
    await prueba();
  } finally {
    globalThis.fetch = fetchOriginal;
  }
}

Deno.test("dos dispositivos: el bueno se anota, el caducado (410) se borra y el aviso queda marcado como enviado", () =>
  conFetchSimulado(async () => {
    const buena = suscripcion("s-ok", "https://fcm.googleapis.com/fcm/send/ok", 3);
    const muerta = suscripcion("s-gone", "https://fcm.googleapis.com/fcm/send/muerta");
    estados.set(muerta.endpoint, 410);
    const { db, ops } = bdSimulada({ subs: [buena, muerta] });

    const r = await notifyDetailed(db, "user-1", aviso);

    assert.equal(r.id, "n-1");
    assert.deepEqual(r.push, { devices: 2, sent: 1, removed: 1, failed: 0, statuses: [201, 410] });
    assert.equal(enviados.length, 2);
    assert.deepEqual(soloPush(ops, "select")[0]!.filters, [["eq", "user_id", "user-1"]], "solo lee las suscripciones del dueño del aviso");
    const bueno = soloPush(ops, "update")[0]!;
    assert.equal(bueno.values!.failures, 0);
    assert.equal(typeof bueno.values!.last_ok_at, "string");
    assert.deepEqual(bueno.filters, [["in", "subscription_id", ["s-ok"]]]);
    assert.deepEqual(soloPush(ops, "delete")[0]!.filters, [["in", "subscription_id", ["s-gone"]]]);
    const marca = ops.find((o) => o.table === "notifications" && o.op === "update")!;
    assert.equal(typeof marca.values!.pushed_at, "string");
    assert.deepEqual(marca.filters, [["eq", "notification_id", "n-1"]]);
  }));

Deno.test("fallo pasajero (503) y caída de red: se cuentan, no se borra nada y notify() no falla", () =>
  conFetchSimulado(async () => {
    const lenta = suscripcion("s-503", "https://fcm.googleapis.com/fcm/send/lenta", 2);
    const caida = suscripcion("s-red", "https://updates.push.services.mozilla.com/wpush/v2/caida");
    estados.set(lenta.endpoint, 503);
    estados.set(caida.endpoint, "red");
    const { db, ops } = bdSimulada({ subs: [lenta, caida] });

    assert.equal(await notify(db, "user-1", aviso), "n-1");

    const fallos = Object.fromEntries(soloPush(ops, "update").map((u) => [u.filters[0]![2] as string, u.values!.failures]));
    assert.deepEqual(fallos, { "s-503": 3, "s-red": 1 });
    assert.equal(ops.some((o) => o.op === "delete"), false);
    assert.equal(ops.some((o) => o.table === "notifications" && o.op === "update"), false, "sin envíos buenos no hay pushed_at");
  }));

Deno.test("sin dispositivos o sin poder leerlos, el aviso igual queda en la bandeja", () =>
  conFetchSimulado(async () => {
    let { db } = bdSimulada({ subs: [] });
    let r = await notifyDetailed(db, "user-1", aviso);
    assert.equal(r.id, "n-1");
    assert.equal(r.push.devices, 0);
    assert.equal(enviados.length, 0);

    // Migración 006 sin aplicar: la tabla no existe
    ({ db } = bdSimulada({ fallaLeerSubs: true }));
    r = await notifyDetailed(db, "user-1", aviso);
    assert.equal(r.id, "n-1");
    assert.equal(r.push.devices, 0);
  }));

Deno.test("si falla el insert devuelve null y ni intenta el push", () =>
  conFetchSimulado(async () => {
    const { db, ops } = bdSimulada({ fallaInsert: true, subs: [suscripcion("s-1", "https://fcm.googleapis.com/fcm/send/x")] });
    const r = await notifyDetailed(db, "user-1", aviso);
    assert.equal(r.id, null);
    assert.equal(ops.some((o) => o.table === "push_subscriptions"), false);
    assert.equal(enviados.length, 0);
  }));

Deno.test("defensa en profundidad: una fila con endpoint interno no recibe POST y cuenta como fallo", () =>
  conFetchSimulado(async () => {
    const interna = suscripcion("s-ssrf", "http://169.254.169.254/latest/meta-data");
    const { db, ops } = bdSimulada({ subs: [interna] });
    const r = await notifyDetailed(db, "user-1", aviso);
    assert.equal(enviados.length, 0);
    assert.equal(r.push.failed, 1);
    assert.equal(soloPush(ops, "update")[0]!.values!.failures, 1);
  }));

Deno.test("al décimo fallo seguido la suscripción se borra", () =>
  conFetchSimulado(async () => {
    const mala = suscripcion("s-mala", "https://fcm.googleapis.com/fcm/send/mala", 9);
    estados.set(mala.endpoint, 403);
    const { db, ops } = bdSimulada({ subs: [mala] });
    await notifyDetailed(db, "user-1", aviso);
    assert.deepEqual(soloPush(ops, "delete")[0]!.filters, [["in", "subscription_id", ["s-mala"]]]);
    assert.equal(soloPush(ops, "update").length, 0);
  }));

Deno.test("notify() con EdgeRuntime devuelve el id sin esperar al push (waitUntil)", () =>
  conFetchSimulado(async () => {
    const pendientes: Promise<unknown>[] = [];
    // deno-lint-ignore no-explicit-any
    (globalThis as any).EdgeRuntime = { waitUntil: (p: Promise<unknown>) => pendientes.push(p) };
    try {
      let liberar!: () => void;
      const compuerta = new Promise<void>((r) => (liberar = r));
      globalThis.fetch = async () => (await compuerta, new Response(null, { status: 201 }));
      const { db } = bdSimulada({ subs: [suscripcion("s-1", "https://fcm.googleapis.com/fcm/send/x")] });
      assert.equal(await notify(db, "user-1", aviso), "n-1");
      assert.equal(pendientes.length, 1, "el push quedó en segundo plano");
      liberar();
      await Promise.all(pendientes);
    } finally {
      // deno-lint-ignore no-explicit-any
      delete (globalThis as any).EdgeRuntime;
    }
  }));

Deno.test("sin claves VAPID ni se consultan las suscripciones: solo bandeja", () =>
  conFetchSimulado(async () => {
    Deno.env.delete("VAPID_PRIVATE_KEY");
    const { db, ops } = bdSimulada({ subs: [suscripcion("s-1", "https://fcm.googleapis.com/fcm/send/x")] });
    const r = await notifyDetailed(db, "user-1", aviso);
    assert.equal(r.id, "n-1");
    assert.equal(r.push.devices, 0);
    assert.equal(ops.some((o) => o.table === "push_subscriptions"), false);
  }));
