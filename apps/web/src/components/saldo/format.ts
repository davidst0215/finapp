// Textos del saldo de IA. Puro y sin React: se prueba con Node (format.test.ts).
// El servidor ya manda el texto de alcance y si el saldo está bajo (supabase/functions/_shared/saldo.ts):
// aquí solo queda dar formato a montos, caracteres y fechas.

export const usd = (n: number) => `US$ ${n.toFixed(2)}`;

// Separador de miles fijo (coma): no depende del locale del navegador ni de Node.
const num = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export const caracteres = (usados: number, limite: number) => `${num(usados)} de ${num(limite)} caracteres`;

/** "4 de noviembre", sin año (la renovación siempre es dentro del próximo mes). */
export const fechaCorta = (iso: string) =>
  new Date(iso).toLocaleDateString('es-PE', { day: 'numeric', month: 'long', timeZone: 'America/Lima' });

export const horaLima = (iso: string) =>
  new Date(iso).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Lima' });
