import { Mic, MicOff, Sparkles, Loader2, Check, X } from 'lucide-react';
import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';

type VoiceState = 'idle' | 'listening' | 'processing' | 'success' | 'error';

interface ParsedResult {
  amount: number;
  transaction_type: 'income' | 'expense';
  description: string;
  category_name: string | null;
  category_id: string | null;
  currency_code: string;
  confidence: number;
}

interface VoiceRecorderProps {
  onResult: (result: ParsedResult, rawText: string) => void;
  onCancel: () => void;
  className?: string;
}

export function VoiceRecorder({ onResult, onCancel, className }: VoiceRecorderProps) {
  const [state, setState] = useState<VoiceState>('idle');
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState('');
  const [waveformData, setWaveformData] = useState<number[]>(Array(24).fill(0));
  const [parsedResult, setParsedResult] = useState<ParsedResult | null>(null);
  const waveIntervalRef = useRef<ReturnType<typeof setInterval>>();
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  const stopWaveform = useCallback(() => {
    if (waveIntervalRef.current) {
      clearInterval(waveIntervalRef.current);
      waveIntervalRef.current = undefined;
    }
    setWaveformData(Array(24).fill(0));
  }, []);

  const startWaveform = useCallback(() => {
    waveIntervalRef.current = setInterval(() => {
      setWaveformData(Array(24).fill(0).map(() => Math.random() * 100));
    }, 80);
  }, []);

  const parseWithAI = useCallback(async (text: string) => {
    setState('processing');
    stopWaveform();

    try {
      const { supabase } = await import('@/lib/supabase');
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('No autenticado');

      const response = await supabase.functions.invoke('parse-voice', {
        body: { text },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (response.error) throw new Error(response.error.message);
      const data = response.data;

      if (data.error) {
        setError(data.error);
        setState('error');
        return;
      }

      setParsedResult(data as ParsedResult);
      setState('success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al procesar');
      setState('error');
    }
  }, [stopWaveform]);

  const startListening = useCallback(() => {
    if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
      setError('Tu navegador no soporta reconocimiento de voz. Usa Chrome.');
      setState('error');
      return;
    }

    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognitionAPI();
    recognition.lang = 'es-PE';
    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.onstart = () => {
      setState('listening');
      startWaveform();
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const result = event.results[event.results.length - 1];
      if (result?.[0]) {
        setTranscript(result[0].transcript);
        if (result.isFinal) {
          parseWithAI(result[0].transcript);
        }
      }
    };

    recognition.onerror = () => {
      stopWaveform();
      setError('No se pudo escuchar. Intenta de nuevo.');
      setState('error');
    };

    recognition.onend = () => {
      // onresult with isFinal handles parsing; just clean up if nothing happened
      stopWaveform();
    };

    recognitionRef.current = recognition;
    recognition.start();
  }, [startWaveform, stopWaveform, parseWithAI]);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  const handleConfirm = useCallback(() => {
    if (parsedResult) {
      onResult(parsedResult, transcript);
    }
  }, [parsedResult, transcript, onResult]);

  const handleRetry = useCallback(() => {
    setTranscript('');
    setError('');
    setParsedResult(null);
    setState('idle');
  }, []);

  // Auto-start on mount
  useEffect(() => {
    const timer = setTimeout(startListening, 400);
    return () => {
      clearTimeout(timer);
      stopWaveform();
      recognitionRef.current?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const getStatusText = () => {
    switch (state) {
      case 'idle': return 'Toca para hablar';
      case 'listening': return 'Escuchando...';
      case 'processing': return 'Procesando con IA...';
      case 'success': return '¡Listo!';
      case 'error': return 'Error';
    }
  };

  const getStateColor = () => {
    switch (state) {
      case 'listening': return 'text-primary-400';
      case 'processing': return 'text-slate-200';
      case 'success': return 'text-income';
      case 'error': return 'text-expense';
      default: return 'text-slate-400';
    }
  };

  const getButtonBorder = () => {
    switch (state) {
      case 'listening': return 'border-primary-500 shadow-lg shadow-primary-500/25';
      case 'processing': return 'border-slate-300';
      case 'success': return 'border-income shadow-lg shadow-income/25';
      case 'error': return 'border-expense shadow-lg shadow-expense/25';
      default: return 'border-slate-700 active:border-primary-500/50';
    }
  };

  return (
    <div className={cn('flex flex-col items-center justify-center relative overflow-hidden', className)}>
      {/* Glow de fondo */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <motion.div
          className="w-80 h-80 rounded-full bg-gradient-to-r from-primary-500/10 via-transfer/10 to-expense/10 blur-3xl"
          animate={{
            scale: state === 'listening' ? [1, 1.3, 1] : [1, 1.1, 1],
            opacity: state === 'listening' ? [0.3, 0.6, 0.3] : [0.1, 0.2, 0.1],
          }}
          transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
        />
      </div>

      <div className="relative z-10 flex flex-col items-center space-y-6">
        {/* Botón principal */}
        <motion.div className="relative" whileTap={{ scale: 0.95 }}>
          <motion.button
            onClick={state === 'idle' || state === 'error' ? startListening : state === 'listening' ? stopListening : undefined}
            className={cn(
              'relative w-28 h-28 rounded-full flex items-center justify-center transition-all duration-300',
              'bg-gradient-to-br from-slate-800 to-slate-900 border-2',
              getButtonBorder(),
            )}
            animate={state === 'listening' ? {
              boxShadow: ['0 0 0 0 rgb(var(--halo) / 0.35)', '0 0 0 20px rgb(var(--halo) / 0)'],
            } : undefined}
            transition={{ duration: 1.5, repeat: state === 'listening' ? Infinity : 0 }}
          >
            <AnimatePresence mode="wait">
              {state === 'processing' ? (
                <motion.div key="proc" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }}>
                  <Loader2 className="w-10 h-10 text-slate-200 animate-spin" />
                </motion.div>
              ) : state === 'success' ? (
                <motion.div key="ok" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }}>
                  <Check className="w-10 h-10 text-income" />
                </motion.div>
              ) : state === 'error' ? (
                <motion.div key="err" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }}>
                  <X className="w-10 h-10 text-expense" />
                </motion.div>
              ) : state === 'listening' ? (
                <motion.div key="listen" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }}>
                  <MicOff className="w-10 h-10 text-primary-400" />
                </motion.div>
              ) : (
                <motion.div key="idle" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }}>
                  <Mic className="w-10 h-10 text-slate-400" />
                </motion.div>
              )}
            </AnimatePresence>
          </motion.button>

          {/* Pulse rings */}
          <AnimatePresence>
            {state === 'listening' && (
              <>
                <motion.div
                  className="absolute inset-0 rounded-full border-2 border-primary-500/30"
                  initial={{ scale: 1, opacity: 0.6 }}
                  animate={{ scale: 1.6, opacity: 0 }}
                  transition={{ duration: 1.5, repeat: Infinity, ease: 'easeOut' }}
                />
                <motion.div
                  className="absolute inset-0 rounded-full border-2 border-primary-500/20"
                  initial={{ scale: 1, opacity: 0.4 }}
                  animate={{ scale: 2.2, opacity: 0 }}
                  transition={{ duration: 1.5, repeat: Infinity, ease: 'easeOut', delay: 0.5 }}
                />
              </>
            )}
          </AnimatePresence>
        </motion.div>

        {/* Waveform */}
        <div className="flex items-center justify-center gap-[3px] h-12">
          {waveformData.map((height, i) => (
            <motion.div
              key={i}
              className={cn(
                'w-[3px] rounded-full transition-colors duration-300',
                state === 'listening' ? 'bg-primary-500' :
                state === 'processing' ? 'bg-slate-300' :
                state === 'success' ? 'bg-income' : 'bg-slate-700',
              )}
              animate={{
                height: `${Math.max(4, height * 0.45)}px`,
                opacity: state === 'listening' ? 1 : 0.3,
              }}
              transition={{ duration: 0.08, ease: 'easeOut' }}
            />
          ))}
        </div>

        {/* Estado */}
        <div className="text-center space-y-1.5">
          <motion.p
            className={cn('text-base font-medium transition-colors', getStateColor())}
            animate={{ opacity: state === 'listening' || state === 'processing' ? [1, 0.6, 1] : 1 }}
            transition={{ duration: 2, repeat: state === 'listening' || state === 'processing' ? Infinity : 0 }}
          >
            {getStatusText()}
          </motion.p>

          {transcript && (
            <motion.p
              className="text-sm text-slate-500 italic max-w-[280px]"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
            >
              "{transcript}"
            </motion.p>
          )}

          {error && (
            <motion.p
              className="text-xs text-expense max-w-[280px]"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
            >
              {error}
            </motion.p>
          )}
        </div>

        {/* Resultado parseado */}
        <AnimatePresence>
          {state === 'success' && parsedResult && (
            <motion.div
              className="card w-full max-w-[320px] space-y-3"
              initial={{ opacity: 0, y: 20, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ type: 'spring', stiffness: 300, damping: 25 }}
            >
              <div className="flex items-center justify-between">
                <span className={cn(
                  'text-xs font-semibold uppercase tracking-wider px-2 py-1 rounded-lg',
                  parsedResult.transaction_type === 'income'
                    ? 'bg-income/20 text-income'
                    : 'bg-expense/20 text-expense',
                )}>
                  {parsedResult.transaction_type === 'income' ? 'Ingreso' : 'Gasto'}
                </span>
                {parsedResult.category_name && (
                  <span className="text-xs text-slate-400">{parsedResult.category_name}</span>
                )}
              </div>

              <div className="text-center">
                <span className="text-3xl font-bold text-slate-100">
                  {parsedResult.currency_code === 'USD' ? '$' : 'S/'}
                  {parsedResult.amount.toFixed(2)}
                </span>
              </div>

              <p className="text-sm text-slate-300 text-center">{parsedResult.description}</p>

              {/* Acciones */}
              <div className="flex gap-2 pt-1">
                <button onClick={handleRetry} className="btn-secondary flex-1 flex items-center justify-center gap-1.5 py-2.5 text-sm">
                  <Mic size={16} />
                  Repetir
                </button>
                <button onClick={handleConfirm} className="btn-primary flex-1 flex items-center justify-center gap-1.5 py-2.5 text-sm">
                  <Check size={16} />
                  Guardar
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Error retry */}
        <AnimatePresence>
          {state === 'error' && (
            <motion.div
              className="flex gap-3"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
            >
              <button onClick={onCancel} className="btn-secondary px-5 py-2.5 text-sm">
                Cancelar
              </button>
              <button onClick={handleRetry} className="btn-primary px-5 py-2.5 text-sm flex items-center gap-1.5">
                <Mic size={16} />
                Reintentar
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* IA badge */}
        <motion.div
          className="flex items-center gap-1.5 text-xs text-slate-500"
          animate={{ opacity: [0.4, 0.8, 0.4] }}
          transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
        >
          <Sparkles size={14} />
          <span>Wabid · Registro por voz</span>
        </motion.div>

        {/* Cancelar (solo en idle/listening) */}
        {(state === 'idle' || state === 'listening') && (
          <button onClick={onCancel} className="text-sm text-slate-500 active:text-slate-300 py-2">
            Cancelar
          </button>
        )}
      </div>
    </div>
  );
}
