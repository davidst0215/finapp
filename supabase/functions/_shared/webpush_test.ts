// Pruebas del emisor Web Push (webpush.ts) con fetch simulado. Se corren con Deno, no con Node:
//   deno test -A --config <deno.json> supabase/functions/_shared/webpush_test.ts
// Comprueban el protocolo de punta a punta sin red: lo que sale por fetch (cabeceras, JWT VAPID, cuerpo cifrado)
// lo descifra un descifrador de RFC 8291 escrito aparte, validado antes con el ejemplo oficial del propio RFC.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";

const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");
const unb64u = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

// ── Descifrador independiente (aes128gcm, un solo registro) ─────────────────
function descifrar(body: Uint8Array, uaPrivate: string, uaPublic: Uint8Array, authSecret: Uint8Array): Uint8Array {
  const salt = body.subarray(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const cifrado = body.subarray(21 + idlen);
  assert.ok(cifrado.length <= rs, `registro de ${cifrado.length} bytes mayor que rs=${rs}`);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(uaPrivate, "base64url"));
  const secreto = ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", secreto, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(Buffer.from(cifrado.subarray(cifrado.length - 16)));
  const plano = Buffer.concat([decipher.update(cifrado.subarray(0, cifrado.length - 16)), decipher.final()]);
  let i = plano.length - 1;
  while (i >= 0 && plano[i] === 0) i--;
  assert.equal(plano[i], 2, "delimitador de relleno del último registro");
  return plano.subarray(0, i);
}

// ── Entorno simulado ────────────────────────────────────────────────────────
async function parVapid() {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  return { pub: b64u(pub), prv: jwk.d!, pubKey: kp.publicKey };
}

type Capturado = { url: string; method: string; headers: Headers; body: Uint8Array };
type Respuesta = () => Promise<Response>;

// Cada prueba carga una copia nueva del módulo (el emisor guarda su estado a nivel de módulo).
let copia = 0;
async function entorno(opts: { sinClaves?: boolean; privadaAjena?: boolean } = {}) {
  const A = await parVapid();
  const B = await parVapid();
  Deno.env.set("VAPID_SUBJECT", "salguedotarazona@gmail.com"); // sin mailto: a propósito: se normaliza
  if (opts.sinClaves) {
    Deno.env.delete("VAPID_PUBLIC_KEY");
    Deno.env.delete("VAPID_PRIVATE_KEY");
  } else {
    Deno.env.set("VAPID_PUBLIC_KEY", A.pub);
    Deno.env.set("VAPID_PRIVATE_KEY", opts.privadaAjena ? B.prv : A.prv);
  }

  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const uaPublic = new Uint8Array(ua.getPublicKey());
  const uaPrivate = b64u(ua.getPrivateKey());
  const auth = new Uint8Array(randomBytes(16));
  const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/token-de-prueba", p256dh: b64u(uaPublic), auth: b64u(auth) };

  const estado: { capturado: Capturado | null; responder: Respuesta } = {
    capturado: null,
    responder: () => Promise.resolve(new Response(null, { status: 201 })),
  };
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body instanceof ArrayBuffer ? new Uint8Array(init.body) : (init?.body as Uint8Array);
    estado.capturado = { url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers), body };
    return estado.responder();
  };
  const mod = await import(`./webpush.ts?copia=${++copia}`);
  return { A, sub, uaPublic, uaPrivate, auth, estado, mod, restaurar: () => void (globalThis.fetch = fetchOriginal) };
}

const politica = { urgency: "high" as const, ttl: 600 };
const payload = JSON.stringify({ v: 1, id: "abc", kind: "sistema", title: "Aviso de prueba ✓ ñ", body: "😀 cuerpo", url: "/avisos", ts: 1 });

Deno.test("el descifrador de la prueba reproduce el ejemplo oficial de RFC 8291", () => {
  const cuerpoRfc = unb64u(
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  );
  const uaPublic = unb64u("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
  const texto = new TextDecoder().decode(
    descifrar(cuerpoRfc, "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94", uaPublic, unb64u("BTBZMqHH6r4Tts7J_aSIgg")),
  );
  assert.equal(texto, "When I grow up, I want to be a watermelon");
});

Deno.test("envío: cabeceras, JWT VAPID y cuerpo cifrado que el navegador descifra", async () => {
  const e = await entorno();
  try {
    assert.equal(e.mod.pushConfigured(), true);
    assert.equal(e.mod.vapidPublicKey(), e.A.pub);

    const r = await e.mod.sendPush(e.sub, payload, politica);
    assert.deepEqual(r, { outcome: "ok", status: 201 });

    const c = e.estado.capturado!;
    assert.equal(c.url, e.sub.endpoint);
    assert.equal(c.method, "POST");
    assert.equal(c.headers.get("content-encoding"), "aes128gcm");
    assert.equal(c.headers.get("ttl"), "600");
    assert.equal(c.headers.get("urgency"), "high");
    assert.ok(c.body.length <= 4096, `cuerpo de ${c.body.length} bytes`);

    // Authorization: vapid t=<jwt>, k=<clave pública>
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(c.headers.get("authorization") ?? "");
    assert.ok(m, "formato de la cabecera Authorization");
    const [, h, p, s, k] = m;
    assert.equal(k, e.A.pub);
    const cabecera = JSON.parse(new TextDecoder().decode(unb64u(h!)));
    const claims = JSON.parse(new TextDecoder().decode(unb64u(p!)));
    assert.equal(cabecera.alg, "ES256");
    assert.equal(claims.aud, "https://fcm.googleapis.com");
    assert.equal(claims.sub, "mailto:salguedotarazona@gmail.com");
    const ahora = Date.now() / 1000;
    assert.ok(claims.exp > ahora && claims.exp <= ahora + 24 * 3600, "exp dentro de las 24 h de RFC 8292");
    const firmaOk = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, e.A.pubKey, unb64u(s!), new TextEncoder().encode(`${h}.${p}`));
    assert.equal(firmaOk, true, "la firma del JWT verifica con la clave pública VAPID");

    // El navegador descifra exactamente lo enviado (acentos y emoji incluidos)
    assert.equal(new TextDecoder().decode(descifrar(c.body, e.uaPrivate, e.uaPublic, e.auth)), payload);

    // Sal nueva en cada mensaje
    const primera = b64u(c.body.slice(0, 16));
    await e.mod.sendPush(e.sub, payload, politica);
    assert.notEqual(b64u(e.estado.capturado!.body.slice(0, 16)), primera);
  } finally {
    e.restaurar();
  }
});

Deno.test("respuestas del push service: 404 y 410 caducan, 4xx rechazan, 429 y 5xx son pasajeros", async () => {
  const e = await entorno();
  try {
    const casos: Array<[number, string]> = [[404, "gone"], [410, "gone"], [403, "rejected"], [401, "rejected"], [413, "rejected"], [429, "transient"], [503, "transient"]];
    for (const [status, esperado] of casos) {
      e.estado.responder = () => Promise.resolve(new Response(`{"reason":"prueba"}`, { status }));
      assert.deepEqual(await e.mod.sendPush(e.sub, payload, politica), { outcome: esperado, status }, `HTTP ${status}`);
    }
    e.estado.responder = () => Promise.reject(new TypeError("fetch failed"));
    assert.deepEqual(await e.mod.sendPush(e.sub, payload, politica), { outcome: "error", status: null });
  } finally {
    e.restaurar();
  }
});

Deno.test("una clave p256dh que no es un punto de la curva da error sin lanzar", async () => {
  const e = await entorno();
  try {
    const rota = { ...e.sub, p256dh: b64u(new Uint8Array([4, ...new Uint8Array(64).fill(7)])) };
    assert.deepEqual(await e.mod.sendPush(rota, payload, politica), { outcome: "error", status: null });
    assert.equal(e.estado.capturado, null, "no se envía nada");
  } finally {
    e.restaurar();
  }
});

Deno.test("un par VAPID que no se corresponde no envía nada (el push service lo rechazaría sin explicar por qué)", async () => {
  const e = await entorno({ privadaAjena: true });
  try {
    assert.deepEqual(await e.mod.sendPush(e.sub, payload, politica), { outcome: "error", status: null });
    assert.equal(e.estado.capturado, null);
  } finally {
    e.restaurar();
  }
});

Deno.test("sin claves VAPID: pushConfigured() es falso y no se envía nada", async () => {
  const e = await entorno({ sinClaves: true });
  try {
    assert.equal(e.mod.pushConfigured(), false);
    assert.equal(e.mod.vapidPublicKey(), null);
    assert.deepEqual(await e.mod.sendPush(e.sub, payload, politica), { outcome: "error", status: null });
    assert.equal(e.estado.capturado, null);
  } finally {
    e.restaurar();
  }
});

Deno.test("un push service que no responde corta a los 4 s y no cuelga al módulo que avisó", async () => {
  const e = await entorno();
  try {
    e.estado.responder = () => new Promise(() => {}); // nunca responde
    const t0 = Date.now();
    const r = await e.mod.sendPush(e.sub, payload, politica);
    const dt = Date.now() - t0;
    assert.deepEqual(r, { outcome: "error", status: null });
    assert.ok(dt >= 3_500 && dt < 5_500, `${dt} ms`);
  } finally {
    e.restaurar();
  }
});
