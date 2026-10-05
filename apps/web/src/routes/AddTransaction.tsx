import { useEffect, useState, useRef, useCallback } from 'react';
import { ArrowUp, Camera, Mic } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useAppStore } from '@/stores/appStore';
import { useAuthStore } from '@/stores/authStore';
import { supabase, functionUrl, calentarFunciones } from '@/lib/supabase';
import { reproducirStream, type Reproduccion } from '@/lib/audioStream';
import { separarRespuesta } from '@/lib/respuestaAgente';
import { cn } from '@/lib/utils';

type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking';

interface ConversationEntry {
  role: 'user' | 'assistant';
  content: string;
}

export function AddTransactionPage() {
  const navigate = useNavigate();
  const profile = useAuthStore(s => s.profile);
  const { fetchAccounts, fetchCategories } = useAppStore();

  const [orbState, setOrbState] = useState<OrbState>('idle');
  const [subtitle, setSubtitle] = useState('');
  const [showInput, setShowInput] = useState(false);
  const [input, setInput] = useState('');

  // Conversation memory (last 5 exchanges)
  const conversationRef = useRef<ConversationEntry[]>([]);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const reproduccionRef = useRef<Reproduccion | null>(null);
  const vozAbortRef = useRef<AbortController | null>(null);
  // Cada pedido es un turno. Lo que llega de un turno viejo (respuesta tardía, voz interrumpida)
  // no toca el estado: si no, un turno anterior deja el orb en reposo en medio del siguiente.
  const turnoRef = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isHoldingRef = useRef(false);
  const transcriptRef = useRef('');

  useEffect(() => {
    fetchAccounts();
    fetchCategories();
  }, [fetchAccounts, fetchCategories]);

  // Al abrir la pantalla o el teclado, despierta agente y voz para que el primer pedido no pague el arranque.
  useEffect(() => { calentarFunciones('agent', 'tts'); }, [showInput]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  }, [input]);

  const firstName = profile?.display_name?.split(' ')[0] ?? '';
  const [isFirstUse, setIsFirstUse] = useState(() => !localStorage.getItem('finapp_used'));

  useEffect(() => {
    if (isFirstUse) {
      const timer = setTimeout(() => {
        localStorage.setItem('finapp_used', '1');
        setIsFirstUse(false);
      }, 15000); // After 15s, hide the onboarding
      return () => clearTimeout(timer);
    }
  }, [isFirstUse]);

  // Corta la voz en curso: la descarga de /tts, el audio y la voz de respaldo del navegador.
  const cortarVoz = useCallback(() => {
    vozAbortRef.current?.abort();
    vozAbortRef.current = null;
    reproduccionRef.current?.detener();
    reproduccionRef.current = null;
    window.speechSynthesis?.cancel();
  }, []);

  // ── Voz (ElevenLabs, suena mientras llega) ──
  const speak = useCallback(async (text: string, vigente: () => boolean): Promise<void> => {
    setOrbState('speaking');
    const abort = new AbortController();
    vozAbortRef.current = abort;
    let sono = false;

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Sin sesión');

      const response = await fetch(functionUrl('tts'), {
        method: 'POST',
        signal: abort.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
          'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ text: text.slice(0, 400) }),
      });
      if (!response.ok) throw new Error('TTS failed');
      if (!vigente()) return;

      const reproduccion = reproducirStream(response, new Audio());
      reproduccionRef.current = reproduccion;
      sono = await reproduccion.fin;
    } catch {
      // Interrumpida o sin red: se decide abajo.
    } finally {
      if (vozAbortRef.current === abort) vozAbortRef.current = null;
    }

    // Si la voz de Wabid no llegó a sonar, la del navegador lee el mismo texto.
    if (sono || !vigente() || !('speechSynthesis' in window)) return;
    await new Promise<void>((ok) => {
      // Algunos navegadores nunca disparan onend/onerror: el tope evita un orb "hablando" para siempre.
      const tope = setTimeout(ok, text.length * 90 + 3000);
      const listo = () => { clearTimeout(tope); ok(); };
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'es-PE';
      u.onend = listo;
      u.onerror = listo;
      window.speechSynthesis.speak(u);
    });
  }, []);

  // La voz que vino con la respuesta del agente. El texto aparece cuando empieza a oírse, no antes: así no
  // queda un silencio entre leer y escuchar. Si no trajo voz o no llegó a sonar, se pide a /tts (o al navegador).
  const hablar = useCallback(async (message: string, audio: ReadableStream<Uint8Array> | null, vigente: () => boolean) => {
    if (audio) {
      const reproduccion = reproducirStream(new Response(audio), new Audio(), () => {
        if (!vigente()) return;
        setSubtitle(message);
        setOrbState('speaking');
      });
      reproduccionRef.current = reproduccion;
      const sono = await reproduccion.fin;
      if (sono || !vigente()) return;
    }
    setSubtitle(message);
    await speak(message, vigente);
  }, [speak]);

  // ── Agente con memoria de la conversación: texto y voz llegan en una sola respuesta ──
  const callAgent = useCallback(async (text: string) => {
    const turno = ++turnoRef.current;
    const vigente = () => turnoRef.current === turno;
    cortarVoz();
    setOrbState('thinking');
    setSubtitle('');
    navigator.vibrate?.(12); // señal breve: el pedido salió

    // Add to memory
    conversationRef.current.push({ role: 'user', content: text });
    if (conversationRef.current.length > 10) conversationRef.current = conversationRef.current.slice(-10);

    // Interrumpir (o el tiempo límite) corta el pedido y la voz que viene con él.
    const abort = new AbortController();
    vozAbortRef.current = abort;
    const timeout = setTimeout(() => {
      if (!vigente()) return;
      turnoRef.current++; // la respuesta que llegue tarde ya no habla
      abort.abort();
      setOrbState('idle');
      setSubtitle('No pude procesar, intenta de nuevo');
      setTimeout(() => setSubtitle(''), 4000);
    }, 15000);

    try {
      let session = (await supabase.auth.getSession()).data.session;
      if (!session) {
        await new Promise(r => setTimeout(r, 1000));
        session = (await supabase.auth.getSession()).data.session;
      }
      if (!session) throw new Error('No autenticado');

      const response = await fetch(functionUrl('agent'), {
        method: 'POST',
        signal: abort.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
          'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ text, history: conversationRef.current.slice(-8), voz: true }),
      });
      if (!response.body) throw new Error('El servidor no respondió');
      const { resultado, audio } = await separarRespuesta(response.body);

      clearTimeout(timeout);
      if (!vigente()) { // David ya empezó otro turno o se venció el tiempo
        void audio?.cancel();
        return;
      }
      if (!response.ok || resultado.error) {
        void audio?.cancel();
        throw new Error(typeof resultado.error === 'string' ? resultado.error : 'Algo falló. Intenta de nuevo.');
      }

      const message = String(resultado.message ?? '');

      // Add to memory
      conversationRef.current.push({ role: 'assistant', content: message });
      if (conversationRef.current.length > 10) conversationRef.current = conversationRef.current.slice(-10);

      await hablar(message, audio, vigente);
      if (!vigente()) return;

      // Apenas termina la voz se puede volver a hablar; el subtítulo queda un momento para leerlo.
      setOrbState('idle');
      setTimeout(() => setSubtitle(s => (s === message ? '' : s)), 2500);

    } catch (err) {
      clearTimeout(timeout);
      if (!vigente()) return;
      const errMsg = err instanceof Error ? err.message : 'Error';
      setSubtitle(errMsg);
      setOrbState('idle');
      setTimeout(() => setSubtitle(''), 4000);
    } finally {
      if (vozAbortRef.current === abort) vozAbortRef.current = null;
    }
  }, [cortarVoz, hablar]);

  // ── Hold-to-talk ──
  const startHold = useCallback(() => {
    if (orbState === 'speaking') {
      // Interrumpir: termina el turno y corta la voz, aunque la descarga de /tts siga en curso.
      turnoRef.current++;
      cortarVoz();
      setOrbState('idle');
      setSubtitle('');
      return;
    }
    if (orbState !== 'idle') return;
    calentarFunciones('agent', 'tts');

    isHoldingRef.current = true;
    transcriptRef.current = '';
    setSubtitle('');

    if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
      setSubtitle('Navegador sin soporte de voz');
      setTimeout(() => setSubtitle(''), 3000);
      return;
    }

    const API = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new API();
    recognition.lang = 'es-PE';
    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.onstart = () => setOrbState('listening');

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      // Only use the last result to avoid mobile duplicates
      const last = event.results[event.results.length - 1];
      const text = last?.[0]?.transcript ?? '';
      transcriptRef.current = text;
      setSubtitle(text);
    };

    recognition.onerror = () => {
      isHoldingRef.current = false;
      setOrbState('idle');
      setSubtitle('No te escuché, intenta de nuevo');
      setTimeout(() => setSubtitle(''), 3000);
    };

    recognition.onend = () => {
      // When released and recognition ends, process
      if (transcriptRef.current.trim()) {
        callAgent(transcriptRef.current.trim());
      } else {
        setOrbState('idle');
      }
    };

    recognitionRef.current = recognition;
    recognition.start();
  }, [orbState, callAgent, cortarVoz]);

  const endHold = useCallback(() => {
    isHoldingRef.current = false;
    recognitionRef.current?.stop();
  }, []);

  // ── Text submit ──
  const handleSubmitText = () => {
    if (!input.trim()) return;
    const text = input.trim();
    setInput('');
    setShowInput(false);
    callAgent(text);
  };

  // ── Orb CSS state ──
  const orbClass = cn(
    'ai-orb w-[130px] h-[130px] cursor-pointer transition-all duration-300',
    orbState === 'listening' && 'listening',
    orbState === 'thinking' && 'processing',
    orbState === 'speaking' && 'speaking',
  );

  return (
    <div className="flex flex-col items-center min-h-[calc(100dvh-9rem)] relative">

      {/* ── Orb ── */}
      <div className="flex-1 flex flex-col items-center justify-center w-full">
        <motion.div
          className="relative mb-6 select-none touch-none"
          whileTap={{ scale: 0.92 }}
        >
          {/* Glow */}
          <motion.div
            className="absolute inset-0 rounded-full blur-3xl pointer-events-none"
            style={{ background: 'radial-gradient(circle, rgb(var(--halo) / 0.18) 0%, transparent 70%)' }}
            animate={{
              scale: orbState === 'listening' ? [1, 1.5, 1] :
                     orbState === 'speaking' ? [1, 1.3, 1] : [1, 1.1, 1],
              opacity: orbState === 'listening' ? [0.5, 0.9, 0.5] :
                       orbState === 'speaking' ? [0.4, 0.7, 0.4] : 0.3,
            }}
            transition={{ duration: orbState === 'listening' ? 1 : 2, repeat: Infinity, ease: 'easeInOut' }}
          />

          {/* Orb — hold to talk */}
          <div
            className={orbClass}
            onPointerDown={startHold}
            onPointerUp={endHold}
            onPointerLeave={endHold}
            onContextMenu={e => e.preventDefault()}
          />

          {/* Center icon */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <AnimatePresence mode="wait">
              {orbState === 'thinking' ? (
                <motion.div key="think" initial={{ opacity: 0 }} animate={{ opacity: 0.6 }} exit={{ opacity: 0 }}>
                  <div className="w-6 h-6 border-2 border-slate-950/30 border-t-slate-950/80 rounded-full animate-spin" />
                </motion.div>
              ) : orbState === 'listening' ? (
                <motion.div key="listen" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 0.8, scale: [1, 1.15, 1] }} exit={{ opacity: 0 }}
                  transition={{ scale: { duration: 1, repeat: Infinity } }}>
                  <Mic className="w-8 h-8 text-slate-950" />
                </motion.div>
              ) : orbState === 'speaking' ? (
                <motion.div key="speak" initial={{ opacity: 0 }} animate={{ opacity: [0.5, 0.9, 0.5] }} exit={{ opacity: 0 }}
                  transition={{ duration: 1.5, repeat: Infinity }}>
                  <div className="flex items-center gap-[3px]">
                    {[0, 1, 2, 3, 4].map(i => (
                      <motion.div key={i} className="w-[3px] rounded-full bg-slate-950/70"
                        animate={{ height: [8, 20, 8] }}
                        transition={{ duration: 0.8, repeat: Infinity, delay: i * 0.12 }}
                      />
                    ))}
                  </div>
                </motion.div>
              ) : (
                <motion.div key="idle" initial={{ opacity: 0 }} animate={{ opacity: 0.5 }} exit={{ opacity: 0 }}>
                  <Mic className="w-7 h-7 text-slate-950" />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>

        {/* Subtitle */}
        <AnimatePresence mode="wait">
          {subtitle ? (
            <motion.p
              key="sub"
              className={cn(
                'text-center max-w-[300px] px-4 leading-relaxed',
                orbState === 'listening' ? 'text-slate-400 text-sm italic' : 'text-slate-300 text-sm',
              )}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
            >
              {orbState === 'listening' ? `"${subtitle}"` : subtitle}
            </motion.p>
          ) : orbState === 'idle' && !showInput ? (
            <motion.p
              key="hint"
              className="text-slate-500 text-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              {isFirstUse
                ? `¡Hola${firstName ? ` ${firstName}` : ''}! Mantén presionado el orb y dime qué gastaste. También puedes escribir abajo.`
                : firstName ? `Mantén presionado para hablar, ${firstName}` : 'Mantén presionado para hablar'
              }
            </motion.p>
          ) : orbState === 'thinking' ? (
            <motion.p
              key="thinking"
              className="text-slate-500 text-sm animate-pulse"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              Pensando...
            </motion.p>
          ) : null}
        </AnimatePresence>
      </div>

      {/* ── Input bar ── */}
      <div className="w-full pb-2">
        <div className="relative">

          <motion.div
            className={cn(
              'rounded-2xl border bg-slate-900 overflow-hidden relative',
              orbState === 'idle' ? 'border-slate-600' : 'border-slate-700',
            )}
            animate={{ height: showInput ? 'auto' : 48 }}
            transition={{ type: 'spring', stiffness: 500, damping: 40 }}
          >
            {!showInput && orbState === 'idle' && (
              <div className="h-[48px] flex items-center px-4">
                <button
                  onClick={() => { setShowInput(true); setTimeout(() => textareaRef.current?.focus(), 100); }}
                  className="flex-1 text-left text-sm text-slate-500"
                >
                  Escribe tu gasto o ingreso...
                </button>
                <button
                  type="button"
                  onClick={() => navigate('/recibo')}
                  aria-label="Leer una boleta con la cámara"
                  className="group -mr-3.5 flex h-11 w-11 flex-shrink-0 items-center justify-center"
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-800 text-slate-200 transition-colors group-active:bg-slate-700">
                    <Camera size={18} strokeWidth={1.8} aria-hidden="true" />
                  </span>
                </button>
              </div>
            )}

            {showInput && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-3">
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmitText(); }
                    if (e.key === 'Escape') setShowInput(false);
                  }}
                  placeholder='"gasté 50 en almuerzo", "presupuesto 500 comida"...'
                  className="w-full bg-transparent border-none text-slate-100 text-sm placeholder-slate-400 focus:outline-none resize-none min-h-[40px] max-h-[120px] px-1 py-1"
                  rows={1}
                />
                <div className="flex items-center justify-between pt-1">
                  <button onClick={() => setShowInput(false)} className="text-xs text-slate-500 px-2 py-1">Cancelar</button>
                  <motion.button
                    whileTap={{ scale: 0.9 }}
                    onClick={handleSubmitText}
                    disabled={!input.trim()}
                    className={cn(
                      'w-8 h-8 rounded-full flex items-center justify-center transition-all',
                      input.trim() ? 'bg-primary-600 text-slate-950' : 'bg-slate-800 text-slate-500',
                    )}
                  >
                    <ArrowUp size={16} />
                  </motion.button>
                </div>
              </motion.div>
            )}
          </motion.div>
        </div>
      </div>
    </div>
  );
}
