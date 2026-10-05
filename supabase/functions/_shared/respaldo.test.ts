import { test } from "node:test";
import assert from "node:assert/strict";
import { conRespaldo } from "./respaldo.ts";

type R = { ok: boolean; quien: string };

// Pedido falso: responde `r` a los `ms`; si lo abortan antes, falla como fetch.
const falso = (plan: Record<"primero" | "respaldo", { ms: number; ok: boolean }>) => {
  const llamados: string[] = [];
  const abortados: string[] = [];
  const pedir = (respaldo: boolean, signal: AbortSignal) => {
    const quien = respaldo ? "respaldo" : "primero";
    llamados.push(quien);
    return new Promise<R>((ok, falla) => {
      let listo = false;
      const t = setTimeout(() => {
        listo = true;
        ok({ ok: plan[quien].ok, quien });
      }, plan[quien].ms);
      signal.addEventListener("abort", () => {
        if (listo) return; // abortar un pedido ya terminado no corta nada
        clearTimeout(t);
        abortados.push(quien);
        falla(new Error("abortado"));
      });
    });
  };
  return { pedir, llamados, abortados };
};

test("el primero responde a tiempo: no sale el respaldo", async () => {
  const f = falso({ primero: { ms: 10, ok: true }, respaldo: { ms: 10, ok: true } });
  const r = await conRespaldo(f.pedir, 50);
  assert.equal(r.quien, "primero");
  assert.equal(r.respaldo, false);
  assert.deepEqual(f.llamados, ["primero"]);
});

test("el primero se demora: gana el respaldo y el primero se corta", async () => {
  const f = falso({ primero: { ms: 300, ok: true }, respaldo: { ms: 20, ok: true } });
  const r = await conRespaldo(f.pedir, 30);
  assert.equal(r.quien, "respaldo");
  assert.equal(r.respaldo, true);
  assert.deepEqual(f.abortados, ["primero"]);
});

test("el primero falla rápido: el respaldo sale sin esperar el plazo", async () => {
  const f = falso({ primero: { ms: 5, ok: false }, respaldo: { ms: 5, ok: true } });
  const t0 = performance.now();
  const r = await conRespaldo(f.pedir, 1000);
  assert.equal(r.quien, "respaldo");
  assert.ok(performance.now() - t0 < 200, "no debió esperar el plazo de 1 s");
});

test("el primero se demora pero igual llega antes que el respaldo: gana el primero", async () => {
  const f = falso({ primero: { ms: 60, ok: true }, respaldo: { ms: 200, ok: true } });
  const r = await conRespaldo(f.pedir, 30);
  assert.equal(r.quien, "primero");
  assert.equal(r.respaldo, false);
  assert.deepEqual(f.abortados, ["respaldo"]);
});

test("los dos fallan: devuelve la respuesta del primero", async () => {
  const f = falso({ primero: { ms: 5, ok: false }, respaldo: { ms: 5, ok: false } });
  const r = await conRespaldo(f.pedir, 1000);
  assert.equal(r.ok, false);
  assert.equal(r.quien, "primero");
});
