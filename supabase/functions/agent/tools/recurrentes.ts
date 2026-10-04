// Respuesta de "¿qué me falta pagar?" armada con los datos, no por el modelo:
// no inventa montos, no promete "revisar" y le ahorra tokens (latencia) a la llamada.

export type Recurrente = { recurring_id: string; description: string; amount: number; frequency: string; next_due_date: string };
export type FiltroRecurrentes = "all" | "pending" | "paid";

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const MAX_EN_VOZ = 5;

const soles = (n: number) => `S/ ${Number(n).toFixed(2)}`;

// "AAAA-MM-DD" → "el 15 de octubre" / "el primero de noviembre".
export function fechaHablada(iso: string): string {
  const [, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `el ${d === 1 ? "primero" : d} de ${MESES[m - 1]}`;
}

function enumerar(partes: string[]): string {
  const visibles = partes.slice(0, MAX_EN_VOZ);
  const resto = partes.length - visibles.length;
  if (resto > 0) return `${visibles.join(", ")} y ${resto} más`;
  return visibles.length > 1 ? `${visibles.slice(0, -1).join(", ")} y ${visibles.at(-1)}` : visibles[0] ?? "";
}

/**
 * @param hoy  fecha de Lima en AAAA-MM-DD
 * @param pagados  recurring_id con pago registrado este mes
 */
export function resumenRecurrentes(lista: Recurrente[], pagados: Set<string>, hoy: string, filtro: FiltroRecurrentes): string {
  if (lista.length === 0) return "No tienes pagos fijos registrados. Dime uno, por ejemplo: Netflix 52 mensual.";

  const finDeMes = `${hoy.slice(0, 8)}${new Date(Number(hoy.slice(0, 4)), Number(hoy.slice(5, 7)), 0).getDate()}`;
  const pagadosMes = lista.filter((r) => pagados.has(r.recurring_id));
  // Pendiente = vence este mes (o ya venció) y no tiene pago registrado este mes.
  const pendientes = lista
    .filter((r) => !pagados.has(r.recurring_id) && r.next_due_date.slice(0, 10) <= finDeMes)
    .sort((a, b) => a.next_due_date.localeCompare(b.next_due_date));
  const total = (rs: Recurrente[]) => soles(rs.reduce((s, r) => s + Number(r.amount), 0));
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
