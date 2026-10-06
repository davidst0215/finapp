// Rangos de fecha para «¿cuánto gasté esta semana?». Sin globals de Deno: se prueba con Node (semana.test.ts).

const DIA_MS = 24 * 60 * 60 * 1000;
const fecha = (d: Date) => d.toISOString().slice(0, 10);

/**
 * `limaNow` viene corrido a la hora de Lima (sus getters UTC dan la fecha de Lima). La semana empieza el lunes;
 * «últimos 7 días» es hoy y los 6 anteriores. Fechas AAAA-MM-DD, ambos extremos incluidos.
 */
export function rangoSemana(limaNow: Date): { lunes: string; hace7: string; hoy: string } {
  const desdeLunes = (limaNow.getUTCDay() + 6) % 7; // lunes = 0 … domingo = 6
  return {
    lunes: fecha(new Date(limaNow.getTime() - desdeLunes * DIA_MS)),
    hace7: fecha(new Date(limaNow.getTime() - 6 * DIA_MS)),
    hoy: fecha(limaNow),
  };
}
