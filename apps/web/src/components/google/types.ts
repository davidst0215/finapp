// Formas que devuelve la edge function `google` (espejo de supabase/functions/_shared/google/*).

export type Capabilities = { calendar: boolean; gmail_read: boolean; gmail_compose: boolean };

export type GoogleStatus = {
  configured: boolean;
  connected: boolean;
  reauth: boolean; // Google cerró la conexión: hay que volver a conectarla
  account: { email: string; capabilities: Capabilities; connected_at: string; access_expires_at: string | null } | null;
};

export type CalEvent = {
  id: string;
  title: string;
  all_day: boolean;
  start: string;
  end: string;
  day_key: string; // día de Lima en que empieza (AAAA-MM-DD)
  end_day_key: string; // último día que cubre (incluido)
  start_hm: string; // "HH:MM" de Lima; vacío si es de todo el día
  end_hm: string;
  location: string;
  meet_url: string;
  guests: number;
  guest_names: string[];
  my_response: 'accepted' | 'declined' | 'tentative' | 'needsAction' | '';
  busy: boolean;
  kind: 'default' | 'outOfOffice' | 'focusTime';
  link: string;
};

export type MailItem = {
  id: string;
  thread_id: string;
  from_name: string;
  from_email: string;
  subject: string;
  snippet: string;
  received_at: string; // ISO
  unread: boolean;
  important: boolean;
  alarm: boolean;
};

export type DraftItem = {
  draft_id: string;
  message_id: string; // cambia en cada edición; se devuelve al enviar para confirmar "este es el que viste"
  thread_id: string;
  to: string;
  to_email: string;
  subject: string;
  body: string;
  snippet: string;
  updated_at: string;
  editable: boolean;
};
