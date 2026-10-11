// node --experimental-strip-types --test supabase/functions/agent/tools/notasPlan.test.ts
// Decisiones puras de add_note: dónde va, con qué cliente nace el archivo, cuándo se pregunta y cuándo se rechaza.
import test from "node:test";
import assert from "node:assert/strict";
import { MAX_NOTA, MENSAJE_NOTA_LARGA } from "../../_shared/vault/notas.ts";
import type { Destino, Resolucion } from "../../_shared/vault/proyectos.ts";
import { planearNota } from "./notasPlan.ts";

const destino = (o: Partial<Destino>): Destino => ({
  folder: "novafondos-app", scope: "personal", project: "Novafondos App", frente: null, label: "Novafondos App", grupo: "novafondos",
  grupoEtiqueta: "Novafondos", etiquetaFicha: true, palabras: [], propias: [], cliente: null, ...o,
});
const uno = (d: Destino, aproximado = false): Resolucion => ({ kind: "one", destino: d, aproximado });

test("el archivo nuevo nace con el cliente de las fichas; sin él, el proyecto de la configuración (trabajo) o «personal»; el cajón, ninguno", () => {
  const casos: [Destino, string | null][] = [
    [destino({ cliente: "Maqui CO", folder: "mqsco-cobranzas" }), "Maqui CO"],
    [destino({ scope: "trabajo", project: "Saya Investments", frente: "Novafondos", cliente: null }), "Saya Investments"],
    [destino({ scope: "personal", cliente: null, folder: "lota" }), "personal"],
    [destino({ scope: "cajon", folder: "cajon-desastre", project: "Cajón desastre" }), null],
  ];
  for (const [d, esperado] of casos) {
    const r = planearNota({ text: "decidimos algo" }, uno(d));
    assert.ok("plan" in r, d.folder);
    assert.equal(r.plan.cliente, esperado, d.folder);
    assert.equal(r.plan.folder, d.folder);
  }
  const sinProyecto = planearNota({ text: "decidimos algo" }, null);
  assert.ok("plan" in sinProyecto);
  assert.deepEqual([sinProyecto.plan.folder, sinProyecto.plan.cliente, sinProyecto.plan.donde], ["cajon-desastre", null, "el cajón"]);
});

test("una nota más larga que el tope se rechaza con un mensaje claro (no se recorta) y no pregunta nada del proyecto", () => {
  const largo = planearNota({ text: "x".repeat(MAX_NOTA + 1), project: "nova fondos" }, uno(destino({})));
  assert.ok("respuesta" in largo);
  assert.deepEqual(largo.respuesta, { action: "error", message: MENSAJE_NOTA_LARGA });
  assert.equal(MENSAJE_NOTA_LARGA, "La nota es muy larga; dímela más corta.");
  const justo = planearNota({ text: "x".repeat(MAX_NOTA) }, uno(destino({})));
  assert.ok("plan" in justo);
  assert.equal(justo.plan.texto.length, MAX_NOTA);
});

test("el texto del plan ya viene sin sintaxis de Obsidian ([[enlaces]], ![[incrustados]], %%comentarios%%)", () => {
  const r = planearNota({ text: "ver [[Novafondos]] ![[plano.png]] %%oculto%%" }, uno(destino({})));
  assert.ok("plan" in r);
  assert.equal(r.plan.texto, "ver [Novafondos] [plano.png] %oculto%");
});
