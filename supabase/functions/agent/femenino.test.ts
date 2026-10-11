// node --experimental-strip-types --test supabase/functions/agent/femenino.test.ts
// Wabid es mujer: cuando habla de sí misma lo hace en femenino. Esta prueba barre TODO el texto que Wabid dice o lee como
// instrucción (plantillas de los handlers, prompts del modelo, textos de la app) buscando adjetivos masculinos sobre ella.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PERSONA } from "./prompt.ts";
import { SISTEMA_BRIEF } from "../brief/logic.ts";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Lo que se pidió vigilar. `\b` con letras acentuadas no sirve en JS; ninguno de estos lleva tilde.
const MASCULINO: [string, RegExp][] = [
  ["listo para", /\blisto para\b/i],
  ["estoy listo", /\bestoy listo\b/i],
  ["atento", /\batento\b/i],
  ["seguro de", /\bseguro de\b/i],
  ["encantado", /\bencantado\b/i],
  ["dispuesto", /\bdispuesto\b/i],
  ["preparado", /\bpreparado\b/i],
];

/** Quita los comentarios de línea y de bloque: ahí se explica el código y se puede decir «ya preparado» sin hablar de Wabid. */
const sinComentarios = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[\s;,{(])\/\/.*$/gm, "$1");

function archivos(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .filter((f) => /\.(ts|tsx|mjs|js)$/.test(f))
    .filter((f) => !/node_modules|[\\/]dist[\\/]/.test(f))
    .filter((f) => !/\.test\.|_test\.|store-contract|[\\/]tests?[\\/]/.test(f));
}

test("la persona dice que Wabid es mujer y usa el femenino en sus ejemplos", () => {
  assert.match(PERSONA, /la asistente personal de David/);
  assert.match(PERSONA, /Wabid es mujer/);
  for (const f of ["lista", "segura", "atenta", "encantada", "dispuesta", "preparada"]) assert.match(PERSONA, new RegExp(`\\b${f}\\b`), f);
  assert.match(PERSONA, /"Lista, dime\."/);
});

test("ningún prompt ni plantilla del servidor ni texto de la app habla de Wabid en masculino", () => {
  const dirs = [join(RAIZ, "supabase", "functions"), join(RAIZ, "apps", "web", "src")];
  const hallazgos: string[] = [];
  let revisados = 0;
  for (const dir of dirs) {
    for (const f of archivos(dir)) {
      revisados++;
      const src = sinComentarios(readFileSync(f, "utf8"));
      for (const [nombre, re] of MASCULINO) {
        const m = re.exec(src);
        if (m) hallazgos.push(`${relative(RAIZ, f)}: «${nombre}» → …${src.slice(Math.max(0, m.index - 30), m.index + 40).replace(/\s+/g, " ")}…`);
      }
    }
  }
  assert.ok(revisados > 60, `se revisaron ${revisados} archivos: la búsqueda no encontró el código`);
  assert.deepEqual(hallazgos, []);
});

test("los prompts que hablan en nombre de Wabid dicen que es la asistente", () => {
  assert.match(SISTEMA_BRIEF, /la asistente personal/);
  const search = readFileSync(join(RAIZ, "supabase", "functions", "_shared", "vault", "search.ts"), "utf8");
  assert.match(search, /Eres Wabid, la asistente personal/);
  const internet = readFileSync(join(RAIZ, "supabase", "functions", "agent", "tools", "internet.ts"), "utf8");
  assert.match(internet, /Eres Wabid, la asistente/);
});

test("el barrido sí detecta una plantilla masculina (la prueba no es decorativa)", () => {
  const malo = sinComentarios('const saludo = "Estoy listo para lo que necesites"; // preparado\nconst b = `Atento a tu agenda`;');
  const halladas = MASCULINO.filter(([, re]) => re.test(malo)).map(([n]) => n);
  assert.deepEqual(halladas, ["listo para", "estoy listo", "atento"]);
  // y un comentario no cuenta
  assert.equal(MASCULINO.some(([, re]) => re.test(sinComentarios("// ya preparado\n/* encantado */"))), false);
});
