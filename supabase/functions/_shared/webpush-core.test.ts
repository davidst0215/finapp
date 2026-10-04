// Pruebas de la lógica pura del envío Web Push. Corren en Node:
//   node --experimental-strip-types --test supabase/functions/_shared/webpush-core.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, verify as nodeVerify } from "node:crypto";
import {
  buildPushPayload,
  classifyPushStatus,
  decodeBase64Url,
  encodeBase64Url,
  isAllowedPushHost,
  isSafeAppPath,
  nextFailureCount,
  normalizeVapidSubject,
  parseSubscriptionInput,
  pushPolicyFor,
  shouldDropSubscription,
  summarizePush,
  vapidJwkFromRaw,
} from "./webpush-core.ts";

test("classifyPushStatus: 2xx es entregado", () => {
  for (const status of [200, 201, 202, 204]) assert.equal(classifyPushStatus(status), "ok", String(status));
});

test("classifyPushStatus: 404 y 410 son suscripción caducada (se borra)", () => {
  // FCM responde 404 a un token que ya no existe; RFC 8030 define 410. Ambos significan "no insistas".
  assert.equal(classifyPushStatus(404), "gone");
  assert.equal(classifyPushStatus(410), "gone");
});

test("classifyPushStatus: 408, 429 y 5xx son fallos pasajeros (se conserva la suscripción)", () => {
  for (const status of [408, 429, 500, 502, 503, 504]) assert.equal(classifyPushStatus(status), "transient", String(status));
});

test("classifyPushStatus: el resto de 4xx, 3xx y valores raros es rechazo", () => {
  for (const status of [400, 401, 403, 413, 422, 301, 302, 100, 0, -1, Number.NaN]) {
    assert.equal(classifyPushStatus(status), "rejected", String(status));
  }
});

test("nextFailureCount: un envío bueno reinicia el contador, cualquier otro suma uno", () => {
  assert.equal(nextFailureCount(7, "ok"), 0);
  assert.equal(nextFailureCount(0, "transient"), 1);
  assert.equal(nextFailureCount(3, "rejected"), 4);
  assert.equal(nextFailureCount(3, "gone"), 4);
  assert.equal(nextFailureCount(3, "error"), 4);
});

const NOW = 1_759_600_000_000;

test("buildPushPayload: arma el JSON que lee el service worker", () => {
  const raw = buildPushPayload({ id: "n-1", kind: "pago", title: "Netflix vence mañana", body: "S/ 45.90", url: "/recurring" }, NOW);
  assert.deepEqual(JSON.parse(raw), {
    v: 1, id: "n-1", kind: "pago", title: "Netflix vence mañana", body: "S/ 45.90", url: "/recurring", ts: NOW,
  });
});

test("buildPushPayload: sin cuerpo, id ni url, apunta a la bandeja", () => {
  const data = JSON.parse(buildPushPayload({ kind: "sistema", title: "  Hola  " }, NOW));
  assert.deepEqual(data, { v: 1, id: null, kind: "sistema", title: "Hola", body: "", url: "/avisos", ts: NOW });
});

test("buildPushPayload: recorta el título a 120 y el cuerpo a 400 con puntos suspensivos", () => {
  const data = JSON.parse(buildPushPayload({ kind: "tarea", title: "t".repeat(200), body: "b".repeat(500) }, NOW));
  assert.equal(data.title, "t".repeat(120));
  assert.equal(data.body, "b".repeat(399) + "…");
  const exacto = JSON.parse(buildPushPayload({ kind: "tarea", title: "x", body: "b".repeat(400) }, NOW));
  assert.equal(exacto.body, "b".repeat(400), "un cuerpo de justo 400 no se toca");
});

test("buildPushPayload: no parte un emoji por la mitad al recortar", () => {
  const data = JSON.parse(buildPushPayload({ kind: "tarea", title: "x", body: "😀".repeat(500) }, NOW));
  assert.equal(data.body, "😀".repeat(399) + "…");
});

test("buildPushPayload: el peor caso cabe en los 3993 bytes de texto que permite RFC 8291", () => {
  const raw = buildPushPayload({
    id: "00000000-0000-0000-0000-000000000000", kind: "brief",
    title: "😀".repeat(300), body: "😀".repeat(900), url: "/" + "ñ".repeat(299),
  }, NOW);
  const bytes = new TextEncoder().encode(raw).length;
  assert.ok(bytes <= 3993, `${bytes} bytes`);
});

test("buildPushPayload: solo deja pasar rutas internas de la app", () => {
  const casos: Array<[string | null | undefined, string]> = [
    ["/tareas", "/tareas"],
    ["/tareas?id=7#nota", "/tareas?id=7#nota"],
    ["https://evil.example/x", "/avisos"],
    ["//evil.example", "/avisos"],
    ["/\\evil.example", "/avisos"],
    ["javascript:alert(1)", "/avisos"],
    ["tareas", "/avisos"],
    ["/con espacio", "/avisos"],
    ["/" + "x".repeat(400), "/avisos"],
    ["", "/avisos"],
    [null, "/avisos"],
    [undefined, "/avisos"],
  ];
  for (const [url, esperado] of casos) {
    const data = JSON.parse(buildPushPayload({ kind: "sistema", title: "x", url }, NOW));
    assert.equal(data.url, esperado, String(url));
  }
});

test("base64url: valores conocidos, con y sin relleno", () => {
  assert.deepEqual([...decodeBase64Url("AQID")], [1, 2, 3]);
  assert.deepEqual([...decodeBase64Url("-__-")], [251, 255, 254]); // "+//+" en base64 estándar
  assert.deepEqual([...decodeBase64Url("AQI=")], [1, 2]);
  assert.deepEqual([...decodeBase64Url("  AQI\n")], [1, 2]);
  assert.equal(encodeBase64Url(Uint8Array.of(251, 255, 254)), "-__-");
  assert.equal(encodeBase64Url(Uint8Array.of(1, 2)), "AQI");
  for (const malo of ["+//+", "AQ I", "A", "AQI=x"]) assert.throws(() => decodeBase64Url(malo), /base64url/, malo);
});

// Par de claves generado por Node, en el formato estándar de `web-push generate-vapid-keys`:
// público = punto sin comprimir de 65 bytes, privado = escalar de 32 bytes, ambos en base64url.
function parVapidDeNode() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = publicKey.export({ type: "spki", format: "der" }); // el punto son los últimos 65 bytes del SPKI
  return {
    publicKey,
    pub: spki.subarray(spki.length - 65).toString("base64url"),
    prv: privateKey.export({ format: "jwk" }).d as string,
  };
}

test("vapidJwkFromRaw: las claves convertidas firman y verifican con las originales", async () => {
  const { publicKey, pub, prv } = parVapidDeNode();
  const jwk = vapidJwkFromRaw(pub, prv);
  const algo = { name: "ECDSA", namedCurve: "P-256" };

  // El público importado por WebCrypto exporta exactamente los 65 bytes de entrada.
  const verifyKey = await crypto.subtle.importKey("jwk", jwk.publicKey, algo, true, ["verify"]);
  assert.equal(encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", verifyKey))), pub);

  // Lo que firma el privado convertido lo verifica el público original de Node.
  const signKey = await crypto.subtle.importKey("jwk", jwk.privateKey, algo, false, ["sign"]);
  const message = new TextEncoder().encode("jwt.de.prueba");
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signKey, message));
  assert.equal(nodeVerify("sha256", message, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature), true);
});

test("normalizeVapidSubject: el contacto VAPID es mailto: o https:// (Apple rechaza otra cosa)", () => {
  assert.equal(normalizeVapidSubject("mailto:salguedotarazona@gmail.com"), "mailto:salguedotarazona@gmail.com");
  assert.equal(normalizeVapidSubject("salguedotarazona@gmail.com"), "mailto:salguedotarazona@gmail.com");
  assert.equal(normalizeVapidSubject(" mailto:a@b.co \n"), "mailto:a@b.co");
  assert.equal(normalizeVapidSubject("https://myfinai.vercel.app"), "https://myfinai.vercel.app");
});

test("vapidJwkFromRaw: tolera espacios y salto de línea (secretos pegados desde un archivo)", () => {
  const { pub, prv } = parVapidDeNode();
  assert.deepEqual(vapidJwkFromRaw(`${pub}\n`, `  ${prv}\r\n`), vapidJwkFromRaw(pub, prv));
});

test("vapidJwkFromRaw: rechaza claves mal formadas con un mensaje que dice cuál variable es", () => {
  const { pub, prv } = parVapidDeNode();
  const sinPrefijo = encodeBase64Url(Uint8Array.of(2, ...new Uint8Array(64)));
  assert.throws(() => vapidJwkFromRaw("", prv), /VAPID_PUBLIC_KEY/);
  assert.throws(() => vapidJwkFromRaw(pub.slice(0, 40), prv), /VAPID_PUBLIC_KEY/);
  assert.throws(() => vapidJwkFromRaw(pub.replace(/.$/, "+"), prv), /VAPID_PUBLIC_KEY/);
  assert.throws(() => vapidJwkFromRaw(sinPrefijo, prv), /VAPID_PUBLIC_KEY/);
  assert.throws(() => vapidJwkFromRaw(pub, ""), /VAPID_PRIVATE_KEY/);
  assert.throws(() => vapidJwkFromRaw(pub, prv.slice(0, 20)), /VAPID_PRIVATE_KEY/);
  assert.throws(() => vapidJwkFromRaw(pub, pub), /VAPID_PRIVATE_KEY/); // la pública pegada en el lugar de la privada
});

// Suscripción tal como la entrega PushSubscription.toJSON() en el navegador.
function suscripcionDeNavegador(over: Record<string, unknown> = {}) {
  const { pub } = parVapidDeNode(); // cualquier punto P-256 sirve como clave del navegador
  return {
    endpoint: "https://fcm.googleapis.com/fcm/send/eXampleToken:APA91bHexample",
    expirationTime: null,
    keys: { p256dh: pub, auth: randomBytes(16).toString("base64url") },
    ...over,
  };
}

test("parseSubscriptionInput: acepta la suscripción que entrega el navegador", () => {
  const sub = suscripcionDeNavegador();
  const r = parseSubscriptionInput(sub);
  assert.ok(r.ok);
  assert.deepEqual(r.value, { endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth });
});

test("parseSubscriptionInput: acepta los push services reales (Chrome, Firefox, Edge, Safari)", () => {
  for (const endpoint of [
    "https://fcm.googleapis.com/wp/dGVzdA",
    "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABexample",
    "https://db5p.notify.windows.com/w/?token=BQYAAAexample",
    "https://web.push.apple.com/QGexample",
  ]) {
    assert.ok(parseSubscriptionInput(suscripcionDeNavegador({ endpoint })).ok, endpoint);
  }
});

test("parseSubscriptionInput: rechaza endpoints que no sean un push service (el servidor haría POST ahí)", () => {
  for (const endpoint of [
    "http://fcm.googleapis.com/fcm/send/x", // sin TLS
    "https://example.com/push",
    "https://fcm.googleapis.com.evil.example/fcm/send/x", // dominio parecido
    "https://evilnotify.windows.com/x", // sufijo sin el punto
    "https://user:clave@fcm.googleapis.com/fcm/send/x", // credenciales
    "https://fcm.googleapis.com:8443/fcm/send/x", // puerto raro
    "https://127.0.0.1/x",
    "https://169.254.169.254/latest/meta-data",
    "https://localhost/x",
    "ftp://fcm.googleapis.com/x",
    "no es una url",
    "https://fcm.googleapis.com/" + "a".repeat(2100),
    "",
  ]) {
    const r = parseSubscriptionInput(suscripcionDeNavegador({ endpoint }));
    assert.equal(r.ok, false, endpoint.slice(0, 60));
  }
});

test("parseSubscriptionInput: rechaza claves que no son las de Web Push", () => {
  const buena = suscripcionDeNavegador();
  const conKeys = (keys: unknown) => parseSubscriptionInput({ ...buena, keys });
  assert.equal(conKeys({ p256dh: buena.keys.p256dh }).ok, false, "falta auth");
  assert.equal(conKeys({ auth: buena.keys.auth }).ok, false, "falta p256dh");
  assert.equal(conKeys({ ...buena.keys, auth: randomBytes(15).toString("base64url") }).ok, false, "auth de 15 bytes");
  assert.equal(conKeys({ ...buena.keys, auth: randomBytes(17).toString("base64url") }).ok, false, "auth de 17 bytes");
  assert.equal(conKeys({ ...buena.keys, p256dh: buena.keys.auth }).ok, false, "p256dh corto");
  assert.equal(conKeys({ ...buena.keys, p256dh: encodeBase64Url(Uint8Array.of(2, ...new Uint8Array(64))) }).ok, false, "sin 0x04");
  assert.equal(conKeys({ ...buena.keys, auth: "no+es/base64url" }).ok, false, "caracteres inválidos");
  assert.equal(conKeys(null).ok, false);
  assert.equal(conKeys("texto").ok, false);
});

test("parseSubscriptionInput: no confía en nada que no sea un objeto con endpoint y keys", () => {
  for (const basura of [null, undefined, "x", 42, [], {}, { endpoint: 7, keys: {} }, { keys: {} }]) {
    const r = parseSubscriptionInput(basura);
    assert.equal(r.ok, false, JSON.stringify(basura));
    if (!r.ok) assert.equal(typeof r.error, "string");
  }
});

test("isAllowedPushHost: solo hosts de push services conocidos", () => {
  for (const host of ["fcm.googleapis.com", "updates.push.services.mozilla.com", "wns2-par02p.notify.windows.com", "web.push.apple.com"]) {
    assert.equal(isAllowedPushHost(host), true, host);
  }
  for (const host of ["googleapis.com", "notify.windows.com", "push.apple.com", "evil.com", "fcm.googleapis.com.evil.com", ""]) {
    assert.equal(isAllowedPushHost(host), false, host);
  }
});

test("summarizePush: cuenta enviados, borrados y fallidos por dispositivo", () => {
  const resumen = summarizePush([
    { outcome: "ok", status: 201 },
    { outcome: "gone", status: 410 },
    { outcome: "transient", status: 503 },
    { outcome: "rejected", status: 403 },
    { outcome: "error", status: null },
  ]);
  assert.deepEqual(resumen, { devices: 5, sent: 1, removed: 1, failed: 3, statuses: [201, 410, 503, 403, null] });
  assert.deepEqual(summarizePush([]), { devices: 0, sent: 0, removed: 0, failed: 0, statuses: [] });
});

test("isSafeAppPath: la bandeja tampoco entrega rutas que saquen al usuario de la app", () => {
  for (const ok of ["/tareas", "/tareas?id=7#nota", "/"]) assert.equal(isSafeAppPath(ok), true, ok);
  for (const mal of ["https://evil.example/x", "//evil.example", "/\\evil.example", "javascript:alert(1)", "tareas", "/con espacio", "", " /tareas", null, undefined, 42]) {
    assert.equal(isSafeAppPath(mal), false, String(mal));
  }
});

test("pushPolicyFor: urgencia y vigencia según el tipo de aviso", () => {
  // Lo que se pierde si llega tarde (permiso de Claude Code, prueba) vive minutos; el brief, horas.
  assert.deepEqual(pushPolicyFor("claude"), { urgency: "high", ttl: 600 });
  assert.deepEqual(pushPolicyFor("sistema"), { urgency: "high", ttl: 600 });
  assert.deepEqual(pushPolicyFor("brief"), { urgency: "high", ttl: 21_600 });
  assert.deepEqual(pushPolicyFor("agenda"), { urgency: "high", ttl: 7_200 });
  assert.deepEqual(pushPolicyFor("pago"), { urgency: "high", ttl: 86_400 });
  for (const kind of ["tarea", "espera", "correo", "otro-tipo"]) {
    assert.deepEqual(pushPolicyFor(kind), { urgency: "normal", ttl: 86_400 }, kind);
  }
});

test("shouldDropSubscription: se borra al llegar a 10 fallos seguidos", () => {
  assert.equal(shouldDropSubscription(9), false);
  assert.equal(shouldDropSubscription(10), true);
  assert.equal(shouldDropSubscription(nextFailureCount(9, "rejected")), true);
  assert.equal(shouldDropSubscription(nextFailureCount(9, "ok")), false);
});
