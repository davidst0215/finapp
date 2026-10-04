// Lógica pura del módulo reuniones: parseo de Fathom, fechas de Lima, esperas y búsqueda.
// Sin globals de Deno ni imports: se prueba en Node (`node --experimental-strip-types --test pure.test.ts`).
// Todo el texto que viene de reuniones o del vault es DATO: aquí solo se recorta y se muestra, nunca se interpreta.

export type Invitado = { name: string; email: string; externo: boolean };
export type ActionItem = { texto: string; dueno: string | null; hecho: boolean; url: string | null };
export type Reunion = {
  recording_id: number;
  titulo: string;
  inicio: string; // ISO UTC
  duracion_min: number | null;
  invitados: Invitado[];
  resumen: string; // markdown de Fathom
  action_items: ActionItem[];
  share_url: string | null;
  creada_en: string; // created_at de Fathom (cursor de sincronización)
};

export const UMBRAL_VENCIDA_DIAS = 3;
export const SOLAPE_MS = 2 * 60 * 60 * 1000;

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const isoOk = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));
const https = (v: unknown): string | null => (typeof v === "string" && v.startsWith("https://") ? v : null);

// --- Fathom ------------------------------------------------------------------------------------

/** Una reunión del endpoint /meetings → fila de la caché. null si no trae lo mínimo (id y alguna fecha). */
export function parseMeeting(raw: unknown): Reunion | null {
  if (!isRec(raw)) return null;
  const id = typeof raw.recording_id === "number" ? raw.recording_id : Number(raw.recording_id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const inicio = [raw.recording_start_time, raw.scheduled_start_time, raw.created_at].find(isoOk);
  const creada = isoOk(raw.created_at) ? raw.created_at : inicio;
  if (!inicio || !creada) return null;

  let duracion: number | null = null;
  if (isoOk(raw.recording_start_time) && isoOk(raw.recording_end_time)) {
    const min = Math.round((Date.parse(raw.recording_end_time) - Date.parse(raw.recording_start_time)) / 60000);
    if (min >= 0 && min < 24 * 60) duracion = min;
  }

  const invitados: Invitado[] = (Array.isArray(raw.calendar_invitees) ? raw.calendar_invitees : [])
    .filter(isRec)
    .map((i) => ({ name: str(i.name), email: str(i.email), externo: i.is_external === true }))
    .filter((i) => i.name || i.email);

  const items: ActionItem[] = (Array.isArray(raw.action_items) ? raw.action_items : [])
    .filter(isRec)
    .map((a) => ({
      texto: str(a.description),
      dueno: isRec(a.assignee) ? str(a.assignee.name) || str(a.assignee.email) || null : null,
      hecho: a.completed === true,
      url: https(a.recording_playback_url),
    }))
    .filter((a) => a.texto);

  return {
    recording_id: id,
    titulo: str(raw.title) || str(raw.meeting_title) || "(sin título)",
    inicio,
    duracion_min: duracion,
    invitados,
    resumen: isRec(raw.default_summary) ? str(raw.default_summary.markdown_formatted) : "",
    action_items: items,
    share_url: https(raw.share_url) ?? https(raw.url),
    creada_en: creada,
  };
}

/** Página de /meetings → reuniones válidas, cursor siguiente y cuántas se descartaron. */
export function parsePage(raw: unknown): { items: Reunion[]; nextCursor: string | null; descartadas: number } {
  if (!isRec(raw) || !Array.isArray(raw.items)) throw new Error("Respuesta de Fathom sin 'items'");
  const items: Reunion[] = [];
  let descartadas = 0;
  for (const m of raw.items) {
    const r = parseMeeting(m);
    if (r) items.push(r);
    else descartadas++;
  }
  const next = typeof raw.next_cursor === "string" && raw.next_cursor ? raw.next_cursor : null;
  return { items, nextCursor: next, descartadas };
}

// --- Estado de sincronización ---------------------------------------------------------------------------
// `complete_until` solo avanza cuando una corrida termina. Una corrida cortada deja guardado por dónde
// seguir (en_curso_desde / en_curso_antes) y la siguiente continúa ahí, sin saltarse reuniones viejas.

export type EstadoSync = {
  complete_until: string | null;
  en_curso_desde: string | null;
  en_curso_antes: string | null;
  objetivo: string | null;
};
export type PlanSync = { desde: string; antes: string | null; objetivo: string };

export const MAX_ATRAS_MS = 365 * 86400000;
const MARGEN_MS = 1000; // created_after/before pueden ser exclusivos: el margen repite una reunión (el upsert es idempotente) en vez de perderla

/** Qué pedir en esta corrida: continuar la cortada, o empezar una nueva desde `complete_until` − solape (máx. 1 año atrás). */
export function planSync(estado: EstadoSync | null, ahora: number, diasInicial = 30): PlanSync {
  const piso = ahora - MAX_ATRAS_MS;
  const acotar = (ms: number) => new Date(Math.max(ms, piso)).toISOString();
  if (estado && isoOk(estado.en_curso_desde) && isoOk(estado.objetivo)) {
    return {
      desde: acotar(Date.parse(estado.en_curso_desde)),
      antes: isoOk(estado.en_curso_antes) ? new Date(estado.en_curso_antes).toISOString() : null,
      objetivo: new Date(estado.objetivo).toISOString(),
    };
  }
  const base = estado && isoOk(estado.complete_until) ? Date.parse(estado.complete_until) - SOLAPE_MS : ahora - diasInicial * 86400000;
  return { desde: acotar(base), antes: null, objetivo: new Date(ahora).toISOString() };
}

/**
 * Plan para continuar tras una corrida cortada, según lo ya traído. No se apoya en el orden de Fathom:
 * lo deduce de lo recibido. Más nuevas primero (lo observado) → se retrocede `antes` hasta la más vieja traída;
 * más viejas primero → se adelanta `desde` hasta la más nueva traída.
 */
export function avanzarPlan(plan: PlanSync, traidas: { creada_en: string }[]): PlanSync {
  if (!traidas.length) return plan;
  const t = traidas.map((r) => Date.parse(r.creada_en));
  const descendente = t[0] >= t[t.length - 1];
  if (descendente) {
    // El `antes` previo ya trae el margen: se lo quita antes de comparar para que no se acumule vuelta tras vuelta.
    const min = Math.min(...t, plan.antes ? Date.parse(plan.antes) - MARGEN_MS : Infinity);
    return { ...plan, antes: new Date(min + MARGEN_MS).toISOString() };
  }
  const max = Math.max(...t, Date.parse(plan.desde) + MARGEN_MS);
  return { ...plan, desde: new Date(max - MARGEN_MS).toISOString() };
}

// --- Fechas de Lima (UTC-5 todo el año) ------------------------------------------------------------

export const limaDia = (iso: string | number | Date): string =>
  new Date(new Date(iso).getTime() - 5 * 3600000).toISOString().slice(0, 10);

export const hoyLima = (ahora: number = Date.now()): string => limaDia(ahora);

const diaAUtc = (d: string): number => {
  const [y, m, dd] = d.split("-").map(Number);
  return Date.UTC(y, m - 1, dd);
};

/** Días de calendario entre dos fechas AAAA-MM-DD (hasta - desde). */
export const diasEntre = (desde: string, hasta: string): number => Math.round((diaAUtc(hasta) - diaAUtc(desde)) / 86400000);

export const sumarDias = (dia: string, n: number): string => new Date(diaAUtc(dia) + n * 86400000).toISOString().slice(0, 10);

const MESES_CORTOS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

/** "ayer", "hoy" o "el 2 de octubre" (con año si no es el actual). Para voz. */
export function cuandoHablado(dia: string, hoy: string): string {
  const d = diasEntre(dia, hoy);
  if (d === 0) return "hoy";
  if (d === 1) return "ayer";
  if (d === 2) return "anteayer";
  const [y, m, dd] = dia.split("-").map(Number);
  return `el ${dd} de ${MESES[m - 1]}${y === Number(hoy.slice(0, 4)) ? "" : ` de ${y}`}`;
}

// --- Texto ------------------------------------------------------------------------------------------

/** Minúsculas, sin acentos, sin signos. Para comparar nombres y títulos. */
export const norm = (s: string): string =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9@.\s-]/g, " ").replace(/\s+/g, " ").trim();

/** Markdown de Fathom → texto plano corto, cortado en fin de oración. No agrega nada que no esté en el resumen. */
export function resumenCorto(markdown: string, max = 220): string {
  const plano = markdown
    .split(/\r?\n/)
    .filter((l) => !/^\s*#{1,6}\s/.test(l)) // los títulos de sección ("Meeting Purpose") no son contenido
    .map((l) => l.replace(/^\s*[-*•]\s+/, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`>]/g, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (plano.length <= max) return plano;
  const corte = plano.slice(0, max);
  const fin = Math.max(corte.lastIndexOf(". "), corte.lastIndexOf("; "));
  if (fin > max * 0.4) return corte.slice(0, fin + 1);
  const esp = corte.lastIndexOf(" ");
  return `${corte.slice(0, esp > 0 ? esp : max)}…`;
}

// --- Búsqueda de reuniones ------------------------------------------------------------------------

const RELLENO = new Set([
  "el", "la", "los", "las", "un", "una", "de", "del", "con", "en", "y", "a", "al", "que", "quedo", "paso", "sobre", "mi", "mis",
  "reunion", "reuniones", "llamada", "call", "meeting", "ultima", "ultimo", "fue", "fueron", "hable", "hablamos", "dijo", "me", "se",
  "hoy", "ayer", "anteayer", "antier", "esta", "semana", "pasada", "por", "para", "cual", "cuales", "resumen", "dame", "dime",
]);

export type Consulta = { dia: string | null; desde: string | null; tokens: string[] };

/** "la reunión con Daniel de ayer" → { dia: ayer, tokens: ["daniel"] }. */
export function leerConsulta(texto: string, hoy: string): Consulta {
  const n = norm(texto);
  let dia: string | null = null;
  let desde: string | null = null;
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(n);
  if (iso) dia = iso[1];
  else if (/\banteayer\b|\bantier\b/.test(n)) dia = sumarDias(hoy, -2);
  else if (/\bayer\b/.test(n)) dia = sumarDias(hoy, -1);
  else if (/\bhoy\b/.test(n)) dia = hoy;
  else if (/\besta semana\b|\bsemana pasada\b/.test(n)) desde = sumarDias(hoy, -7);
  const tokens = n.split(" ").filter((t) => t.length >= 3 && !RELLENO.has(t) && !/^\d{4}-\d{2}-\d{2}$/.test(t));
  return { dia, desde, tokens };
}

/** Reuniones que calzan con la consulta, la mejor primero. Sin coincidencia clara devuelve []: nunca adivina. */
export function buscarReuniones(reuniones: Reunion[], texto: string, hoy: string): Reunion[] {
  const q = leerConsulta(texto, hoy);
  const pool = reuniones.filter((r) => {
    const d = limaDia(r.inicio);
    if (q.dia && d !== q.dia) return false;
    if (q.desde && d < q.desde) return false;
    return true;
  });
  const porFecha = (a: Reunion, b: Reunion) => Date.parse(b.inicio) - Date.parse(a.inicio);
  if (!q.tokens.length) return pool.sort(porFecha);

  const puntuadas = pool.map((r) => {
    const haystack = norm(`${r.titulo} ${r.invitados.map((i) => `${i.name} ${i.email}`).join(" ")}`).split(" ");
    const hits = q.tokens.filter((t) => haystack.some((h) => h.startsWith(t) || (t.length >= 4 && h.includes(t)))).length;
    return { r, hits };
  }).filter((x) => x.hits > 0);
  return puntuadas.sort((a, b) => b.hits - a.hits || porFecha(a.r, b.r)).map((x) => x.r);
}

// --- Esperas (tareas del vault con #conjunto/<quien>) -------------------------------------------------

export type TareaIndexada = {
  text: string;
  status: string;
  shared_with: string | null;
  note: string | null;
  raw: string | null;
  due: string | null;
  path?: string | null; // archivo del vault: parte de la identidad de la espera
  indexado?: string | null; // vault_docs.indexed_at: respaldo cuando la tarea no trae ninguna fecha
};

export type Espera = {
  quien: string; // para mostrar: "Daniel"
  texto: string;
  desde: string | null; // AAAA-MM-DD
  aprox: boolean; // la fecha es la de indexado del archivo (cota inferior), no la de la tarea
  dias: number | null; // días de calendario en Lima; null si no hay fecha
  vencida: boolean; // más de UMBRAL_VENCIDA_DIAS
  reunion: string | null; // título de la reunión de origen, si la nota lo trae
  enlace: string | null; // grabación
  vence: string | null; // 📅 de la tarea
  clave: string; // identidad estable para no avisar dos veces
};

export const ESTADOS_ABIERTOS = ["pending", "in-progress", "need-help"];

export const nombreDe = (slug: string): string => {
  const s = slug.trim().replace(/-/g, " ");
  return s ? s[0].toUpperCase() + s.slice(1) : s;
};

const diaValido = (y: number, m: number, d: number): boolean => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

/** La nota que escribe fathom-inbox: "Título · 2 oct · [grabación](url) · contexto". */
export function leerNota(note: string | null, hoy: string): { fecha: string | null; reunion: string | null; enlace: string | null } {
  if (!note) return { fecha: null, reunion: null, enlace: null };
  const partes = note.split(" · ").map((p) => p.trim());
  const enlace = /\]\((https:\/\/[^)\s]+)\)/.exec(note)?.[1] ?? null;
  // El índice 0 es el título de la reunión (puede traer cualquier cosa): la fecha se busca desde el 1.
  for (let i = 1; i < partes.length; i++) {
    const m = /^(\d{1,2}) (ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)$/i.exec(partes[i]);
    if (!m) continue;
    const dia = Number(m[1]);
    const mes = MESES_CORTOS.indexOf(m[2].toLowerCase()) + 1;
    let anio = Number(hoy.slice(0, 4));
    if (!diaValido(anio, mes, dia)) return { fecha: null, reunion: partes[0] || null, enlace };
    let fecha = `${anio}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
    if (fecha > hoy) { // una reunión no es del futuro: es del año pasado
      anio -= 1;
      if (!diaValido(anio, mes, dia)) return { fecha: null, reunion: partes[0] || null, enlace };
      fecha = `${anio}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
    }
    return { fecha, reunion: partes[0] || null, enlace };
  }
  return { fecha: null, reunion: null, enlace };
};

/** ➕ AAAA-MM-DD (fecha de alta de Obsidian Tasks) en la línea original. */
export const fechaAlta = (raw: string | null): string | null => {
  const m = raw ? /➕\s*(\d{4}-\d{2}-\d{2})/u.exec(raw) : null;
  return m && diaValido(Number(m[1].slice(0, 4)), Number(m[1].slice(5, 7)), Number(m[1].slice(8, 10))) ? m[1] : null;
};

export function construirEsperas(tareas: TareaIndexada[], hoy: string): Espera[] {
  const out: Espera[] = [];
  for (const t of tareas) {
    const slug = (t.shared_with ?? "").trim();
    if (!slug || !ESTADOS_ABIERTOS.includes(t.status)) continue;
    const nota = leerNota(t.note, hoy);
    // Prioridad: fecha de alta (➕); si no, la de la reunión que dejó la nota; si no, la fecha en que el
    // archivo se indexó. Esta última es una COTA INFERIOR de la espera real (se renueva si el archivo cambia,
    // así que subestima los días), pero evita que una espera sin fecha no avise nunca.
    const exacta = fechaAlta(t.raw) ?? nota.fecha;
    const respaldo = !exacta && t.indexado && isoOk(t.indexado) ? limaDia(t.indexado) : null;
    const desde = exacta ?? respaldo;
    const dias = desde ? Math.max(0, diasEntre(desde, hoy)) : null;
    out.push({
      quien: nombreDe(slug),
      texto: t.text.trim(),
      desde,
      aprox: respaldo !== null,
      dias,
      vencida: dias !== null && dias > UMBRAL_VENCIDA_DIAS,
      reunion: nota.reunion,
      enlace: nota.enlace,
      vence: t.due,
      // quién + archivo + texto: la misma tarea reabierta conserva la clave; una copia en otro archivo es otra espera.
      // Editar el texto cambia la clave y vuelve a avisar (aceptado).
      clave: `${norm(slug)}|${(t.path ?? "").toLowerCase()}|${norm(t.text).slice(0, 120)}`,
    });
  }
  // La que más lleva esperando primero; sin fecha al final.
  return out.sort((a, b) => (b.dias ?? -1) - (a.dias ?? -1) || a.quien.localeCompare(b.quien));
}

/** Filtra por persona: "daniel" calza con "Daniel" y con "daniel-rojas". */
export function esperasDe(esperas: Espera[], de: string): Espera[] {
  const q = norm(de);
  if (!q) return esperas;
  return esperas.filter((e) => norm(e.quien).split(" ").some((p) => p.startsWith(q)) || norm(e.quien).startsWith(q));
}

// --- Frases para voz ------------------------------------------------------------------------------------

const cortar = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const plural = (n: number, uno: string, varios: string) => (n === 1 ? uno : varios);
const haceDias = (d: number | null) => (d === null ? "sin fecha" : d === 0 ? "desde hoy" : `hace ${d} ${plural(d, "día", "días")}`);

export function mensajeEsperas(esperas: Espera[], de: string | null): string {
  const lista = de ? esperasDe(esperas, de) : esperas;
  if (!lista.length) return de ? `No tengo nada pendiente que estés esperando de ${nombreDe(de)}.` : "No estás esperando nada de nadie.";
  if (de) {
    const quien = lista[0].quien;
    const primeras = lista.slice(0, 3).map((e) => `${cortar(e.texto, 70)} (${haceDias(e.dias)})`).join("; ");
    const resto = lista.length > 3 ? `, y ${lista.length - 3} más` : "";
    return `Esperas ${lista.length} ${plural(lista.length, "cosa", "cosas")} de ${quien}: ${primeras}${resto}.`;
  }
  const porPersona = new Map<string, number>();
  for (const e of lista) porPersona.set(e.quien, (porPersona.get(e.quien) ?? 0) + 1);
  const personas = [...porPersona.entries()].sort((a, b) => b[1] - a[1]);
  const detalle = personas.slice(0, 4).map(([q, n]) => `${q} ${n}`).join(", ");
  const masVieja = lista[0].dias !== null ? ` La más antigua lleva ${lista[0].dias} ${plural(lista[0].dias, "día", "días")}, de ${lista[0].quien}.` : "";
  const vencidas = lista.filter((e) => e.vencida).length;
  const venc = vencidas ? ` ${vencidas} ${plural(vencidas, "pasa", "pasan")} de ${UMBRAL_VENCIDA_DIAS} días.` : "";
  return `Esperas ${lista.length} ${plural(lista.length, "cosa", "cosas")} de ${personas.length} ${plural(personas.length, "persona", "personas")}: ${detalle}.${masVieja}${venc}`;
}

export function mensajeReunion(r: Reunion, hoy: string, otras = 0): string {
  const cuando = cuandoHablado(limaDia(r.inicio), hoy);
  const dur = r.duracion_min ? `, de ${r.duracion_min} minutos` : "";
  const titulo = cortar(r.titulo, 80);
  const resumen = resumenCorto(r.resumen, 220);
  const abiertos = r.action_items.filter((a) => !a.hecho);
  let out = resumen
    ? `«${titulo}» fue ${cuando}${dur}. ${resumen}`
    : `«${titulo}» fue ${cuando}${dur}, pero Fathom todavía no tiene resumen.`;
  if (abiertos.length) {
    const ejemplos = abiertos.slice(0, 2).map((a) => `${cortar(a.texto, 70)}${a.dueno ? ` (${a.dueno})` : ""}`).join("; ");
    out += ` Quedaron ${abiertos.length} ${plural(abiertos.length, "acuerdo", "acuerdos")}: ${ejemplos}${abiertos.length > 2 ? ", entre otros" : ""}.`;
  }
  if (otras > 0) out += ` Hay ${otras} ${plural(otras, "reunión más", "reuniones más")} que también calzan.`;
  return out;
}
