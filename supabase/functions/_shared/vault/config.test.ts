// node --experimental-strip-types --test supabase/functions/_shared/vault/config.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { CONFIG_PATH, configACargar, configValida, elegirConfig, MAX_CONFIG_CHARS } from "./config.ts";

const TRABAJO = { trabajo: { Acme: ["acme-ventas", { carpeta: "acme-soporte", nombre: "Soporte técnico" }] } };
const json = (o: unknown) => JSON.stringify(o);

test("configValida: acepta un objeto con `trabajo`, quita BOM y espacios", () => {
  assert.equal(configValida(json(TRABAJO)), json(TRABAJO));
  assert.equal(configValida(`﻿  ${json(TRABAJO)}\r\n`), json(TRABAJO));
  assert.equal(configValida('{"trabajo":{}}'), '{"trabajo":{}}', "sin proyectos de trabajo también es válida");
});

test("configValida: rechaza lo que no sirve (nunca debe pisar la buena)", () => {
  for (const malo of ["", "   ", "{", "no es json", "[]", "null", "42", '{"otra":1}', '{"trabajo":[]}', '{"trabajo":"x"}', '{"trabajo":null}']) {
    assert.equal(configValida(malo), null, `«${malo}» no es una configuración`);
  }
  assert.equal(configValida(json({ trabajo: { a: ["x".repeat(MAX_CONFIG_CHARS)] } })), null, "demasiado grande");
});

test("configACargar: solo si el archivo existe, es un blob y cambió", () => {
  const entradas = [
    { path: "20-projects/a/pendientes.md", type: "blob", sha: "s1" },
    { path: CONFIG_PATH, type: "blob", sha: "c1" },
  ];
  assert.equal(configACargar(entradas, null)?.sha, "c1", "nunca guardada → se lee");
  assert.equal(configACargar(entradas, undefined)?.sha, "c1");
  assert.equal(configACargar(entradas, "c0")?.sha, "c1", "cambió");
  assert.equal(configACargar(entradas, "c1"), null, "igual a la guardada → no se vuelve a bajar");
  assert.equal(configACargar(entradas.slice(0, 1), null), null, "el vault no la trae");
  assert.equal(configACargar([{ path: CONFIG_PATH, type: "tree", sha: "t" }], null), null, "una carpeta con ese nombre no cuenta");
  assert.equal(configACargar([{ path: `x/${CONFIG_PATH}`, type: "blob", sha: "z" }], null), null, "solo la ruta exacta");
});

test("elegirConfig: manda la del vault; sin ella, el secreto; sin nada, todo es personal", () => {
  const delVault = { trabajo: { Vault: ["v-1"] } };
  const delSecreto = { trabajo: { Secreto: ["s-1"] } };
  assert.deepEqual(Object.keys(elegirConfig(json(delVault), json(delSecreto)).trabajo), ["Vault"]);
  assert.deepEqual(Object.keys(elegirConfig(null, json(delSecreto)).trabajo), ["Secreto"]);
  assert.deepEqual(Object.keys(elegirConfig(undefined, json(delSecreto)).trabajo), ["Secreto"]);
  assert.deepEqual(elegirConfig(null, undefined).trabajo, {}, "sin ninguna: todo personal");
  // Una config del vault corrupta no tapa al secreto (cae a él), tampoco al revés.
  assert.deepEqual(Object.keys(elegirConfig("{roto", json(delSecreto)).trabajo), ["Secreto"]);
  assert.deepEqual(Object.keys(elegirConfig(`﻿${json(delVault)}`, undefined).trabajo), ["Vault"]);
});

test("elegirConfig conserva los nombres de display ({ carpeta, nombre })", () => {
  const c = elegirConfig(json(TRABAJO), undefined);
  assert.deepEqual(c.trabajo.Acme.map((e) => [e.carpeta, e.nombre]), [["acme-ventas", "Acme Ventas"], ["acme-soporte", "Soporte técnico"]]);
});
