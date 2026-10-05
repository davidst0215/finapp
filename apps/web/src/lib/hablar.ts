// "Escuchar" una respuesta de Claude con la voz de Wabid (función `tts`), solo a pedido.
// Una sola a la vez; un toque mientras suena la detiene. Si la voz de Wabid no llega a sonar,
// lee la del navegador (con tope de tiempo, como en AddTransaction).
import { useSyncExternalStore } from 'react';
import { supabase, functionUrl } from '@/lib/supabase';
import { reproducirStream, type Reproduccion } from '@/lib/audioStream';
import { recortarParaVoz } from '@/lib/vozTexto';

export interface EstadoVoz {
  /** Id de la burbuja que se está leyendo; null si nada suena. */
  id: string | null;
  fase: 'cargando' | 'sonando' | null;
  /** Se leyó solo el inicio (el texto pasaba de 600 caracteres). */
  recortado: boolean;
}

const REPOSO: EstadoVoz = { id: null, fase: null, recortado: false };
let estado: EstadoVoz = REPOSO;
const oyentes = new Set<() => void>();
let turno = 0;
let abort: AbortController | null = null;
let reproduccion: Reproduccion | null = null;

function poner(e: EstadoVoz) {
  estado = e;
  oyentes.forEach((f) => f());
}

export function useEstadoVoz(): EstadoVoz {
  return useSyncExternalStore((f) => { oyentes.add(f); return () => { oyentes.delete(f); }; }, () => estado);
}

export function detenerVoz() {
  turno++;
  abort?.abort();
  abort = null;
  reproduccion?.detener();
  reproduccion = null;
  if (typeof window !== 'undefined') window.speechSynthesis?.cancel();
  if (estado.id !== null) poner(REPOSO);
}

/** Toque en "Escuchar": detiene si ya suena esa burbuja; si no, lee esta (y corta cualquier otra). */
export function alternarVoz(id: string, texto: string) {
  if (estado.id === id) { detenerVoz(); return; }
  detenerVoz();
  const { texto: aLeer, recortado } = recortarParaVoz(texto);
  if (!aLeer) return;
  const mio = turno;
  const vigente = () => turno === mio;
  poner({ id, fase: 'cargando', recortado });
  void leer(aLeer, vigente).finally(() => { if (vigente()) poner(REPOSO); });
}

async function leer(texto: string, vigente: () => boolean): Promise<void> {
  const ac = new AbortController();
  abort = ac;
  let sono = false;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Sin sesión');
    const res = await fetch(functionUrl('tts'), {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ text: texto }),
    });
    if (!res.ok) throw new Error('TTS failed');
    if (!vigente()) return;
    const audio = new Audio();
    audio.addEventListener('playing', () => { if (vigente()) poner({ ...estado, fase: 'sonando' }); }, { once: true });
    reproduccion = reproducirStream(res, audio);
    sono = await reproduccion.fin;
  } catch {
    // Interrumpida o sin red: se decide abajo.
  } finally {
    if (abort === ac) abort = null;
  }

  if (sono || !vigente() || !('speechSynthesis' in window)) return;
  poner({ ...estado, fase: 'sonando' });
  await new Promise<void>((ok) => {
    // Algunos navegadores nunca disparan onend/onerror: el tope evita un "sonando" eterno.
    const tope = setTimeout(ok, texto.length * 90 + 3000);
    const listo = () => { clearTimeout(tope); ok(); };
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(texto);
    u.lang = 'es-PE';
    u.onend = listo;
    u.onerror = listo;
    window.speechSynthesis.speak(u);
  });
}
