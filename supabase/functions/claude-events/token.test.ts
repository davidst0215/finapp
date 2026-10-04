// Corre en Node: node --experimental-strip-types --test supabase/functions/claude-events/token.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateDeviceToken, hashSecret, parseDeviceToken, verifyDeviceToken } from "./token.ts";

const DEVICE_ID = "3f2b8c1e-5d4a-4e7b-9c0d-1a2b3c4d5e6f";

test("hashSecret coincide con el vector SHA-256 publicado para 'abc'", async () => {
  // Vector de FIPS 180-2: fuente independiente, no se recalcula con el mismo código.
  assert.equal(await hashSecret("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("el token generado se puede leer de vuelta y verifica contra su hash", async () => {
  const { token, deviceId, tokenHash } = await generateDeviceToken(DEVICE_ID);
  assert.equal(deviceId, DEVICE_ID);
  assert.match(tokenHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(parseDeviceToken(token)?.deviceId, DEVICE_ID);
  assert.equal(await verifyDeviceToken(token, tokenHash), true);
});

test("el hash guardado no contiene ni deja leer el secreto del token", async () => {
  const { token, tokenHash } = await generateDeviceToken(DEVICE_ID);
  const secret = parseDeviceToken(token)!.secret;
  assert.ok(!tokenHash.includes(secret));
  assert.ok(!token.includes(tokenHash));
});

test("dos tokens para el mismo dispositivo nunca coinciden", async () => {
  const a = await generateDeviceToken(DEVICE_ID);
  const b = await generateDeviceToken(DEVICE_ID);
  assert.notEqual(a.token, b.token);
  assert.notEqual(a.tokenHash, b.tokenHash);
});

test("un secreto alterado no verifica", async () => {
  const { token, tokenHash } = await generateDeviceToken(DEVICE_ID);
  const last = token.at(-1) === "A" ? "B" : "A";
  assert.equal(await verifyDeviceToken(token.slice(0, -1) + last, tokenHash), false);
});

test("el token de otro dispositivo no verifica contra este hash", async () => {
  const mine = await generateDeviceToken(DEVICE_ID);
  const other = await generateDeviceToken("11111111-2222-4333-8444-555555555555");
  assert.equal(await verifyDeviceToken(other.token, mine.tokenHash), false);
});

test("un hash distinto o con formato inválido no verifica", async () => {
  const { token } = await generateDeviceToken(DEVICE_ID);
  assert.equal(await verifyDeviceToken(token, "0".repeat(64)), false);
  assert.equal(await verifyDeviceToken(token, "no-es-un-hash"), false);
  assert.equal(await verifyDeviceToken(token, ""), false);
});

test("parseDeviceToken rechaza formas inválidas", async () => {
  const { token } = await generateDeviceToken(DEVICE_ID);
  const secret = parseDeviceToken(token)!.secret;
  const malformed = [
    "",
    "   ",
    token + " ",
    ` ${token}`,
    token.replace(/^wbd\./, "xyz."),
    `wbd.no-es-uuid.${secret}`,
    `wbd.${DEVICE_ID}.corto`,
    `wbd.${DEVICE_ID}.${secret}.extra`,
    `wbd.${DEVICE_ID}`,
    `wbd.${DEVICE_ID.toUpperCase()}.${secret}`,
    "Bearer " + token,
  ];
  for (const m of malformed) assert.equal(parseDeviceToken(m), null, `debió rechazar: ${JSON.stringify(m)}`);
});

test("generateDeviceToken rechaza un id de dispositivo que no es UUID", async () => {
  await assert.rejects(() => generateDeviceToken("no-es-uuid"));
});
