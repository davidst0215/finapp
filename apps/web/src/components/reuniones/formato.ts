// Formato de reuniones para la pantalla. Todo en hora de Lima (David vive allí aunque el teléfono diga otra cosa).
const TZ = 'America/Lima';

export function fechaReunion(iso: string): string {
  const d = new Date(iso);
  const dia = new Intl.DateTimeFormat('es-PE', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' }).format(d);
  const hora = new Intl.DateTimeFormat('es-PE', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
  return `${dia.replace(/\./g, '')} · ${hora.replace(/ | /g, ' ')}`;
}

export function duracion(min: number | null): string | null {
  if (min === null || min <= 0) return null;
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function diasTexto(dias: number | null): string {
  if (dias === null) return 'sin fecha';
  if (dias === 0) return 'hoy';
  return dias === 1 ? '1 día' : `${dias} días`;
}

export interface Bloque { tipo: 'titulo' | 'punto' | 'texto'; texto: string }

/** Markdown de Fathom → bloques simples. Se muestra como texto (nunca como HTML): el contenido es dato. */
export function bloquesResumen(md: string): Bloque[] {
  const limpio = (s: string) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').trim();
  const out: Bloque[] = [];
  for (const linea of md.split(/\r?\n/)) {
    if (!linea.trim()) continue;
    const t = /^\s*#{1,6}\s+(.*)$/.exec(linea);
    if (t) { out.push({ tipo: 'titulo', texto: limpio(t[1] ?? '') }); continue; }
    const p = /^\s*[-*•]\s+(.*)$/.exec(linea);
    const texto = limpio(p ? (p[1] ?? '') : linea);
    if (texto) out.push({ tipo: p ? 'punto' : 'texto', texto });
  }
  return out;
}

export const enlaceSeguro = (u: string | null): string | null => (u && u.startsWith('https://') ? u : null);
