// Forma de la respuesta de la edge function `saldo` (supabase/functions/_shared/saldo.ts).
export type Proyeccion = { tipo: 'dias'; dias: number } | { tipo: 'mas_de_12_meses' } | { tipo: 'agotado' };

export type SaldoOpenRouter =
  | { estado: 'ok'; restante: number; credito: number; usado: number; hoy: number; semana: number; mes: number; proyeccion: Proyeccion }
  | { estado: 'error'; mensaje: string };

export type SaldoVoz =
  | { estado: 'ok'; usados: number; limite: number; renueva: string | null; plan: string | null }
  | { estado: 'sin_permiso' | 'sin_configurar' | 'error'; mensaje: string };

export type Saldo = { openrouter: SaldoOpenRouter; elevenlabs: SaldoVoz; actualizado: string };
