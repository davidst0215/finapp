import { test } from "node:test";
import assert from "node:assert/strict";
import { Tiempos } from "./tiempos.ts";

test("Tiempos mide fases en paralelo y arma el header", async () => {
  const t = new Tiempos();
  const espera = (ms: number, v: string) => new Promise<string>((r) => setTimeout(() => r(v), ms));
  const [a, b] = await Promise.all([t.medir("auth", espera(20, "u")), t.medir("ctx", espera(40, "c"))]);
  assert.deepEqual([a, b], ["u", "c"]);
  t.tokens({ prompt_tokens: 3000, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 2500 } });
  const r = t.resumen() as Record<string, number>;
  assert.ok(r.auth >= 15 && r.ctx >= 35, JSON.stringify(r));
  assert.ok(r.total >= r.ctx, "el total cubre la fase más larga");
  assert.equal(r.tok_cache, 2500);
  assert.match(t.header(), /^auth;dur=\d+, ctx;dur=\d+, total;dur=\d+, tok;desc="in=3000 cache=2500 out=80"$/);
});

test("Tiempos registra la fase aunque la promesa falle", async () => {
  const t = new Tiempos();
  await assert.rejects(t.medir("llm", Promise.reject(new Error("x"))));
  assert.match(t.header(), /^llm;dur=\d+, total;dur=\d+$/);
});
