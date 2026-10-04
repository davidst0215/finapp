// Lógica pura de la pantalla de correo: textos de cada fila, contadores de las pestañas y enlaces a Gmail.
import type { DraftItem, MailItem } from '../google/types.ts';

export type TabId = 'importantes' | 'borradores' | 'resto';

export const senderName = (m: Pick<MailItem, 'from_name' | 'from_email'>): string => m.from_name || m.from_email;

/** "BCP — Cargo no reconocido" */
export const rowTitle = (m: Pick<MailItem, 'from_name' | 'from_email' | 'subject'>): string => `${senderName(m)} — ${m.subject}`;

/** Punto de la fila: alarma (rojo), sin leer (lleno) o leído (hueco). */
export const dotKind = (m: Pick<MailItem, 'alarm' | 'unread'>): 'alarm' | 'unread' | 'read' => (m.alarm ? 'alarm' : m.unread ? 'unread' : 'read');

export const DOT_LABEL = { alarm: 'Alerta', unread: 'Sin leer', read: 'Leído' } as const;

/** Contador de una pestaña: "3", o "10+" si la lista llegó a su límite y puede haber más. */
export const countLabel = (n: number, limit: number): string => (n >= limit ? `${n}+` : String(n));

export const MAIL_LIMIT = 15;
export const DRAFT_LIMIT = 10;

/** Enlace a Gmail en la cuenta conectada (authuser evita abrir otra cuenta del navegador). */
export const gmailThreadUrl = (email: string, threadId: string): string =>
  `https://mail.google.com/mail/?authuser=${encodeURIComponent(email)}#all/${encodeURIComponent(threadId)}`;

export const gmailDraftsUrl = (email: string): string => `https://mail.google.com/mail/?authuser=${encodeURIComponent(email)}#drafts`;

/** ¿Se puede enviar? Hace falta al menos un destinatario. */
export const canSend = (d: Pick<DraftItem, 'to_email'>): boolean => d.to_email.trim() !== '';

/** Quita un borrador de la lista por id. */
export const withoutDraft = (list: DraftItem[], id: string): DraftItem[] => list.filter((d) => d.draft_id !== id);

/** Reemplaza un borrador (misma posición) o lo agrega arriba si es nuevo. */
export function upsertDraft(list: DraftItem[], draft: DraftItem): DraftItem[] {
  return list.some((d) => d.draft_id === draft.draft_id) ? list.map((d) => (d.draft_id === draft.draft_id ? draft : d)) : [draft, ...list];
}
