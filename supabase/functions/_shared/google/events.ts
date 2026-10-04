// Eventos de Google Calendar: forma compacta para la UI y el agente, validación de lo que se crea o
// se mueve, y detección de cruces. Lógica pura.
// Campos de la API verificados en https://developers.google.com/workspace/calendar/api/v3/reference/events
import { GoogleInputError } from "./errors.ts";
import { bestMatches } from "./text.ts";
import { addDays, addMinutes, isDateKey, limaDateKey, limaDateTime, limaHM, LIMA_TZ, parseTime } from "./time.ts";

export type RawEvent = {
  id?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
  eventType?: string;
  transparency?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  attendees?: { email?: string; displayName?: string; self?: boolean; resource?: boolean; responseStatus?: string }[];
  organizer?: { self?: boolean };
};

export type MyResponse = "accepted" | "declined" | "tentative" | "needsAction" | "";

export type CalEvent = {
  id: string;
  title: string;
  all_day: boolean;
  start: string; // ISO con desfase (con hora) o AAAA-MM-DD (todo el día)
  end: string;
  day_key: string; // día de Lima en que empieza
  end_day_key: string; // último día (incluido) que cubre; = day_key salvo eventos de todo el día de varios días
  start_hm: string; // "HH:MM" de Lima ("" si es de todo el día)
  end_hm: string;
  location: string;
  meet_url: string;
  guests: number; // otras personas invitadas (sin contarte a ti ni las salas)
  guest_names: string[];
  my_response: MyResponse;
  busy: boolean; // false si está marcado como "libre" (transparente): no bloquea tiempo
  kind: "default" | "outOfOffice" | "focusTime";
  link: string;
};

const HIDDEN_TYPES = new Set(["workingLocation", "birthday", "fromGmail"]);

export function mapEvent(raw: RawEvent): CalEvent | null {
  if (!raw.id || raw.status === "cancelled" || HIDDEN_TYPES.has(raw.eventType ?? "")) return null;
  const s = raw.start;
  const e = raw.end;
  if (!s || !e) return null;

  const attendees = raw.attendees ?? [];
  const others = attendees.filter((a) => !a.self && !a.resource);
  const me = attendees.find((a) => a.self);
  const response = me?.responseStatus;
  const my_response: MyResponse = response === "accepted" || response === "declined" || response === "tentative" || response === "needsAction"
    ? response
    : "";
  const meet = raw.hangoutLink ?? raw.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri ?? "";
  const kind: CalEvent["kind"] = raw.eventType === "outOfOffice" || raw.eventType === "focusTime" ? raw.eventType : "default";
  const base = {
    id: raw.id,
    title: (raw.summary ?? "").trim() || "(sin título)",
    location: (raw.location ?? "").trim(),
    meet_url: meet,
    guests: others.length,
    guest_names: others.slice(0, 4).map((a) => (a.displayName ?? a.email ?? "").trim()).filter(Boolean),
    my_response,
    busy: raw.transparency !== "transparent",
    kind,
    link: raw.htmlLink ?? "",
  };

  if (s.date) {
    // Todo el día: `end.date` es exclusivo (el último día cubierto es el anterior).
    const lastDay = e.date && e.date > s.date ? addDays(e.date, -1) : s.date;
    return { ...base, all_day: true, start: s.date, end: e.date ?? s.date, day_key: s.date, end_day_key: lastDay, start_hm: "", end_hm: "" };
  }
  if (!s.dateTime || !e.dateTime) return null;
  const start = new Date(s.dateTime);
  const end = new Date(e.dateTime);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const day = limaDateKey(start);
  return { ...base, all_day: false, start: s.dateTime, end: e.dateTime, day_key: day, end_day_key: day, start_hm: limaHM(start), end_hm: limaHM(end) };
}

export const compareEvents = (a: CalEvent, b: CalEvent) =>
  a.day_key.localeCompare(b.day_key) || Number(b.all_day) - Number(a.all_day) || a.start_hm.localeCompare(b.start_hm) || a.title.localeCompare(b.title);

// El evento con hora al que se refiere David ("la reunión de TDV"); varios si empatan.
export const matchEvents = (events: CalEvent[], query: string): CalEvent[] =>
  bestMatches(events.filter((e) => !e.all_day && e.my_response !== "declined"), query, (e) => e.title);

// Eventos activos que se cruzan con [startMs, endMs). Los declinados y los "libre" no cuentan.
export function findOverlaps(events: CalEvent[], startMs: number, endMs: number): CalEvent[] {
  return events.filter((ev) => {
    if (ev.all_day || !ev.busy || ev.my_response === "declined") return false;
    const s = Date.parse(ev.start);
    const e = Date.parse(ev.end);
    return Number.isFinite(s) && Number.isFinite(e) && s < endMs && e > startMs;
  });
}

// ---------------------------------------------------------------- validar lo que se crea o mueve

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g; // deja \t y \n
const oneLine = (s: unknown, max: number) =>
  typeof s === "string" ? s.replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type NewEvent = {
  title: string;
  date: string;
  start_hm: string;
  end_date: string; // puede ser el día siguiente si cruza la medianoche
  end_hm: string;
  start: string; // RFC 3339 con desfase de Lima
  end: string;
  location: string;
  description: string;
  event_id?: string; // id idempotente derivado del request_id
};

export const MAX_DURATION_MIN = 24 * 60;

export function normalizeNewEvent(input: Record<string, unknown>): NewEvent {
  const title = oneLine(input.title, 200);
  if (!title) throw new GoogleInputError("Falta el título del evento.");
  const date = input.date;
  if (!isDateKey(date)) throw new GoogleInputError("La fecha del evento no es válida.");
  const start_hm = parseTime(input.start_time);
  if (!start_hm) throw new GoogleInputError("La hora de inicio no es válida.");

  let end_hm: string;
  let end_date = date;
  if (input.end_time !== undefined && input.end_time !== null && input.end_time !== "") {
    const parsed = parseTime(input.end_time);
    if (!parsed) throw new GoogleInputError("La hora de fin no es válida.");
    if (parsed <= start_hm) throw new GoogleInputError("La hora de fin debe ser después del inicio.");
    end_hm = parsed;
  } else {
    const minutes = input.duration_min === undefined || input.duration_min === null ? 60 : Number(input.duration_min);
    if (!Number.isFinite(minutes) || minutes < 5 || minutes > MAX_DURATION_MIN) {
      throw new GoogleInputError("La duración debe estar entre 5 minutos y 24 horas.");
    }
    const end = addMinutes(date, start_hm, Math.round(minutes));
    end_date = end.dateKey;
    end_hm = end.hm;
  }

  const rid = typeof input.request_id === "string" && UUID.test(input.request_id) ? input.request_id : undefined;
  return {
    title,
    date,
    start_hm,
    end_date,
    end_hm,
    start: limaDateTime(date, start_hm),
    end: limaDateTime(end_date, end_hm),
    location: oneLine(input.location, 200),
    description: typeof input.description === "string" ? input.description.replace(CONTROL, " ").trim().slice(0, 2000) : "",
    // Calendar acepta ids propios de 5 a 1024 caracteres en base32hex (0-9, a-v): un UUID sin guiones sirve.
    event_id: rid ? rid.replace(/-/g, "").toLowerCase() : undefined,
  };
}

export type MoveEvent = { event_id: string; date: string; start_hm: string; end_hm?: string; confirm_guests: boolean };

const ID = /^[A-Za-z0-9_-]{1,1024}$/;
export const isGoogleId = (v: unknown): v is string => typeof v === "string" && ID.test(v);

export function normalizeMove(input: Record<string, unknown>): MoveEvent {
  if (!isGoogleId(input.event_id)) throw new GoogleInputError("Falta el evento a mover.");
  if (!isDateKey(input.date)) throw new GoogleInputError("La nueva fecha no es válida.");
  const start_hm = parseTime(input.start_time);
  if (!start_hm) throw new GoogleInputError("La nueva hora no es válida.");
  let end_hm: string | undefined;
  if (input.end_time !== undefined && input.end_time !== null && input.end_time !== "") {
    end_hm = parseTime(input.end_time) ?? undefined;
    if (!end_hm) throw new GoogleInputError("La hora de fin no es válida.");
    if (end_hm <= start_hm) throw new GoogleInputError("La hora de fin debe ser después del inicio.");
  }
  return { event_id: input.event_id, date: input.date, start_hm, end_hm, confirm_guests: input.confirm_guests === true };
}

// Cuerpo de PATCH para mover un evento con hora: conserva la duración salvo que se pida otra hora de fin.
export function moveBody(current: CalEvent, mv: MoveEvent): { start: { dateTime: string; timeZone: string }; end: { dateTime: string; timeZone: string }; endLabel: string } {
  if (current.all_day) throw new GoogleInputError("Los eventos de todo el día se mueven desde Google Calendar.");
  const durationMin = Math.max(5, Math.round((Date.parse(current.end) - Date.parse(current.start)) / 60_000));
  const end = mv.end_hm ? { dateKey: mv.date, hm: mv.end_hm } : addMinutes(mv.date, mv.start_hm, durationMin);
  return {
    start: { dateTime: limaDateTime(mv.date, mv.start_hm), timeZone: LIMA_TZ },
    end: { dateTime: limaDateTime(end.dateKey, end.hm), timeZone: LIMA_TZ },
    endLabel: end.hm,
  };
}

// Id de envío determinista (SHA-256 de lo pedido, con forma de UUID): si el agente repite el mismo pedido,
// Calendar recibe el mismo id y devuelve el evento ya creado en vez de duplicarlo.
export async function deterministicRequestId(...parts: (string | number)[]): Promise<string> {
  const data = new TextEncoder().encode(parts.join(""));
  const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
