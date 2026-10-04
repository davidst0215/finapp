// Forma del brief que devuelve la edge function `brief` (espejo de supabase/functions/brief/logic.ts).

export type Estado = 'ok' | 'no_conectado' | 'error';

export type AgendaItem = { hora: string; titulo: string; todo_dia: boolean };
export type TareaItem = { texto: string; due: string; dias: number };
export type PagoItem = { descripcion: string; monto: number; fecha: string; dias: number };
export type EsperaItem = { texto: string; con: string; dias: number | null };

export type Secciones = {
  fecha: string;
  titulo: string;
  agenda: { estado: Estado; mensaje: string | null; eventos: AgendaItem[]; primera: AgendaItem | null };
  tareas: { estado: Estado; mensaje: string | null; vencidas: TareaItem[]; vencidas_total: number; hoy: { texto: string }[]; hoy_total: number };
  dinero: {
    estado: Estado;
    mensaje: string | null;
    mes: string;
    dia_del_mes: number;
    dias_del_mes: number;
    gastado_mes: number | null;
    pagos: PagoItem[];
  };
  esperas: { estado: Estado; mensaje: string | null; items: EsperaItem[]; total: number };
};

export type Brief = {
  fecha: string; // AAAA-MM-DD de Lima
  texto: string;
  secciones: Secciones;
  creado: string; // ISO
  origen: 'cron' | 'manual';
  notificado?: boolean;
};
