// Cerebro de caja de Wabid (SPEC-cerebro.md): cuánto puede gastar David y qué le toca pagar, calculado por código.
// Puro: sin red ni base, misma entrada → misma salida. Montos en céntimos enteros por dentro (las sumas cuadran exacto) y fechas
// como texto AAAA-MM-DD con aritmética en UTC (la zona horaria nunca corre un día). Es el motor probado en el prototipo
// Documents/Wabid/cierre-2026.html, más las bolsas semanales de gasto variable.

export type Programado = {
  id: string;
  concepto: string;
  tipo: "income" | "expense";
  monto: number; // en soles (los dólares ya convertidos)
  frecuencia: string; // once | daily | weekly | biweekly | monthly | quarterly | semiannual | annual
  proxima: string; // la próxima sin pagar; si ya pasó, está vencida
  dia: number | null; // día del mes de los mensuales (31 = fin de mes)
  fin: string | null; // end_date
};
// `cambio`: un tope nuevo ya decidido, para las semanas que empiezan desde `desde` («compras baja a 70 desde el 16-nov»).
export type Bolsa = { nombre: string; topeSemanal: number; categorias: string[] | null; arrastre: boolean; cambio?: { desde: string; tope: number } | null };
export type Gasto = { fecha: string; monto: number; categoria: string | null; programado: boolean };
export type Plan = { inicio: string; metaMonto: number | null; metaFecha: string | null; colchon: number };
export type EntradaCaja = { hoy: string; caja: number; programados: Programado[]; bolsas: Bolsa[]; gastos: Gasto[]; plan: Plan | null };

export type Periodo = { desde: string; hasta: string };
export type EstadoBolsa = { nombre: string; tope: number; gastado: number; queda: number }; // céntimos; `queda` < 0 = se pasó
export type Evento = { fecha: string; efectiva: string; concepto: string; monto: number; tipo: "income" | "expense"; vencido: boolean; id: string };
export type Proyeccion = {
  periodo: Periodo;
  bolsas: EstadoBolsa[];
  serie: { fecha: string; saldo: number; sinVariables: number }[];
  eventos: Evento[]; // lo programado y pendiente, en orden
  minimo: { fecha: string; saldo: number }; // con las bolsas reservadas, en los próximos 60 días
  proximoIngreso: Evento | null;
  disponibleHastaIngreso: number | null; // lo que se puede gastar antes del próximo ingreso sin quedar bajo el colchón
  faltante: { fecha: string; falta: number } | null; // el primer día bajo el colchón, con las bolsas reservadas
  meta: { fecha: string; monto: number; cierre: number; holgura: number } | null;
  libre: number; // gasto extra posible hoy, fuera de las bolsas, sin romper la caja ni la meta
  errores: string[];
};

const HORIZONTE_DIAS = 60;
const DIA_SEMANA = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

// --- Fechas -------------------------------------------------------------------------------------------------------------
const aFecha = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y!, m! - 1, d)); };
const aTexto = (d: Date) => d.toISOString().slice(0, 10);
export const sumarDias = (s: string, n: number) => { const d = aFecha(s); d.setUTCDate(d.getUTCDate() + n); return aTexto(d); };
const diasEntre = (a: string, b: string) => Math.round((aFecha(b).getTime() - aFecha(a).getTime()) / 86_400_000);
const diaSemana = (s: string) => aFecha(s).getUTCDay();
const diasDelMes = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m de 1 a 12
const mayor = (a: string, b: string) => (a > b ? a : b);
const cent = (x: number) => Math.round((Number(x) || 0) * 100);

/**
 * La fecha siguiente de un pago programado. En los mensuales (y trimestrales, semestrales, anuales) el día es el del pago (`dia`),
 * recortado al último del mes: el 31 cae el 30 de noviembre y el 28 de febrero. `Date#setMonth` no sirve: del 31-oct salta al 1-dic.
 */
export function siguienteFecha(fecha: string, frecuencia: string, dia: number | null = null): string {
  const saltoDias: Record<string, number> = { daily: 1, weekly: 7, biweekly: 14 };
  if (saltoDias[frecuencia]) return sumarDias(fecha, saltoDias[frecuencia]!);
  const meses: Record<string, number> = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 };
  const n = meses[frecuencia];
  if (!n) return fecha; // 'once' no tiene siguiente
  const [y, m, d] = fecha.split("-").map(Number);
  const total = (m! - 1) + n;
  const ny = y! + Math.floor(total / 12), nm = (total % 12) + 1;
  const nd = Math.min(dia ?? d!, diasDelMes(ny, nm));
  return `${ny}-${String(nm).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}

/**
 * La semana de las bolsas: de lunes a domingo. Si el plan arranca en fin de semana (sábado o domingo), esos días cuentan dentro de
 * la semana siguiente («lo que gaste hoy y mañana va en la semana del 26 al 1», 24-oct): el primer periodo va del inicio al domingo
 * de la semana siguiente.
 */
export function periodoDe(fecha: string, inicio: string | null): Periodo {
  if (inicio && fecha >= inicio) {
    const dow = diaSemana(inicio);
    if (dow === 6 || dow === 0) {
      const domingoSiguiente = sumarDias(inicio, dow === 6 ? 8 : 7);
      if (fecha <= domingoSiguiente) return { desde: inicio, hasta: domingoSiguiente };
    }
  }
  const lunes = sumarDias(fecha, -((diaSemana(fecha) + 6) % 7));
  return { desde: inicio && inicio > lunes && inicio <= fecha ? inicio : lunes, hasta: sumarDias(lunes, 6) };
}

/** La bolsa de un gasto: la que nombra su categoría; si ninguna, la del resto (categorías NULL); si no hay, ninguna. */
export function bolsaDe(categoria: string | null, bolsas: Bolsa[]): Bolsa | null {
  const c = (categoria ?? "").trim().toLowerCase();
  return (c && bolsas.find((b) => b.categorias?.some((x) => x.trim().toLowerCase() === c))) || bolsas.find((b) => b.categorias === null) || null;
}

/** El tope de una bolsa para la semana que empieza en `desde` (céntimos). */
const topeEn = (b: Bolsa, desde: string) => cent(b.cambio && desde >= b.cambio.desde ? b.cambio.tope : b.topeSemanal);

/** Cuánto lleva y cuánto le queda a cada bolsa en el periodo de `hoy`. Con arrastre, lo no gastado desde el inicio del plan se suma. */
export function estadoBolsas(e: EntradaCaja): EstadoBolsa[] {
  const inicio = e.plan?.inicio ?? null;
  const p = periodoDe(e.hoy, inicio);
  const variables = e.gastos.filter((g) => !g.programado && g.fecha <= e.hoy);
  return e.bolsas.map((b) => {
    const mios = variables.filter((g) => bolsaDe(g.categoria, e.bolsas) === b);
    const tope = topeEn(b, p.desde);
    const gastado = mios.filter((g) => g.fecha >= p.desde).reduce((t, g) => t + cent(g.monto), 0);
    if (!b.arrastre || !inicio) return { nombre: b.nombre, tope, gastado, queda: tope - gastado };
    // Periodos desde el inicio del plan hasta este (incluido): el primero puede ser largo (ver periodoDe).
    const primero = periodoDe(inicio, inicio);
    const n = p.desde <= primero.hasta ? 1 : 2 + Math.floor(diasEntre(sumarDias(primero.hasta, 1), p.desde) / 7);
    const desdeInicio = mios.filter((g) => g.fecha >= inicio).reduce((t, g) => t + cent(g.monto), 0);
    return { nombre: b.nombre, tope: tope * n - (desdeInicio - gastado), gastado, queda: tope * n - desdeInicio };
  });
}

/** Reparte `total` céntimos en `n` días lo más parejo posible (los primeros llevan el céntimo que sobra). */
function repartir(total: number, n: number): number[] {
  if (n <= 0 || total <= 0) return new Array(Math.max(n, 0)).fill(0);
  const base = Math.floor(total / n), resto = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < resto ? 1 : 0));
}

export function proyectar(e: EntradaCaja): Proyeccion {
  const hoy = e.hoy, plan = e.plan;
  const colchon = cent(plan?.colchon ?? 0);
  const finVentana = sumarDias(hoy, HORIZONTE_DIAS - 1);
  const hasta = plan?.metaFecha && plan.metaFecha > finVentana ? plan.metaFecha : finVentana;
  const periodo = periodoDe(hoy, plan?.inicio ?? null);
  const bolsas = estadoBolsas(e);

  // Lo programado y pendiente hasta el horizonte. Lo vencido se cuenta hoy.
  const eventos: Evento[] = [];
  for (const p of e.programados) {
    let f = p.proxima, vueltas = 0;
    while (f <= hasta && (!p.fin || f <= p.fin) && vueltas++ < 500) {
      eventos.push({ id: p.id, fecha: f, efectiva: f < hoy ? hoy : f, concepto: p.concepto, tipo: p.tipo, vencido: f < hoy, monto: (p.tipo === "income" ? 1 : -1) * cent(p.monto) });
      if (p.frecuencia === "once") break;
      const sig = siguienteFecha(f, p.frecuencia, p.dia);
      if (sig <= f) break;
      f = sig;
    }
  }
  eventos.sort((a, b) => a.efectiva.localeCompare(b.efectiva) || (b.monto > 0 ? 1 : 0) - (a.monto > 0 ? 1 : 0) || a.concepto.localeCompare(b.concepto));

  // Las bolsas se reservan parejo cada día: lo que queda de esta semana hasta su domingo; después, el tope de cada semana entera.
  const n = diasEntre(hoy, hasta) + 1;
  const reserva = new Array(n).fill(0);
  const finPeriodo = diasEntre(hoy, periodo.hasta);
  bolsas.forEach((b, k) => {
    repartir(Math.max(b.queda, 0), Math.min(finPeriodo + 1, n)).forEach((c, i) => (reserva[i] += c));
    for (let ini = finPeriodo + 1; ini < n; ini += 7) {
      repartir(topeEn(e.bolsas[k]!, sumarDias(hoy, ini)), 7).forEach((c, i) => { if (ini + i < n) reserva[ini + i] += c; });
    }
  });

  const porDia = new Map<string, number>();
  for (const ev of eventos) porDia.set(ev.efectiva, (porDia.get(ev.efectiva) ?? 0) + ev.monto);
  const serie: Proyeccion["serie"] = [];
  let saldo = cent(e.caja), sinVariables = cent(e.caja);
  for (let i = 0; i < n; i++) {
    const fecha = sumarDias(hoy, i);
    const mov = porDia.get(fecha) ?? 0;
    saldo += mov - reserva[i];
    sinVariables += mov;
    serie.push({ fecha, saldo, sinVariables });
  }

  const ventana = serie.filter((p) => p.fecha <= finVentana);
  const minimo = ventana.reduce((a, p) => (p.saldo < a.saldo ? p : a), ventana[0]!);
  const proximoIngreso = eventos.find((ev) => ev.tipo === "income") ?? null;
  const antes = proximoIngreso ? serie.filter((p) => p.fecha < proximoIngreso.efectiva) : [];
  const disponibleHastaIngreso = proximoIngreso
    ? Math.max(0, (antes.length ? Math.min(...antes.map((p) => p.sinVariables)) : cent(e.caja)) - colchon)
    : null;
  const bajo = serie.find((p) => p.saldo < colchon);
  const faltante = bajo ? { fecha: bajo.fecha, falta: colchon - bajo.saldo } : null;
  let meta: Proyeccion["meta"] = null;
  if (plan?.metaMonto != null && plan.metaFecha && plan.metaFecha >= hoy) {
    const cierre = serie.find((p) => p.fecha === plan.metaFecha)!.saldo;
    meta = { fecha: plan.metaFecha, monto: cent(plan.metaMonto), cierre, holgura: cierre - cent(plan.metaMonto) };
  }
  const libre = Math.max(0, Math.min(minimo.saldo - colchon, meta ? meta.holgura : Infinity));

  // Invariantes: si alguna falla, la respuesta lo dice en vez de dar una cifra falsa.
  const errores: string[] = [];
  const sumaEventos = eventos.reduce((t, ev) => t + ev.monto, 0);
  const sumaReserva = reserva.reduce((t, c) => t + c, 0);
  if (serie.at(-1)!.sinVariables !== cent(e.caja) + sumaEventos) errores.push("la serie sin gastos variables no cuadra con lo programado");
  if (serie.at(-1)!.saldo !== cent(e.caja) + sumaEventos - sumaReserva) errores.push("la serie con bolsas no cuadra con lo reservado");

  return { periodo, bolsas, serie, eventos, minimo, proximoIngreso, disponibleHastaIngreso, faltante, meta, libre, errores };
}

// --- Frases (pantalla y voz) --------------------------------------------------------------------------------------------
const nf = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
/** Céntimos → «S/ 1,250» redondo (la voz lo pasa a palabras). */
export const soles = (c: number) => `S/ ${nf.format(Math.round(Math.abs(c) / 100))}`;
const fechaCorta = (s: string) => `${Number(s.slice(8, 10)) === 1 ? "primero" : Number(s.slice(8, 10))} de ${MESES[Number(s.slice(5, 7)) - 1]}`;
/** «el domingo» si cae dentro de esta semana; si no, «el domingo 1 de noviembre». */
const hastaCuando = (fecha: string, hoy: string) =>
  diasEntre(hoy, fecha) <= 6 ? `el ${DIA_SEMANA[diaSemana(fecha)]}` : `el ${DIA_SEMANA[diaSemana(fecha)]} ${fechaCorta(fecha)}`;
const nombreBolsa = (n: string) => n.toLowerCase();
const enumerar = (partes: string[]) => (partes.length > 1 ? `${partes.slice(0, -1).join(", ")} y ${partes.at(-1)}` : partes[0] ?? "");

/** «¿Cuánto puedo gastar hasta el fin de semana?»: lo que queda de cada bolsa y, si la caja no da, el aviso primero de todo. */
export function fraseCuantoPuedo(p: Proyeccion, hoy: string): { message: string; voz: string } {
  if (p.errores.length) return { message: `No confío en el cálculo ahora: ${p.errores.join("; ")}.`, voz: "No confío en el cálculo de caja ahora; revisa la pantalla." };
  const cuando = hastaCuando(p.periodo.hasta, hoy);
  const partes = p.bolsas.map((b) => (b.queda >= 0 ? `${nombreBolsa(b.nombre)} ${soles(b.queda)}` : `${nombreBolsa(b.nombre)} en rojo por ${soles(b.queda)}`));
  const total = p.bolsas.reduce((t, b) => t + Math.max(b.queda, 0), 0);
  const avisos: string[] = [];
  // La caja manda sobre los topes: si antes del próximo ingreso no alcanza, eso va primero.
  const ingreso = p.proximoIngreso;
  if (ingreso && p.disponibleHastaIngreso !== null && ingreso.efectiva <= p.periodo.hasta && p.disponibleHastaIngreso < total) {
    const antes = sumarDias(ingreso.efectiva, -1);
    avisos.push(p.disponibleHastaIngreso > 0
      ? `Ojo: hasta el ${fechaCorta(antes)} solo hay ${soles(p.disponibleHastaIngreso)} para todo; el resto, desde el ${fechaCorta(ingreso.efectiva)}.`
      : `Ojo: hasta el ${fechaCorta(antes)} no tienes margen; el resto, desde el ${fechaCorta(ingreso.efectiva)}.`);
  } else if (p.faltante) {
    avisos.push(`Ojo: el ${fechaCorta(p.faltante.fecha)} la caja quedaría corta por ${soles(p.faltante.falta)}.`);
  }
  if (p.meta && p.meta.holgura < 0) avisos.push(`Con estos topes cierras con ${soles(p.meta.cierre)}: faltan ${soles(-p.meta.holgura)} para tu meta.`);
  else if (!avisos.length && p.libre > 0) avisos.push(`Fuera de eso tienes ${soles(p.libre)} libres sin tocar tu meta.`);
  if (!p.bolsas.length) {
    const base = `Aún no tienes topes semanales. Dime «ponle un tope semanal de 200 a la comida».`;
    return { message: `${base}${p.libre > 0 ? ` Hoy tienes ${soles(p.libre)} libres sin romper la caja.` : ""}`, voz: base };
  }
  const message = `Hasta ${cuando} te quedan ${soles(total)}: ${enumerar(partes)}.${avisos.length ? ` ${avisos.join(" ")}` : ""}`;
  const voz = `Hasta ${cuando} te quedan: ${enumerar(partes)}.${avisos.length ? ` ${avisos[0]}` : ""}`;
  return { message, voz };
}

/** Después de anotar un gasto: cuánto le queda a su bolsa esta semana. */
export function fraseRestante(b: EstadoBolsa, p: Periodo, hoy: string): string {
  const cuando = hastaCuando(p.hasta, hoy);
  return b.queda >= 0
    ? `Te quedan ${soles(b.queda)} de ${nombreBolsa(b.nombre)} hasta ${cuando}.`
    : `Te pasaste ${soles(b.queda)} de ${nombreBolsa(b.nombre)} esta semana.`;
}
