// node --experimental-strip-types --test supabase/functions/_shared/vault/taxonomy.test.ts
// Configuración inventada: la real se pasa por VAULT_PROJECTS_JSON y no vive en el repo (público).
import test from "node:test";
import assert from "node:assert/strict";
import {
  classify, EMPTY_CONFIG, INBOX_FOLDER, isFolderSlug, listDestinations, parseConfig, pretty, resolveFolder, tokenMatch,
} from "./taxonomy.ts";

const CFG = parseConfig({
  _notas: "se ignora",
  trabajo: {
    Acme: [
      { carpeta: "acme-ventas", nombre: "Ventas" },
      { carpeta: "acme-soporte", nombre: "Soporte técnico" },
      "acme-datos",
    ],
    "Beta Perú": [{ carpeta: "beta-ventas", nombre: "Ventas" }],
  },
});
const KNOWN = ["acme-ventas", "acme-soporte", "acme-datos", "beta-ventas", "life", "wabid", "cajon-desastre"];

test("parseConfig: acepta texto JSON, entradas string y objeto, e ignora lo inválido", () => {
  assert.deepEqual(Object.keys(CFG.trabajo), ["Acme", "Beta Perú"]);
  assert.deepEqual(CFG.trabajo.Acme.map((e) => e.nombre), ["Ventas", "Soporte técnico", "Acme Datos"]);
  assert.deepEqual(parseConfig(JSON.stringify({ trabajo: { X: ["x-a"] } })).trabajo, { X: [{ carpeta: "x-a", nombre: "X A" }] });
  assert.deepEqual(parseConfig("no es json"), EMPTY_CONFIG);
  assert.deepEqual(parseConfig(null), EMPTY_CONFIG);
  assert.deepEqual(parseConfig({ trabajo: { Mal: "texto", Otro: [{ carpeta: "../etc" }, 3, null] } }), EMPTY_CONFIG);
});

test("classify: cajón, trabajo con frente y personal plana", () => {
  assert.deepEqual(classify(INBOX_FOLDER, CFG), { folder: INBOX_FOLDER, scope: "cajon", project: "Cajón desastre", frente: null, label: "Cajón desastre" });
  assert.deepEqual(classify("acme-soporte", CFG), { folder: "acme-soporte", scope: "trabajo", project: "Acme", frente: "Soporte técnico", label: "Acme › Soporte técnico" });
  assert.deepEqual(classify("life", CFG), { folder: "life", scope: "personal", project: "Life", frente: null, label: "Life" });
  assert.equal(classify("lo-que-sea", EMPTY_CONFIG).scope, "personal");
});

test("pretty e isFolderSlug", () => {
  assert.equal(pretty("gosentio-enki"), "Gosentio Enki");
  assert.equal(isFolderSlug("tdv-analisis"), true);
  assert.equal(isFolderSlug("../x"), false);
  assert.equal(isFolderSlug("a b"), false);
  assert.equal(isFolderSlug(7), false);
});

test("listDestinations: trabajo en orden de la configuración, personales alfabéticas, cajón al final", () => {
  const d = listDestinations(CFG, [...KNOWN, "../mala", "acme-ventas"]);
  assert.deepEqual(d.map((x) => x.folder), ["acme-ventas", "acme-soporte", "acme-datos", "beta-ventas", "life", "wabid", "cajon-desastre"]);
  assert.equal(d.at(-1)!.scope, "cajon");
  // las carpetas de la configuración cuentan aunque todavía no existan en el vault
  assert.equal(listDestinations(CFG, []).some((x) => x.folder === "beta-ventas"), true);
});

test("resolveFolder: una coincidencia clara", () => {
  const one = (q: string) => {
    const r = resolveFolder(q, CFG, KNOWN);
    assert.equal(r.kind, "one", q);
    return r.kind === "one" ? r.info.folder : "";
  };
  assert.equal(one("acme soporte"), "acme-soporte");
  assert.equal(one("soporte"), "acme-soporte");
  assert.equal(one("el frente de soporte técnico"), "acme-soporte");
  assert.equal(one("beta"), "beta-ventas");
  assert.equal(one("perú ventas"), "beta-ventas");
  assert.equal(one("Life"), "life");
  assert.equal(one("wabid"), "wabid");
  assert.equal(one("acme-datos"), "acme-datos");
  assert.equal(one("datos de acme"), "acme-datos");
  assert.equal(one("el cajón"), "cajon-desastre");
  assert.equal(one("cajon desastre"), "cajon-desastre");
});

test("resolveFolder: ambigua devuelve las opciones", () => {
  const r = resolveFolder("ventas", CFG, KNOWN);
  assert.equal(r.kind, "many");
  assert.deepEqual(r.kind === "many" ? r.options.map((o) => o.folder) : [], ["acme-ventas", "beta-ventas"]);
  const acme = resolveFolder("acme", CFG, KNOWN);
  assert.equal(acme.kind === "many" ? acme.options.length : 0, 3);
});

test("resolveFolder: sin coincidencia", () => {
  assert.equal(resolveFolder("xyz", CFG, KNOWN).kind, "none");
  assert.equal(resolveFolder("", CFG, KNOWN).kind, "none");
  assert.equal(resolveFolder(undefined, CFG, KNOWN).kind, "none");
  assert.equal(resolveFolder("de la", CFG, KNOWN).kind, "none");
});

test("tokenMatch: plurales y prefijos largos, no prefijos cortos", () => {
  assert.equal(tokenMatch("costo", "costos"), true);
  assert.equal(tokenMatch("cobranza", "cobranzas"), true);
  assert.equal(tokenMatch("ver", "vera"), false);
  assert.equal(tokenMatch("vera", "vera"), true);
});
