// Fechas del vault en hora de Lima. Todo recibe `hoy` (AAAA-MM-DD) en vez de leer el reloj: así es
// determinista y se prueba sin mocks. El runtime de las edge functions corre en UTC; Lima es UTC-5 todo el año.

export const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"] as const;
export const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
] as const;
// Mismas abreviaturas que Norte (fmtDue en public/app.js): "lunes 31 ago".
export const MESES_CORTOS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"] as const;

const MS_DIA = 86_400_000;

/** Fecha de Lima (AAAA-MM-DD) para un instante real. */
export function limaToday(now: Date = new Date()): string {
  return new Date(now.getTime() - 5 * 3_600_000).toISOString().slice(0, 10);
}

const toUtc = (iso: string): number => {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};

/** AAAA-MM-DD que además existe en el calendario (rechaza 2026-02-30). */
export function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return new Date(toUtc(s)).toISOString().slice(0, 10) === s;
}

export function addDays(iso: string, n: number): string {
  return new Date(toUtc(iso) + n * MS_DIA).toISOString().slice(0, 10);
}

/** Días entre dos fechas: a - b (positivo si `a` es posterior). */
export function diffDays(a: string, b: string): number {
  return Math.round((toUtc(a) - toUtc(b)) / MS_DIA);
}

/** 0 = domingo … 6 = sábado. */
export function weekday(iso: string): number {
  return new Date(toUtc(iso)).getUTCDay();
}

const parts = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
};

/** "lunes 31 ago"; agrega el año si no es el de `hoy` (como Norte). */
export function fechaCorta(iso: string, hoy: string): string {
  const { y, m, d } = parts(iso);
  const anio = y === parts(hoy).y ? "" : ` ${y}`;
  return `${DIAS[weekday(iso)]} ${d} ${MESES_CORTOS[m - 1]}${anio}`;
}

/**
 * Etiqueta de vencimiento para la lista.
 * Abierta y pasada → "Venció ayer" / "Venció hace 3 días" / "Venció el lunes 31 ago" (overdue = true).
 * Si no, "hoy" / "mañana" / "viernes 9 oct". Una tarea hecha nunca está vencida.
 */
export function etiquetaFecha(iso: string, hoy: string, abierta: boolean): { label: string; overdue: boolean } {
  const dif = diffDays(iso, hoy);
  if (dif < 0 && abierta) {
    if (dif === -1) return { label: "Venció ayer", overdue: true };
    if (dif > -14) return { label: `Venció hace ${-dif} días`, overdue: true };
    return { label: `Venció el ${fechaCorta(iso, hoy)}`, overdue: true };
  }
  if (dif === 0) return { label: "hoy", overdue: false };
  if (dif === 1) return { label: "mañana", overdue: false };
  return { label: fechaCorta(iso, hoy), overdue: false };
}

/** Para la voz: "hoy", "mañana", "ayer", "el lunes 31 de agosto", "el primero de noviembre". */
export function fechaHablada(iso: string, hoy: string): string {
  const dif = diffDays(iso, hoy);
  if (dif === 0) return "hoy";
  if (dif === 1) return "mañana";
  if (dif === -1) return "ayer";
  const { y, m, d } = parts(iso);
  // Dentro de la semana que viene conviene decir el día: "el viernes 9 de octubre".
  const sem = dif >= 2 && dif <= 6 ? `${DIAS[weekday(iso)]} ` : "";
  const anio = y === parts(hoy).y ? "" : ` de ${y}`;
  return `el ${sem}${d === 1 ? "primero" : d} de ${MESES[m - 1]}${anio}`;
}

const sinTildes = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

const MES_NUM: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9,
  octubre: 10, noviembre: 11, diciembre: 12, ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8,
  sep: 9, set: 9, oct: 10, nov: 11, dic: 12,
};

const NUM_PALABRAS: Record<string, number> = {
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
};

/**
 * Convierte lo que dice o escribe David en una fecha. Acepta:
 * AAAA-MM-DD · hoy · mañana · pasado mañana · +N · en N días/semanas · (el|este|próximo) lunes…domingo · fin de mes ·
 * "15 de octubre" · "15/10" · "el 15". Un día de la semana es siempre la próxima ocurrencia estrictamente posterior
 * a hoy; una fecha sin año es la próxima vez que cae (nunca en el pasado).
 * Devuelve null si no entiende (nunca adivina).
 */
export function resolveDue(spec: unknown, hoy: string): string | null {
  if (typeof spec !== "string") return null;
  const s = sinTildes(spec.toLowerCase()).replace(/[.,;¿?¡!]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return isIsoDate(s) ? s : null;
  if (s === "hoy") return hoy;
  if (s === "manana") return addDays(hoy, 1);
  if (s === "pasado manana") return addDays(hoy, 2);

  const mas = /^\+\s?(\d{1,3})\s?d?$/.exec(s);
  if (mas) return addDays(hoy, Number(mas[1]));

  const en = /^(?:en\s+)?(\d{1,3}|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s+(dias?|semanas?)$/.exec(s);
  if (en) {
    const n = NUM_PALABRAS[en[1]] ?? Number(en[1]);
    return addDays(hoy, en[2].startsWith("semana") ? n * 7 : n);
  }

  if (s === "fin de mes" || s === "a fin de mes" || s === "fin del mes") {
    const { y, m } = parts(hoy);
    return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  }

  const dia = /^(?:(?:el|este|proximo|el proximo|para el|para este)\s+)*(domingo|lunes|martes|miercoles|jueves|viernes|sabado)$/.exec(s);
  if (dia) {
    const objetivo = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"].indexOf(dia[1]);
    let delta = (objetivo - weekday(hoy) + 7) % 7;
    if (delta === 0) delta = 7;
    return addDays(hoy, delta);
  }

  // "15 de octubre", "el 3 oct de 2027", "15/10": sin año se toma la próxima vez que cae (nunca en el pasado).
  const iso = (y: number, m: number, d: number) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const proxima = (m: number, d: number): string | null => {
    const y = parts(hoy).y;
    const este = iso(y, m, d);
    const cand = isIsoDate(este) && este >= hoy ? este : iso(y + 1, m, d);
    return isIsoDate(cand) ? cand : null;
  };
  const dm = /^(?:el\s+)?(\d{1,2})\s+(?:de\s+)?([a-z]+)(?:\s+(?:de\s+)?(\d{4}))?$/.exec(s);
  if (dm && MES_NUM[dm[2]]) {
    const [d, m] = [Number(dm[1]), MES_NUM[dm[2]]];
    if (dm[3]) return isIsoDate(iso(Number(dm[3]), m, d)) ? iso(Number(dm[3]), m, d) : null;
    return proxima(m, d);
  }
  const barra = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{4}))?$/.exec(s);
  if (barra) {
    const [d, m] = [Number(barra[1]), Number(barra[2])];
    if (barra[3]) return isIsoDate(iso(Number(barra[3]), m, d)) ? iso(Number(barra[3]), m, d) : null;
    return m >= 1 && m <= 12 ? proxima(m, d) : null;
  }
  const soloDia = /^el\s+(\d{1,2})$/.exec(s);
  if (soloDia) {
    const d = Number(soloDia[1]);
    const { y, m } = parts(hoy);
    const este = iso(y, m, d);
    if (isIsoDate(este) && este >= hoy) return este;
    const sig = m === 12 ? iso(y + 1, 1, d) : iso(y, m + 1, d);
    return isIsoDate(sig) ? sig : null;
  }
  return null;
}
