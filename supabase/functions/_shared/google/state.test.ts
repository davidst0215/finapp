// node --experimental-strip-types --test supabase/functions/_shared/google/state.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { base64UrlToUtf8, bytesToBase64Url, utf8ToBase64Url } from "./b64.ts";
import { signState, STATE_TTL_SECONDS, verifyState } from "./state.ts";

const SECRET = "una-llave-de-prueba-de-al-menos-32-caracteres!!";
const USER = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const NOW = Date.UTC(2026, 9, 5, 13, 0, 0);

const hmac = async (secret: string, data: string) => {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data))));
};

describe("state firmado", () => {
  it("firma y verifica: devuelve el user_id y el nonce", async () => {
    const state = await signState(SECRET, USER, NOW, { nonce: "AAAAAAAAAAAAAAAAAAAAAA" });
    const check = await verifyState(SECRET, state, NOW + 1000);
    assert.deepEqual(check, { ok: true, userId: USER, nonce: "AAAAAAAAAAAAAAAAAAAAAA" });
  });

  it("dos estados del mismo usuario no son iguales (nonce aleatorio)", async () => {
    const a = await signState(SECRET, USER, NOW);
    const b = await signState(SECRET, USER, NOW);
    assert.notEqual(a, b);
  });

  it("incluye user_id, nonce y vencimiento corto (10 min)", async () => {
    assert.equal(STATE_TTL_SECONDS, 600);
    const state = await signState(SECRET, USER, NOW);
    const payload = JSON.parse(base64UrlToUtf8(state.split(".")[0] as string) as string);
    assert.equal(payload.uid, USER);
    assert.ok(typeof payload.n === "string" && payload.n.length >= 16);
    assert.equal(payload.exp, Math.floor(NOW / 1000) + 600);
  });

  it("rechaza un state vencido (y justo en el límite)", async () => {
    const state = await signState(SECRET, USER, NOW);
    assert.equal((await verifyState(SECRET, state, NOW + 599_000)).ok, true);
    assert.deepEqual(await verifyState(SECRET, state, NOW + 600_000), { ok: false, reason: "vencido" });
    assert.deepEqual(await verifyState(SECRET, state, NOW + 3_600_000), { ok: false, reason: "vencido" });
  });

  it("rechaza si cambian el contenido (otro user_id con la firma original)", async () => {
    const state = await signState(SECRET, USER, NOW);
    const [payloadB64, sig] = state.split(".") as [string, string];
    const payload = JSON.parse(base64UrlToUtf8(payloadB64) as string);
    payload.uid = "00000000-0000-4000-8000-000000000000";
    const forged = `${utf8ToBase64Url(JSON.stringify(payload))}.${sig}`;
    assert.deepEqual(await verifyState(SECRET, forged, NOW), { ok: false, reason: "firma" });
  });

  it("rechaza si cambian la firma", async () => {
    const state = await signState(SECRET, USER, NOW);
    const flipped = state.slice(0, -2) + (state.endsWith("AA") ? "BB" : "AA");
    assert.deepEqual(await verifyState(SECRET, flipped, NOW), { ok: false, reason: "firma" });
  });

  it("rechaza un state firmado con otra llave", async () => {
    const state = await signState("otra-llave-distinta-de-mas-de-32-caracteres-xx", USER, NOW);
    assert.deepEqual(await verifyState(SECRET, state, NOW), { ok: false, reason: "firma" });
  });

  it("rechaza una firma sin el contexto de dominio (HMAC pelado del payload)", async () => {
    const payload = utf8ToBase64Url(JSON.stringify({ v: 1, uid: USER, n: "AAAAAAAAAAAAAAAAAAAAAA", exp: Math.floor(NOW / 1000) + 600 }));
    const state = `${payload}.${await hmac(SECRET, payload)}`; // sin "wabid.google-oauth.v1."
    assert.deepEqual(await verifyState(SECRET, state, NOW), { ok: false, reason: "firma" });
  });

  it("firma válida pero contenido mal formado → formato", async () => {
    const sign = async (obj: unknown) => {
      const payload = utf8ToBase64Url(JSON.stringify(obj));
      return `${payload}.${await hmac(SECRET, `wabid.google-oauth.v1.${payload}`)}`;
    };
    const exp = Math.floor(NOW / 1000) + 600;
    const n = "AAAAAAAAAAAAAAAAAAAAAA";
    for (const bad of [
      { v: 2, uid: USER, n, exp },
      { v: 1, uid: "no-es-uuid", n, exp },
      { v: 1, uid: USER, n: "corto", exp },
      { v: 1, uid: USER, n, exp: "mañana" },
      { v: 1, uid: USER, n },
      [1, 2, 3],
    ]) {
      assert.deepEqual(await verifyState(SECRET, await sign(bad), NOW), { ok: false, reason: "formato" }, JSON.stringify(bad));
    }
  });

  it("entradas basura → formato, sin lanzar", async () => {
    for (const junk of [undefined, null, 42, {}, "", "abc", "a.b.c", ".", "..", "a.", ".b", "x".repeat(601), "ñandú.ñandú", "====.===="]) {
      const r = await verifyState(SECRET, junk, NOW);
      assert.equal(r.ok, false);
    }
  });

  it("no firma con una llave corta ni con un user_id inválido", async () => {
    await assert.rejects(() => signState("corta", USER, NOW), /demasiado corto/);
    await assert.rejects(() => signState(SECRET, "no-uuid", NOW), /user_id/);
  });
});
