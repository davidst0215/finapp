// Doble en memoria de la tabla avisos_programados para probar los handlers en Node sin red ni base. Solo lo importan las pruebas.
// Soporta lo que usa el módulo: select / insert / update (con .select() después), eq / in / order / limit / single, y errores inyectados.
import type { Row } from "./testlib.ts";

type Op = "select" | "insert" | "update";

/** `errorEn` hace fallar esa operación; `alEscribir` corre justo antes de cada insert/update (para simular que otro proceso cambió una fila entre la lectura y la escritura). */
export function fakeAvisos(inicial: Row[] = [], opciones: { errorEn?: Op; alEscribir?: () => void } = {}) {
  const filas: Row[] = inicial.map((f) => ({ estado: "pendiente", ...f }));
  const escrituras: { op: "insert" | "update"; valores: Row; afectadas: number }[] = [];
  let seq = 0;

  const from = (tabla: string) => {
    if (tabla !== "avisos_programados") throw new Error(`tabla inesperada: ${tabla}`);
    let op: Op = "select";
    let valores: Row = {};
    let devuelve = true;
    let unica = false;
    let limite = Infinity;
    let orden: { c: string; asc: boolean } | null = null;
    const filtros: ((r: Row) => boolean)[] = [];

    const ejecutar = () => {
      if (opciones.errorEn === op) return { data: null, error: { message: `fallo simulado en ${op}` } };
      if (op !== "select") opciones.alEscribir?.();
      if (op === "insert") {
        const fila: Row = { aviso_id: `av-${++seq}`, estado: "pendiente", ...valores };
        filas.push(fila);
        escrituras.push({ op, valores, afectadas: 1 });
        return { data: devuelve ? (unica ? fila : [fila]) : null, error: null };
      }
      const coinciden = filas.filter((r) => filtros.every((f) => f(r)));
      if (op === "update") {
        for (const r of coinciden) Object.assign(r, valores);
        escrituras.push({ op, valores, afectadas: coinciden.length });
        return { data: devuelve ? coinciden : null, error: null };
      }
      let r = [...coinciden];
      if (orden) {
        const { c, asc } = orden;
        r.sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : String(a[c]) > String(b[c]) ? 1 : 0) * (asc ? 1 : -1));
      }
      r = r.slice(0, limite);
      return { data: unica ? (r[0] ?? null) : r, error: null };
    };

    // deno-lint-ignore no-explicit-any
    const b: any = {
      select: () => { devuelve = true; return b; },
      insert: (v: Row) => { op = "insert"; valores = v; devuelve = false; return b; },
      update: (v: Row) => { op = "update"; valores = v; devuelve = false; return b; },
      eq: (c: string, v: unknown) => { filtros.push((r) => r[c] === v); return b; },
      in: (c: string, vs: unknown[]) => { filtros.push((r) => vs.includes(r[c])); return b; },
      order: (c: string, o?: { ascending?: boolean }) => { orden = { c, asc: o?.ascending !== false }; return b; },
      limit: (n: number) => { limite = n; return b; },
      single: () => { unica = true; return Promise.resolve(ejecutar()); },
      then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(ejecutar()).then(ok, ko),
    };
    return b;
  };
  return { db: { from }, filas, escrituras };
}

/** Un Supabase que reparte: la tabla de avisos va al doble de arriba y todo lo demás (vault) a `resto`. */
export function conAvisos(resto: { from: (t: string) => unknown; rpc: (...a: never[]) => unknown }, avisos: ReturnType<typeof fakeAvisos>) {
  return { from: (t: string) => (t === "avisos_programados" ? avisos.db.from(t) : resto.from(t)), rpc: resto.rpc };
}
