// Frases que Wabid dice (y muestra) sobre la agenda y el correo. Las arma el código, no el modelo:
// horas y días como se hablan, sin inventar nada. Lógica pura.
import { cortoVoz, palabras } from "../voz.ts";
import type { CalEvent } from "./events.ts";
import type { MailItem } from "./mail.ts";
import { addDays, DIAS, limaDateKey, limaHM, MESES, weekdayOf } from "./time.ts";

// "15:00" → "las tres de la tarde"; "11:30" → "las once y media de la mañana".
export function horaHablada(hm: string): string {
  const [h = 0, m = 0] = hm.split(":").map(Number);
  const periodo = h === 12 ? "del día" : h >= 19 ? "de la noche" : h >= 13 ? "de la tarde" : h >= 6 ? "de la mañana" : h === 0 ? "de la noche" : "de la madrugada";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const hora = h12 === 1 ? "la una" : `las ${palabras(h12)}`;
  const min = m === 0 ? "" : m === 15 ? " y cuarto" : m === 30 ? " y media" : ` y ${palabras(m)}`;
  return `${hora}${min} ${periodo}`;
}

// "hoy", "mañana", "el viernes 9 de octubre", "el viernes primero de noviembre".
export function diaHablado(key: string, today: string): string {
  if (key === today) return "hoy";
  if (key === addDays(today, 1)) return "mañana";
  if (key === addDays(today, 2)) return "pasado mañana";
  if (key === addDays(today, -1)) return "ayer";
  const [y = 0, m = 1, d = 1] = key.split("-").map(Number);
  const dia = DIAS[weekdayOf(key)];
  const anio = String(y) === today.slice(0, 4) ? "" : ` de ${y}`;
  return `el ${dia} ${d === 1 ? "primero" : d} de ${MESES[m - 1]}${anio}`;
}

const corto = (s: string, max = 60) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

type Agenda = { today: string; dia: string; todos: CalEvent[]; terminados: boolean };

// Los eventos de `key` que cuentan: sin los rechazados y, para hoy, solo los que aún no terminaron. Los de todo el día primero.
function agendaDe(events: CalEvent[], key: string, now: Date): Agenda {
  const today = limaDateKey(now);
  const nowHM = limaHM(now);
  const delDia = events.filter((e) => e.my_response !== "declined" && e.day_key <= key && key <= e.end_day_key);
  const vigentes = key === today ? delDia.filter((e) => e.all_day || e.end_hm === "00:00" || e.end_hm > nowHM) : delDia;
  const todos = [...vigentes].sort((a, b) => Number(b.all_day) - Number(a.all_day) || a.start_hm.localeCompare(b.start_hm));
  return { today, dia: diaHablado(key, today), todos, terminados: delDia.length > 0 };
}

const agendaVacia = (a: Agenda, key: string) =>
  key === a.today ? (a.terminados ? "Ya no te quedan eventos hoy." : "No tienes nada en la agenda hoy.") : `No tienes nada en la agenda ${a.dia}.`;

const introAgenda = (a: Agenda, key: string) =>
  key === a.today ? `Te ${a.todos.length === 1 ? "queda" : "quedan"} ${plural(a.todos.length, "evento", "eventos")} hoy` : `${cap(a.dia)} tienes ${plural(a.todos.length, "evento", "eventos")}`;

const itemAgenda = (e: CalEvent, max: number) => (e.all_day ? `todo el día, ${corto(e.title, max)}` : `a ${horaHablada(e.start_hm)}, ${corto(e.title, max)}`);

// Qué tienes en `key` (lo que se ve: hasta 4 eventos). Para hoy solo cuenta lo que aún no terminó.
export function resumenAgenda(events: CalEvent[], key: string, now: Date): string {
  const a = agendaDe(events, key, now);
  if (a.todos.length === 0) return agendaVacia(a, key);
  const lista = a.todos.slice(0, 4).map((e) => itemAgenda(e, 60));
  const resto = a.todos.length - lista.length;
  return `${introAgenda(a, key)}: ${lista.join("; ")}${resto > 0 ? `; y ${resto} más` : ""}.`;
}

const PRESUPUESTO_AGENDA = 96; // por debajo de VOZ_MAX: la frase entera cabe y conserva su «y N más»
const MIN_TITULO = 24; // un título que hay que cortar debe conservar al menos esto; si no, se acorta antes la hora o la fecha

/**
 * Lo que se dice: cuántos eventos hay, el primero y «y N más». El resto se ve en pantalla.
 * La frase se presupuesta: el «y N más» se reserva primero y el título recibe lo que sobra. Si con una fecha lejana
 * ("el viernes 15 de enero de 2027") o una hora con minutos ("las ocho y cuarenta y cinco de la noche") el título quedaría
 * quedaría cortado a menos de MIN_TITULO, se acorta primero la hora (a las 20:45), luego la fecha (el viernes 15) y por último se omite.
 */
export function vozAgenda(events: CalEvent[], key: string, now: Date): string {
  const a = agendaDe(events, key, now);
  if (a.todos.length === 0) return agendaVacia(a, key);
  const n = a.todos.length;
  const primero = a.todos[0]!;
  const cola = n > 1 ? `; y ${n - 1} más.` : ".";
  const cuenta = plural(n, "evento", "eventos");

  const diaCorto = a.dia.replace(/^(el \S+ \S+).*$/, "$1");
  const intros = key === a.today
    ? [`Te ${n === 1 ? "queda" : "quedan"} ${cuenta} hoy`]
    : [...new Set([`${cap(a.dia)} tienes ${cuenta}`, `${cap(diaCorto)} tienes ${cuenta}`, `Tienes ${cuenta}`])];
  const cuandos = primero.all_day
    ? ["todo el día"]
    : [`a ${horaHablada(primero.start_hm)}`, `a las ${primero.start_hm.replace(/^0/, "")}`];

  for (const intro of intros) {
    for (const cuando of cuandos) {
      const base = `${intro}: ${cuando}, `;
      const sitio = PRESUPUESTO_AGENDA - base.length - cola.length;
      if (primero.title.length <= sitio || sitio >= MIN_TITULO) return `${base}${cortoVoz(primero.title, sitio)}${cola}`;
    }
  }
  // Ni así cabe un título: se dice sin él, con la hora más corta y el «y N más» intactos.
  return `${intros.at(-1)}: ${cuandos.at(-1)}${cola}`;
}

export const remitenteCorto = (m: Pick<MailItem, "from_name" | "from_email">) => {
  const n = m.from_name.trim().split(/\s+/)[0];
  return n || m.from_email.split("@")[0] || m.from_email;
};

export function resumenCorreo(items: MailItem[]): string {
  if (items.length === 0) return "No tienes correos importantes recientes.";
  const sinLeer = items.filter((m) => m.unread).length;
  const partes = [`Tienes ${plural(items.length, "correo importante", "correos importantes")}${sinLeer > 0 ? `, ${sinLeer} sin leer` : ""}.`];
  const alarma = items.find((m) => m.alarm);
  if (alarma) partes.push(`Ojo: ${remitenteCorto(alarma)} avisa «${corto(alarma.subject)}».`);
  const resto = items.filter((m) => m !== alarma).slice(0, alarma ? 2 : 3);
  if (resto.length) partes.push(resto.map((m) => `${corto(remitenteCorto(m), 24)}: ${corto(m.subject)}`).join("; ") + ".");
  return partes.join(" ");
}

// Lo que se dice: cuántos hay y lo más urgente (una alarma, o si no el primero). El resto se ve en pantalla.
export function vozCorreo(items: MailItem[]): string {
  if (items.length === 0) return "No tienes correos importantes recientes.";
  const sinLeer = items.filter((m) => m.unread).length;
  const cuenta = `Tienes ${plural(items.length, "correo importante", "correos importantes")}${sinLeer > 0 ? `, ${sinLeer} sin leer` : ""}`;
  const alarma = items.find((m) => m.alarm);
  if (alarma) return `${cuenta}. Ojo: ${remitenteCorto(alarma)} avisa «${cortoVoz(alarma.subject, 32)}».`;
  const primero = items[0]!;
  return `${cuenta}; el primero, de ${cortoVoz(remitenteCorto(primero), 20)}: ${cortoVoz(primero.subject, 32)}.`;
}
