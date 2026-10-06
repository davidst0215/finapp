// Forma de la respuesta de la edge function `saldo` (supabase/functions/_shared/saldo.ts).
export type Proyeccion = { tipo: 'dias'; dias: number } | { tipo: 'mas_de_12_meses' } | { tipo: 'agotado' } | { tipo: 'desconocida' };

export type SaldoOpenRouter =
  | {
    estado: 'ok';
    restante: number;
    credito: number;
    /** Gasto del día UTC (se reinicia a las 19:00 de Lima), de la semana y del mes; null si OpenRouter no lo dio. */
    hoy: number | null;
    semana: number | null;
    mes: number | null;
    proyeccion: Proyeccion;
    /** Frase de alcance ya redactada por el servidor. */
    alcance: string;
    /** Restante bajo el umbral: se marca como alerta. */
    bajo: boolean;
  }
  | { estado: 'error'; mensaje: string };

export type SaldoVoz =
  | { estado: 'ok'; usados: number; limite: number; renueva: string | null; plan: string | null }
  | { estado: 'sin_permiso' | 'sin_configurar' | 'error'; mensaje: string };

export type Saldo = { openrouter: SaldoOpenRouter; elevenlabs: SaldoVoz; actualizado: string };
