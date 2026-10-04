// Frases que Wabid dice (y muestra) sobre la agenda y el correo. Las arma el código, no el modelo:
// horas y días como se hablan, sin inventar nada. Lógica pura.
import { palabras } from "../voz.ts";
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

// Qué tienes en `key`. Para hoy solo cuenta lo que aún no terminó.
export function resumenAgenda(events: CalEvent[], key: string, now: Date): string {
  const today = limaDateKey(now);
  const nowHM = limaHM(now);
  const dia = diaHablado(key, today);
  const delDia = events.filter((e) => e.my_response !== "declined" && e.day_key <= key && key <= e.end_day_key);
  const vigentes = key === today ? delDia.filter((e) => e.all_day || e.end_hm === "00:00" || e.end_hm > nowHM) : delDia;

  if (vigentes.length === 0) {
    if (key === today && delDia.length > 0) return "Ya no te quedan eventos hoy.";
    return key === today ? "No tienes nada en la agenda hoy." : `No tienes nada en la agenda ${dia}.`;
  }
  const todos = [...vigentes].sort((a, b) => Number(b.all_day) - Number(a.all_day) || a.start_hm.localeCompare(b.start_hm));
  const lista = todos.slice(0, 4).map((e) => (e.all_day ? `todo el día, ${corto(e.title)}` : `a ${horaHablada(e.start_hm)}, ${corto(e.title)}`));
  const resto = todos.length - lista.length;
  const intro = key === today
    ? `Te ${todos.length === 1 ? "queda" : "quedan"} ${plural(todos.length, "evento", "eventos")} hoy`
    : `${cap(dia)} tienes ${plural(todos.length, "evento", "eventos")}`;
  return `${intro}: ${lista.join("; ")}${resto > 0 ? `; y ${resto} más` : ""}.`;
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
