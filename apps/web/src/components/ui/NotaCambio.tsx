import { cn } from '@/lib/utils';

/**
 * Línea tenue bajo un total en soles que incluye dólares: «Incluye US$ 500.00 ≈ S/ 1,725.00 (TC 3.45)».
 * El texto lo arma lib/fx.ts (notaConversion). Sin dólares no hay texto y no se pinta nada: silencio por defecto.
 * Texto 3 (slate-400): ≥ 4.5:1 en los dos temas. Sin rojo: que falte el tipo de cambio es un aviso, no una alarma del dinero.
 */
export function NotaCambio({ texto, className }: { texto: string | null; className?: string }) {
  if (!texto) return null;
  return <p className={cn('text-sm leading-snug text-slate-400', className)}>{texto}</p>;
}
