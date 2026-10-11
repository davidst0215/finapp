// Respuesta de "¿qué me falta pagar?" armada con los datos, no por el modelo:
// no inventa montos, no promete "revisar" y le ahorra tokens (latencia) a la llamada.
// `resumenRecurrentes` es lo que se ve (hasta 5 pagos con su fecha); `vozRecurrentes` es lo que se dice: el total, el primero y "y N más".

import { cortoVoz } from "../../_shared/voz.ts";

export type Recurrente = { recurring_id: string; description: string; amount: number; frequency: string; next_due_date: string };
export type FiltroRecurrentes = "all" | "pending" | "paid";

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const MAX_EN_PANTALLA = 5;

const soles = (n: number) => `S/ ${Number(n).toFixed(2)}`;

// "AAAA-MM-DD" → "el 15 de octubre" / "el primero de noviembre".
export function fechaHablada(iso: string): string {
  const [, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `el ${d === 1 ? "primero" : d} de ${MESES[m - 1]}`;
}

function enumerar(partes: string[]): string {
  const visibles = partes.slice(0, MAX_EN_PANTALLA);
  const resto = partes.length - visibles.length;
  if (resto > 0) return `${visibles.join(", ")} y ${resto} más`;
  return visibles.length > 1 ? `${visibles.slice(0, -1).join(", ")} y ${visibles.at(-1)}` : visibles[0] ?? "";
}

// Para la voz. Un pago concreto lleva su monto exacto ("S/ 26", "S/ 45.90"); un total se redondea y, solo si de verdad se
// redondeó, se dice «unos» ("unos S/ 452" para 452.25; "S/ 78" es exacto).
const monto = (n: number) => (Number.isInteger(Math.round(Number(n) * 100) / 100) ? `S/ ${Math.round(Number(n))}` : `S/ ${Number(n).toFixed(2)}`);
const aprox = (n: number) => {
  const r = Math.round(Number(n));
  return Math.abs(Number(n) - r) < 0.005 ? `S/ ${r}` : `unos S/ ${r}`;
};
const totalVoz = (rs: Recurrente[], suma: number) => (rs.length === 1 ? monto(rs[0]!.amount) : aprox(suma));

/** Lo que cuenta este mes: pagados, pendientes (vencen este mes o ya vencieron, sin pago) y el total de una lista. */
function estadoDelMes(lista: Recurrente[], pagados: Set<string>, hoy: string) {
  const finDeMes = `${hoy.slice(0, 8)}${new Date(Number(hoy.slice(0, 4)), Number(hoy.slice(5, 7)), 0).getDate()}`;
  const pagadosMes = lista.filter((r) => pagados.has(r.recurring_id));
  const pendientes = lista
    .filter((r) => !pagados.has(r.recurring_id) && r.next_due_date.slice(0, 10) <= finDeMes)
    .sort((a, b) => a.next_due_date.localeCompare(b.next_due_date));
  const suma = (rs: Recurrente[]) => rs.reduce((s, r) => s + Number(r.amount), 0);
  return { pagadosMes, pendientes, suma };
}

/**
 * @param hoy  fecha de Lima en AAAA-MM-DD
 * @param pagados  recurring_id con pago registrado este mes
 */
export function resumenRecurrentes(lista: Recurrente[], pagados: Set<string>, hoy: string, filtro: FiltroRecurrentes): string {
  if (lista.length === 0) return "No tienes pagos fijos registrados. Dime uno, por ejemplo: Netflix 52 mensual.";

  const { pagadosMes, pendientes, suma } = estadoDelMes(lista, pagados, hoy);
  const total = (rs: Recurrente[]) => soles(suma(rs));
  const pendiente = (r: Recurrente) =>
    `${r.description} ${soles(r.amount)} ${r.next_due_date.slice(0, 10) < hoy ? `vencido desde ${fechaHablada(r.next_due_date)}` : fechaHablada(r.next_due_date)}`;

  if (filtro === "paid") {
    if (pagadosMes.length === 0) return "Todavía no registras pagos fijos este mes.";
    return `Este mes ya pagaste ${enumerar(pagadosMes.map((r) => r.description))}: ${total(pagadosMes)} en total.`;
  }
  if (filtro === "pending") {
    if (pendientes.length === 0) return "No te falta pagar nada este mes.";
    return `Te ${pendientes.length === 1 ? "falta" : "faltan"} ${total(pendientes)}: ${enumerar(pendientes.map(pendiente))}.`;
  }
  // Sumar mensuales con anuales o semanales daría una cifra sin sentido: el total va solo si todos son mensuales.
  const cuantos = `${lista.length} ${lista.length === 1 ? "pago fijo" : "pagos fijos"}`;
  const base = lista.every((r) => r.frequency === "monthly")
    ? `Tienes ${cuantos} por ${total(lista)} al mes.`
    : `Tienes ${cuantos}.`;
  if (pendientes.length === 0) return `${base} Este mes no te falta ninguno.`;
  return `${base} Te ${pendientes.length === 1 ? "falta" : "faltan"} ${enumerar(pendientes.map(pendiente))}.`;
}

/** Lo que se dice: el total y solo el primer pago, con "y N más". Fechas y el resto se ven en pantalla. */
export function vozRecurrentes(lista: Recurrente[], pagados: Set<string>, hoy: string, filtro: FiltroRecurrentes): string {
  if (lista.length === 0) return resumenRecurrentes(lista, pagados, hoy, filtro); // ya es corto
  const { pagadosMes, pendientes, suma } = estadoDelMes(lista, pagados, hoy);
  const primero = (r: Recurrente) => `${cortoVoz(r.description, 24)} ${monto(r.amount)}${r.next_due_date.slice(0, 10) < hoy ? ", vencido" : ""}`;
  const faltan = pendientes.length === 0
    ? ""
    : pendientes.length === 1
    ? `Te falta ${primero(pendientes[0]!)}.`
    : `Te faltan ${aprox(suma(pendientes))}: ${primero(pendientes[0]!)}; y ${pendientes.length - 1} más.`;

  if (filtro === "paid") {
    if (pagadosMes.length === 0) return resumenRecurrentes(lista, pagados, hoy, filtro);
    return `Este mes ya pagaste ${totalVoz(pagadosMes, suma(pagadosMes))} en ${pagadosMes.length} ${pagadosMes.length === 1 ? "pago" : "pagos"}.`;
  }
  if (filtro === "pending") return faltan || resumenRecurrentes(lista, pagados, hoy, filtro);
  const cuantos = `${lista.length} ${lista.length === 1 ? "pago fijo" : "pagos fijos"}`;
  const base = lista.every((r) => r.frequency === "monthly") ? `Tienes ${cuantos} por ${totalVoz(lista, suma(lista))} al mes.` : `Tienes ${cuantos}.`;
  return faltan ? `${base} ${faltan}` : `${base} Este mes no te falta ninguno.`;
}
