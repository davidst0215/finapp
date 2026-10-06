// Textos del saldo de IA. Puro y sin React: se prueba con Node (format.test.ts).
import type { Proyeccion } from './types';

/** Debajo de este restante (US$) el saldo se marca como alerta. Igual que el servidor (_shared/saldo.ts). */
export const UMBRAL_BAJO_USD = 2;

export const usd = (n: number) => `US$ ${n.toFixed(2)}`;

export function duracion(dias: number): string {
  if (dias < 30) return dias <= 1 ? 'un día' : `unos ${dias} días`;
  const meses = Math.round(dias / 30);
  return meses === 1 ? 'un mes' : `unos ${meses} meses`;
}

export function textoProyeccion(p: Proyeccion): string {
  if (p.tipo === 'agotado') return 'Saldo agotado';
  if (p.tipo === 'mas_de_12_meses') return 'A este ritmo dura más de 12 meses';
  return `A este ritmo alcanza para ${duracion(p.dias)}`;
}

const num = (n: number) => n.toLocaleString('es-PE');

export const caracteres = (usados: number, limite: number) => `${num(usados)} de ${num(limite)} caracteres`;

/** "4 de noviembre", sin año (la renovación siempre es dentro del próximo mes). */
export const fechaCorta = (iso: string) =>
  new Date(iso).toLocaleDateString('es-PE', { day: 'numeric', month: 'long', timeZone: 'America/Lima' });

export const horaLima = (iso: string) =>
  new Date(iso).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Lima' });
