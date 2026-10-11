// Proyectos hablados → carpeta de 20-projects. "nova fondos", "TDV bolsa", "Maqui Colombia cobranzas" y "Maqui Perú" deben
// llegar a su carpeta aunque la voz parta o cambie el nombre (la carpeta se llama `mqsco-cobranzas`).
//
// Un destino se reconoce por una BOLSA de palabras:
//   · las de su carpeta, de su proyecto y de su frente (la configuración de Norte, si la hay);
//   · las de las fichas (60-wiki/proyectos/*) que hablan de él: su `cliente` y su ficha madre. Una ficha habla de una
//     carpeta cuando (a) es la ficha madre y la carpeta empieza con su nombre (`tdv` → `tdv-*`), (b) nombra la carpeta
//     ("Vault: 20-projects/tdv-bolsa-de-costos/pendientes.md") o (c) nombra un prefijo ("20-projects/mqsco-*/…").
// Así los alias salen de los datos y no de una lista a mano en el repo (público).
// Puro: sin globals de Deno; se prueba con Node (proyectos.test.ts).
import { cubre, norm, sinCubrir } from "../texto.ts";
import { type Config, type FolderInfo, INBOX_LABEL, listDestinations, pretty, tokens } from "./taxonomy.ts";

// --- Lo que una ficha dice de las carpetas --------------------------------------------------------------------
export type RefsVault = { carpetas: string[]; prefijos: string[] };
export type FichaProy = { slug: string; cliente: string | null; padre: string | null; refs: RefsVault };

// 20-projects/<carpeta>/…   20-projects\tdv-*\…   (el `-*` marca un prefijo: todas las carpetas que empiezan así)
const RE_RUTA = /20-projects[\\/]+([a-z0-9][a-z0-9_-]*?)(-?\*)?(?=[\\/\s`'"),;.:]|$)/gi;
// <carpeta>/pendientes.md  (cuando la ficha lista varias: "…/novafondos-app/pendientes.md y novafondos-normativa/pendientes.md")
const RE_PENDIENTES = /(?:^|[\s`'"(,;:])([a-z0-9][a-z0-9_-]*)[\\/]+pendientes\.md/gi;
// "Vault: mqsco-herramientas, mqsco-cobranzas."
const RE_VAULT = /\bVault:?[ \t]+((?:(?!\bVault\b)[^\n])*)/gi;
const RE_SLUG = /^[a-z0-9][a-z0-9_-]*$/i;

/** Carpetas y prefijos de 20-projects que un texto nombra. Aún sin validar contra las carpetas que existen. */
export function refsDeVault(texto: string): RefsVault {
  const carpetas = new Set<string>();
  const prefijos = new Set<string>();
  for (const m of texto.matchAll(RE_RUTA)) {
    const nombre = m[1].toLowerCase();
    if (m[2]) prefijos.add(`${nombre}-`);
    else carpetas.add(nombre);
  }
  for (const m of texto.matchAll(RE_PENDIENTES)) carpetas.add(m[1].toLowerCase());
  for (const m of texto.matchAll(RE_VAULT)) {
    for (const parte of m[1].split(/,|;|\sy\s/)) {
      const p = parte.trim().replace(/^[`'"(]+|[`'").:]+$/g, "");
      if (RE_SLUG.test(p)) carpetas.add(p.toLowerCase());
    }
  }
  return { carpetas: [...carpetas], prefijos: [...prefijos] };
}

/** Lo mínimo de una ficha para los alias: no se guarda el contenido. */
export function fichaProy(f: { slug: string; cliente?: string | null; padre?: string | null; content?: string | null }): FichaProy {
  return {
    slug: f.slug.toLowerCase(),
    cliente: f.cliente?.trim() || null,
    padre: f.padre?.trim().toLowerCase() || null,
    refs: refsDeVault(f.content ?? ""),
  };
}

// --- Índice de destinos ---------------------------------------------------------------------------------------
export type Destino = FolderInfo & {
  /** Proyecto al que pertenece: el de la configuración, o el prefijo común de las carpetas hermanas (`mqsco`). */
  grupo: string;
  /** Cómo se dice el grupo ("Maqui CO", "Novafondos"). */
  grupoEtiqueta: string;
  /** Palabras que lo reconocen: las suyas y las que aportan las fichas. */
  palabras: string[];
  /** Solo las suyas (carpeta, proyecto, frente): desempatan frente a las que vienen de las fichas. */
  propias: string[];
};

export type Indice = {
  destinos: Destino[];
  inbox: Destino;
  /** Slug de ficha → carpetas de las que habla (las que nombra, y si no nombra ninguna, las de su ficha madre). */
  porFicha: Map<string, string[]>;
};

/** Una ficha que nombra más que esto es un índice general (Norte, parqueados): no aporta alias. */
const MAX_REFS_FICHA = 4;
const sinPersonal = (c: string | null) => (c && norm(c) !== "personal" ? c : null);

/** "bolsa-de-costos" → "Bolsa de costos". */
const frase = (slug: string): string => {
  const t = slug.replace(/[-_]+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

export function construirIndice(cfg: Config, carpetas: string[], fichas: FichaProy[]): Indice {
  const todos = listDestinations(cfg, carpetas);
  const conCarpeta = todos.filter((d) => d.scope !== "cajon");
  const existen = new Set(conCarpeta.map((d) => d.folder));

  // Prefijo común: las carpetas `mqsco-*` son hermanas si hay al menos dos.
  const primero = (f: string) => f.split("-")[0];
  const hermanas = new Map<string, number>();
  for (const d of conCarpeta) if (d.scope !== "trabajo") hermanas.set(primero(d.folder), (hermanas.get(primero(d.folder)) ?? 0) + 1);
  const grupoDe = (d: FolderInfo): string => (d.scope === "trabajo" ? d.project : (hermanas.get(primero(d.folder)) ?? 0) >= 2 ? primero(d.folder) : d.folder);

  // Qué fichas hablan de cada carpeta, y qué carpetas tiene cada ficha.
  const fichasDe = new Map<string, FichaProy[]>();
  const porFicha = new Map<string, string[]>();
  const agregar = (carpeta: string, f: FichaProy) => {
    const lista = fichasDe.get(carpeta) ?? [];
    if (!lista.includes(f)) lista.push(f);
    fichasDe.set(carpeta, lista);
  };
  for (const f of fichas) {
    const nombradas = f.refs.carpetas.filter((c) => existen.has(c));
    const prefijos = f.refs.prefijos.filter((p) => conCarpeta.some((d) => d.folder.startsWith(p)));
    const general = nombradas.length + prefijos.length > MAX_REFS_FICHA;
    const propias = new Set<string>();
    if (!general) {
      for (const c of nombradas) propias.add(c);
      for (const p of prefijos) for (const d of conCarpeta) if (d.folder.startsWith(p)) propias.add(d.folder);
    }
    // La ficha madre (sin padre) habla de la carpeta que se llama como ella y de las que empiezan con su nombre.
    if (!f.padre) for (const d of conCarpeta) if (d.folder === f.slug || d.folder.startsWith(`${f.slug}-`)) propias.add(d.folder);
    for (const c of propias) agregar(c, f);
    porFicha.set(f.slug, [...propias]);
  }
  // Una ficha hija sin carpetas propias (lota-vision) se apoya en las de su ficha madre.
  for (const f of fichas) {
    if (f.padre && !(porFicha.get(f.slug)?.length)) porFicha.set(f.slug, (porFicha.get(f.padre) ?? []).slice(0, 3));
  }

  const identidad = (f: FichaProy): string[] => [...tokens(sinPersonal(f.cliente) ?? ""), ...tokens(f.padre ?? f.slug)];
  const unicos = (xs: string[]) => [...new Set(xs)];

  const base = todos.map((d): Destino => {
    const propias = unicos([...tokens(d.folder), ...tokens(d.project), ...(d.frente ? tokens(d.frente) : [])]);
    const delFichas = (fichasDe.get(d.folder) ?? []).flatMap(identidad);
    return { ...d, grupo: grupoDe(d), grupoEtiqueta: d.project, palabras: unicos([...propias, ...delFichas]), propias };
  });

  // Etiqueta del grupo: la de la configuración; si no, el cliente de las fichas ("Maqui CO") y, si no hay, el prefijo.
  const etiquetas = new Map<string, string>();
  for (const d of base) {
    if (d.scope === "cajon" || etiquetas.has(d.grupo)) continue;
    if (d.scope === "trabajo") {
      etiquetas.set(d.grupo, d.project);
      continue;
    }
    const clientes = base.filter((x) => x.grupo === d.grupo).flatMap((x) => (fichasDe.get(x.folder) ?? []).map((f) => sinPersonal(f.cliente)).filter(Boolean) as string[]);
    const frecuente = [...clientes.reduce((m, c) => m.set(c, (m.get(c) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1])[0]?.[0];
    etiquetas.set(d.grupo, frecuente ?? pretty(d.grupo));
  }
  const destinos = base.map((d) => ({ ...d, grupoEtiqueta: d.scope === "cajon" ? INBOX_LABEL : (etiquetas.get(d.grupo) ?? d.project) }));
  const inbox = destinos[destinos.length - 1];
  return { destinos: destinos.filter((d) => d.scope !== "cajon"), inbox, porFicha };
}

// --- Cómo se dice un destino ------------------------------------------------------------------------------------
/** "Cobranzas" → "cobranzas" para ir tras el proyecto; una sigla ("SMV") o un nombre propio compuesto se quedan como están. */
const enMinuscula = (s: string): string => (/^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** "app", "bolsa de costos": el frente solo, sin el proyecto. */
export function frenteHablado(d: Destino): string {
  if (d.frente) return d.frente;
  const prefijo = `${d.grupo}-`;
  return d.folder.startsWith(prefijo) ? frase(d.folder.slice(prefijo.length)) : d.project;
}

/** "Maqui CO cobranzas", "Vera": para confirmar dónde quedó algo. */
export function destinoHablado(d: Destino): string {
  if (d.scope === "cajon") return "el cajón";
  if (d.scope === "trabajo") return d.frente ? `${d.project} ${d.frente}` : d.project;
  return d.folder.startsWith(`${d.grupo}-`) ? `${d.grupoEtiqueta} ${enMinuscula(frenteHablado(d))}` : d.project;
}

// --- Resolver lo que dijo David -------------------------------------------------------------------------------------
export type Resolucion =
  | { kind: "one"; destino: Destino; aproximado: boolean }
  | { kind: "many"; opciones: Destino[]; mismoGrupo: boolean; aproximado: boolean }
  | { kind: "none" };

/**
 * "nova fondos" → novafondos-app o novafondos-normativa (many: se pregunta); "TDV bolsa" → tdv-bolsa-de-costos;
 * "Maqui Colombia cobranzas" → mqsco-cobranzas; "Maqui Perú" → todas las mqspe-*. Todas las palabras de lo dicho deben
 * estar en la bolsa del destino. Si no hay ninguno, se descartan las palabras que no reconoce ningún destino
 * ("lota visión" → lota) mientras quede al menos la mitad; el resultado va marcado `aproximado`.
 */
export function resolverProyecto(query: unknown, ix: Indice): Resolucion {
  const texto = typeof query === "string" ? query : "";
  const nq = norm(texto);
  if (/^(el )?(cajon|cajon desastre)$/.test(nq) || nq === norm(INBOX_LABEL)) return { kind: "one", destino: ix.inbox, aproximado: false };
  const q = tokens(texto);
  if (!q.length) return { kind: "none" };

  const exacta = ix.destinos.find((d) => d.folder === texto.trim().toLowerCase());
  if (exacta) return { kind: "one", destino: exacta, aproximado: false };

  let usadas = q;
  let aproximado = false;
  let hits = ix.destinos.filter((d) => cubre(usadas, d.palabras));
  if (!hits.length) {
    const reconocidas = q.filter((t) => ix.destinos.some((d) => sinCubrir([t], d.palabras).length === 0));
    if (reconocidas.length && reconocidas.length < q.length && reconocidas.length * 2 >= q.length) {
      usadas = reconocidas;
      aproximado = true;
      hits = ix.destinos.filter((d) => cubre(usadas, d.palabras));
    }
  }
  if (!hits.length) return { kind: "none" };
  if (hits.length === 1) return { kind: "one", destino: hits[0], aproximado };

  // Varias: gana la que se llama exactamente así, o la única cuyas palabras PROPIAS (no las de las fichas) lo cubren.
  const exactas = hits.filter((d) => norm(d.label) === nq || norm(d.project) === nq || (d.frente && norm(d.frente) === nq) || norm(d.folder.replace(/-/g, " ")) === nq);
  if (exactas.length === 1) return { kind: "one", destino: exactas[0], aproximado };
  const propias = hits.filter((d) => cubre(usadas, d.propias));
  if (propias.length === 1 && propias.length < hits.length) return { kind: "one", destino: propias[0], aproximado };
  return { kind: "many", opciones: hits, mismoGrupo: hits.every((d) => d.grupo === hits[0].grupo), aproximado };
}

/** Carpetas de las que habla una ficha (para traer sus pendientes junto a ella). */
export const carpetasDeFicha = (ix: Indice, slug: string): string[] => ix.porFicha.get(slug.toLowerCase()) ?? [];

/** Una carpeta cuyos pendientes se suman a la respuesta de memoria, con el nombre con que se dice. */
export type PendientesIn = { carpeta: string; etiqueta: string };

/**
 * De qué carpetas traer los pendientes para responder una pregunta de memoria: primero el proyecto que nombra la pregunta (uno,
 * o varios frentes si son pocos) y después las carpetas de las fichas que eligió el modelo. Nunca el cajón. Como mucho `max`.
 */
export function carpetasParaPendientes(slugsFichas: string[], consulta: string, ix: Indice, max = 3): PendientesIn[] {
  const out = new Map<string, string>();
  const sumar = (d: Destino | undefined) => {
    if (d && d.scope !== "cajon" && out.size < max && !out.has(d.folder)) out.set(d.folder, destinoHablado(d));
  };
  const m = resolverProyecto(consulta, ix);
  if (m.kind === "one") sumar(m.destino);
  else if (m.kind === "many" && m.opciones.length <= max) m.opciones.forEach(sumar);
  for (const slug of slugsFichas) for (const carpeta of carpetasDeFicha(ix, slug)) sumar(ix.destinos.find((d) => d.folder === carpeta));
  return [...out].map(([carpeta, etiqueta]) => ({ carpeta, etiqueta }));
}

// --- Preguntas para aclarar ---------------------------------------------------------------------------------------
const lista = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} o ${xs[xs.length - 1]}` : (xs[0] ?? ""));

/** "¿En Novafondos: app o normativa?": con las opciones que quepan en `max` caracteres (la voz cierra siempre con «?»). */
function pregunta(abre: string, items: string[], max = 96): string {
  for (let k = items.length; k >= 2; k--) {
    const q = `${abre}${lista(items.slice(0, k))}${k < items.length ? " u otro" : ""}?`;
    if (q.length <= max) return q;
  }
  return "¿Cuál de ellos?";
}

/** Dónde crear la tarea cuando hay varias opciones. Pantalla y voz (la voz cabe en 100 caracteres). */
export function preguntaProyecto(r: Extract<Resolucion, { kind: "many" }>): { message: string; voz: string } {
  const o = r.opciones;
  if (r.mismoGrupo) {
    const grupo = o[0].grupoEtiqueta;
    const frentes = o.map((d) => enMinuscula(frenteHablado(d)));
    return {
      message: frentes.length <= 6 ? `¿En qué frente de ${grupo}: ${lista(frentes)}?` : `Hay ${frentes.length} frentes en ${grupo}: ${frentes.join(", ")}. ¿Cuál?`,
      voz: pregunta(`¿En ${grupo}: `, frentes),
    };
  }
  const nombres = o.map(destinoHablado);
  return { message: `¿En cuál: ${lista(nombres.slice(0, 5))}${o.length > 5 ? " u otro" : ""}?`, voz: pregunta("¿En cuál: ", nombres) };
}
