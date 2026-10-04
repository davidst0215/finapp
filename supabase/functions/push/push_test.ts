// Pruebas del handler de la función `push` con un Supabase simulado en memoria (Auth + PostgREST sobre HTTP real
// en localhost, así supabase-js arma las consultas de verdad). Se corren con Deno, no con Node:
//   deno test -A --config <deno.json> supabase/functions/push/push_test.ts
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createECDH, randomBytes } from "node:crypto";

const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");

// ── Supabase simulado ───────────────────────────────────────────────────────
type Fila = Record<string, unknown>;
const USER = "00000000-0000-0000-0000-0000000000d1";
const TOKEN = "token-de-david";
const tablas: Record<string, Fila[]> = { notifications: [], push_subscriptions: [] };

function filtrar(filas: Fila[], params: URLSearchParams): Fila[] {
  const reservados = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);
  let salida = filas;
  for (const [col, crudo] of params) {
    if (reservados.has(col)) continue;
    const punto = crudo.indexOf(".");
    const op = crudo.slice(0, punto);
    const val = crudo.slice(punto + 1);
    salida = salida.filter((f) => {
      const v = f[col];
      if (op === "eq") return String(v) === val;
      if (op === "neq") return String(v) !== val;
      if (op === "is") return val === "null" ? v === null || v === undefined : String(v) === val;
      if (op === "in") return val.slice(1, -1).split(",").map((s) => s.replace(/^"|"$/g, "")).includes(String(v));
      throw new Error(`operador no soportado: ${op}`);
    });
  }
  return salida;
}

const porDefecto: Record<string, () => Fila> = {
  notifications: () => ({ notification_id: crypto.randomUUID(), created_at: new Date().toISOString(), read_at: null, pushed_at: null }),
  push_subscriptions: () => ({ subscription_id: crypto.randomUUID(), created_at: new Date().toISOString(), last_ok_at: null, failures: 0 }),
};

const jsonRes = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...extra } });

async function supabaseSimulado(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/auth/v1/user") {
    if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return jsonRes({ msg: "invalid JWT" }, 401);
    return jsonRes({ id: USER, aud: "authenticated", role: "authenticated", email: "david@sayainvestments.co", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" });
  }
  const m = /^\/rest\/v1\/(\w+)$/.exec(url.pathname);
  const tabla = m && tablas[m[1]!];
  if (!m || !tabla) return jsonRes({ message: "no encontrado" }, 404);
  const prefer = req.headers.get("prefer") ?? "";
  const unObjeto = (req.headers.get("accept") ?? "").includes("vnd.pgrst.object");

  if (req.method === "GET" || req.method === "HEAD") {
    let filas = filtrar(tabla, url.searchParams);
    const total = filas.length;
    const orden = url.searchParams.get("order");
    if (orden) {
      const [col, dir] = orden.split(".");
      filas = [...filas].sort((a, b) => (String(a[col!]) < String(b[col!]) ? -1 : 1));
      if (dir === "desc") filas.reverse();
    }
    const limite = url.searchParams.get("limit");
    if (limite) filas = filas.slice(0, Number(limite));
    const cabeceras: Record<string, string> = prefer.includes("count=exact") ? { "content-range": `0-${Math.max(0, filas.length - 1)}/${total}` } : {};
    if (req.method === "HEAD") return new Response(null, { status: 200, headers: cabeceras });
    return jsonRes(unObjeto ? filas[0] : filas, 200, cabeceras);
  }
  if (req.method === "POST") {
    const cuerpo = await req.json();
    const items: Fila[] = Array.isArray(cuerpo) ? cuerpo : [cuerpo];
    const conflicto = url.searchParams.get("on_conflict");
    const guardadas = items.map((item) => {
      const existente = conflicto ? tabla.find((f) => f[conflicto] === item[conflicto]) : undefined;
      if (existente) return Object.assign(existente, item);
      const fila = { ...porDefecto[m[1]!]!(), ...item };
      tabla.push(fila);
      return fila;
    });
    return prefer.includes("return=representation") ? jsonRes(unObjeto ? guardadas[0] : guardadas, 201) : new Response(null, { status: 201 });
  }
  if (req.method === "PATCH") {
    const cambios = await req.json();
    const filas = filtrar(tabla, url.searchParams);
    filas.forEach((f) => Object.assign(f, cambios));
    return prefer.includes("return=representation") ? jsonRes(filas, 200) : new Response(null, { status: 204 });
  }
  if (req.method === "DELETE") {
    const borrar = new Set(filtrar(tabla, url.searchParams));
    tablas[m[1]!] = tabla.filter((f) => !borrar.has(f));
    tabla.length = 0;
    tabla.push(...tablas[m[1]!]!);
    return new Response(null, { status: 204 });
  }
  return jsonRes({ message: "método no soportado" }, 405);
}

const servidor = Deno.serve({ port: 0, onListen: () => {} }, supabaseSimulado);
const puerto = (servidor.addr as Deno.NetAddr).port;

// ── Entorno de la función ───────────────────────────────────────────────────
const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const VAPID_PUBLIC = b64u(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
const VAPID_PRIVATE = (await crypto.subtle.exportKey("jwk", kp.privateKey)).d!;
Deno.env.set("SUPABASE_URL", `http://127.0.0.1:${puerto}`);
Deno.env.set("SUPABASE_ANON_KEY", "anon");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service");
const configurarVapid = () => {
  Deno.env.set("VAPID_PUBLIC_KEY", VAPID_PUBLIC);
  Deno.env.set("VAPID_PRIVATE_KEY", VAPID_PRIVATE);
  Deno.env.set("VAPID_SUBJECT", "mailto:salguedotarazona@gmail.com");
};
configurarVapid();

// fetch: lo que va al Supabase simulado pasa; lo que va a un push service lo contesta la prueba
const fetchOriginal = globalThis.fetch;
const enviadosAPush: string[] = [];
let estadoPush = 201;
globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "127.0.0.1") return fetchOriginal(input, init);
  enviadosAPush.push(url.href);
  return Promise.resolve(new Response(null, { status: estadoPush }));
};

// La función registra su handler con Deno.serve al importarse: se captura en lugar de abrir un puerto.
let handler!: (req: Request) => Promise<Response> | Response;
const serveOriginal = Deno.serve;
// deno-lint-ignore no-explicit-any
(Deno as any).serve = (h: typeof handler) => ((handler = h), { finished: Promise.resolve() });
await import("./index.ts");
Deno.serve = serveOriginal;

function llamar(cuerpo: unknown, opts: { token?: string | null; metodo?: string; crudo?: string } = {}) {
  const headers = new Headers({ "content-type": "application/json", "user-agent": "Mozilla/5.0 (Linux; Android 15) Chrome/130 Mobile" });
  const token = opts.token === undefined ? TOKEN : opts.token;
  if (token) headers.set("authorization", `Bearer ${token}`);
  return Promise.resolve(handler(new Request("http://localhost/push", {
    method: opts.metodo ?? "POST",
    headers,
    body: (opts.metodo ?? "POST") === "GET" ? undefined : (opts.crudo ?? JSON.stringify(cuerpo)),
  })));
}

function navegador() {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${b64u(randomBytes(24))}`,
    expirationTime: null,
    keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(randomBytes(16)) },
  };
}

const limpiar = () => {
  tablas.notifications.length = 0;
  tablas.push_subscriptions.length = 0;
  enviadosAPush.length = 0;
  estadoPush = 201;
  configurarVapid();
};

// ── Pruebas ─────────────────────────────────────────────────────────────────
Deno.test("protocolo: OPTIONS responde CORS, GET no, sin sesión 401, JSON roto 400, acción desconocida 400", async () => {
  limpiar();
  const preflight = await llamar(null, { metodo: "OPTIONS" });
  assert.equal(preflight.status, 200);
  assert.ok(preflight.headers.get("access-control-allow-headers")?.includes("authorization"));
  assert.equal((await llamar(null, { metodo: "GET" })).status, 405);
  assert.equal((await llamar({ action: "inbox" }, { token: null })).status, 401);
  assert.equal((await llamar({ action: "inbox" }, { token: "anon-key-o-token-ajeno" })).status, 401);
  assert.equal((await llamar(null, { crudo: "{no es json" })).status, 400);
  assert.equal((await llamar(null, { crudo: "[1,2]" })).status, 400);
  const desconocida = await llamar({ action: "borrar-todo" });
  assert.equal(desconocida.status, 400);
  assert.deepEqual(await desconocida.json(), { error: "Acción desconocida" });
});

Deno.test("vapid-key devuelve la clave pública; sin configurar responde 503", async () => {
  limpiar();
  const ok = await llamar({ action: "vapid-key" });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { publicKey: VAPID_PUBLIC });
  Deno.env.delete("VAPID_PUBLIC_KEY");
  assert.equal((await llamar({ action: "vapid-key" })).status, 503);
});

Deno.test("subscribe guarda el dispositivo a nombre del usuario del JWT y no duplica al repetirse", async () => {
  limpiar();
  const sub = navegador();
  const r = await llamar({ action: "subscribe", subscription: sub, user_id: "otro-usuario" }); // el user_id del cuerpo se ignora
  assert.equal(r.status, 200);
  assert.equal(tablas.push_subscriptions.length, 1);
  const fila = tablas.push_subscriptions[0]!;
  assert.equal(fila.user_id, USER);
  assert.equal(fila.endpoint, sub.endpoint);
  assert.equal(fila.p256dh, sub.keys.p256dh);
  assert.equal(fila.auth, sub.keys.auth);
  assert.match(String(fila.user_agent), /Android/);

  fila.failures = 4;
  assert.equal((await llamar({ action: "subscribe", subscription: sub })).status, 200);
  assert.equal(tablas.push_subscriptions.length, 1, "mismo endpoint: se actualiza");
  assert.equal(tablas.push_subscriptions[0]!.failures, 0, "y los fallos vuelven a cero");
});

Deno.test("subscribe rechaza lo que no es un push service, claves rotas y más de 10 dispositivos", async () => {
  limpiar();
  const interno = { ...navegador(), endpoint: "http://169.254.169.254/latest/meta-data" };
  const r = await llamar({ action: "subscribe", subscription: interno });
  assert.equal(r.status, 400);
  assert.equal(tablas.push_subscriptions.length, 0, "nada se guarda");

  const sinClaves = { endpoint: navegador().endpoint };
  assert.equal((await llamar({ action: "subscribe", subscription: sinClaves })).status, 400);
  const fueraDeCurva = { ...navegador(), keys: { p256dh: b64u(new Uint8Array([4, ...new Uint8Array(64).fill(7)])), auth: b64u(randomBytes(16)) } };
  assert.equal((await llamar({ action: "subscribe", subscription: fueraDeCurva })).status, 400);
  assert.equal((await llamar({ action: "subscribe" })).status, 400);

  for (let i = 0; i < 10; i++) assert.equal((await llamar({ action: "subscribe", subscription: navegador() })).status, 200);
  const undecimo = await llamar({ action: "subscribe", subscription: navegador() });
  assert.equal(undecimo.status, 409);
  assert.equal(tablas.push_subscriptions.length, 10);
  // Un dispositivo ya registrado puede renovar su suscripción aunque el tope esté lleno
  const existente = tablas.push_subscriptions[3]!;
  const renovar = { endpoint: existente.endpoint, keys: { p256dh: existente.p256dh, auth: existente.auth } };
  assert.equal((await llamar({ action: "subscribe", subscription: renovar })).status, 200);
});

Deno.test("unsubscribe quita solo ese dispositivo", async () => {
  limpiar();
  const a = navegador();
  const b = navegador();
  await llamar({ action: "subscribe", subscription: a });
  await llamar({ action: "subscribe", subscription: b });
  assert.equal((await llamar({ action: "unsubscribe", endpoint: a.endpoint })).status, 200);
  assert.deepEqual(tablas.push_subscriptions.map((f) => f.endpoint), [b.endpoint]);
  assert.equal((await llamar({ action: "unsubscribe" })).status, 400);
  assert.equal((await llamar({ action: "unsubscribe", endpoint: a.endpoint })).status, 200, "idempotente");
});

Deno.test("test crea el aviso, lo envía por push al dispositivo y lo deja marcado", async () => {
  limpiar();
  const sub = navegador();
  await llamar({ action: "subscribe", subscription: sub });

  const r = await llamar({ action: "test" });
  assert.equal(r.status, 200);
  const cuerpo = await r.json();
  assert.equal(cuerpo.ok, true);
  assert.equal(cuerpo.configured, true);
  assert.deepEqual({ devices: cuerpo.devices, sent: cuerpo.sent, removed: cuerpo.removed, failed: cuerpo.failed }, { devices: 1, sent: 1, removed: 0, failed: 0 });
  assert.deepEqual(enviadosAPush, [sub.endpoint]);

  assert.equal(tablas.notifications.length, 1);
  const aviso = tablas.notifications[0]!;
  assert.equal(aviso.user_id, USER);
  assert.equal(aviso.kind, "sistema");
  assert.equal(aviso.url, "/avisos");
  assert.equal(typeof aviso.pushed_at, "string", "pushed_at");
  assert.equal(typeof tablas.push_subscriptions[0]!.last_ok_at, "string", "last_ok_at");
});

Deno.test("test con el dispositivo caducado (410) lo borra; sin claves VAPID deja el aviso solo en la bandeja", async () => {
  limpiar();
  await llamar({ action: "subscribe", subscription: navegador() });
  estadoPush = 410;
  const caducado = await (await llamar({ action: "test" })).json();
  assert.deepEqual({ devices: caducado.devices, sent: caducado.sent, removed: caducado.removed }, { devices: 1, sent: 0, removed: 1 });
  assert.equal(tablas.push_subscriptions.length, 0, "suscripción borrada");

  limpiar();
  await llamar({ action: "subscribe", subscription: navegador() });
  Deno.env.delete("VAPID_PRIVATE_KEY");
  const sinClaves = await (await llamar({ action: "test" })).json();
  assert.equal(sinClaves.configured, false);
  assert.equal(sinClaves.devices, 0);
  assert.equal(tablas.notifications.length, 1, "el aviso queda en la bandeja");
  assert.equal(enviadosAPush.length, 0);
});

Deno.test("inbox lista del más nuevo al más viejo, cuenta los no leídos y no entrega rutas ajenas a la app", async () => {
  limpiar();
  const hace = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  tablas.notifications.push(
    { notification_id: "11111111-1111-1111-1111-111111111111", user_id: USER, kind: "pago", title: "Viejo", body: "", url: "/recurring", created_at: hace(300), read_at: hace(200) },
    { notification_id: "22222222-2222-2222-2222-222222222222", user_id: USER, kind: "brief", title: "Nuevo", body: "x", url: "/brief", created_at: hace(1), read_at: null },
    { notification_id: "33333333-3333-3333-3333-333333333333", user_id: USER, kind: "correo", title: "Con ruta ajena", body: "", url: "https://evil.example/robo", created_at: hace(60), read_at: null },
    { notification_id: "44444444-4444-4444-4444-444444444444", user_id: "otro-usuario", kind: "pago", title: "De otro", body: "", url: null, created_at: hace(2), read_at: null },
  );
  const r = await llamar({ action: "inbox" });
  assert.equal(r.status, 200);
  const { items, unread } = await r.json();
  assert.deepEqual(items.map((n: { title: string }) => n.title), ["Nuevo", "Con ruta ajena", "Viejo"], "solo los del usuario, del más nuevo al más viejo");
  assert.equal(unread, 2);
  assert.equal(items[1].url, null, "la ruta ajena a la app no sale");
  assert.deepEqual(Object.keys(items[0]).sort(), ["body", "createdAt", "id", "kind", "readAt", "title", "url"]);
  const limitado = await (await llamar({ action: "inbox", limit: 1 })).json();
  assert.equal(limitado.items.length, 1);
  assert.equal(limitado.unread, 2, "el contador no depende del límite");
});

Deno.test("read marca los avisos indicados o todos, ignora ids inválidos y no toca los de otro usuario", async () => {
  limpiar();
  const a = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const b = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const ajeno = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  tablas.notifications.push(
    { notification_id: a, user_id: USER, kind: "pago", title: "A", body: "", url: null, created_at: new Date().toISOString(), read_at: null },
    { notification_id: b, user_id: USER, kind: "pago", title: "B", body: "", url: null, created_at: new Date().toISOString(), read_at: null },
    { notification_id: ajeno, user_id: "otro-usuario", kind: "pago", title: "C", body: "", url: null, created_at: new Date().toISOString(), read_at: null },
  );
  assert.equal((await llamar({ action: "read" })).status, 400);
  assert.equal((await llamar({ action: "read", ids: ["no-es-uuid", 7, null] })).status, 400);

  const uno = await (await llamar({ action: "read", ids: [a, ajeno, "basura"] })).json();
  assert.equal(uno.updated, 1, "el aviso de otro usuario no cuenta");
  assert.equal(typeof tablas.notifications.find((n) => n.notification_id === a)!.read_at, "string");
  assert.equal(tablas.notifications.find((n) => n.notification_id === b)!.read_at, null);
  assert.equal(tablas.notifications.find((n) => n.notification_id === ajeno)!.read_at, null);

  const todos = await (await llamar({ action: "read", all: true })).json();
  assert.equal(todos.updated, 1);
  assert.equal(tablas.notifications.find((n) => n.notification_id === ajeno)!.read_at, null, "all:true solo afecta al usuario del JWT");
});

Deno.test("cierre", async () => {
  globalThis.fetch = fetchOriginal;
  await servidor.shutdown();
});
