import React, { useState, useRef, useEffect, useCallback } from 'react';
import { ArrowUp, Mic, MicOff, Loader2, Check, X, Sparkles } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';

type PromptState = 'idle' | 'listening' | 'processing' | 'success' | 'error';

interface ParsedResult {
  amount: number;
  transaction_type: 'income' | 'expense';
  description: string;
  category_name: string | null;
  category_id: string | null;
  currency_code: string;
  confidence: number;
}

interface TransactionPromptProps {
  onSave: (result: ParsedResult, rawText: string) => Promise<void>;
  className?: string;
}

export function TransactionPrompt({ onSave, className }: TransactionPromptProps) {
  const [input, setInput] = useState('');
  const [state, setState] = useState<PromptState>('idle');
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState('');
  const [parsedResult, setParsedResult] = useState<ParsedResult | null>(null);
  const [waveformData, setWaveformData] = useState<number[]>(Array(28).fill(0));
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const waveIntervalRef = useRef<ReturnType<typeof setInterval>>();

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  }, [input]);

  const stopWaveform = useCallback(() => {
    if (waveIntervalRef.current) {
      clearInterval(waveIntervalRef.current);
      waveIntervalRef.current = undefined;
    }
    setWaveformData(Array(28).fill(0));
  }, []);

  const parseWithAI = useCallback(async (text: string) => {
    setState('processing');
    stopWaveform();

    try {
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

  const handleSubmitText = () => {
    if (!input.trim()) return;
    setTranscript(input.trim());
    parseWithAI(input.trim());
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmitText();
    }
  };

  const startListening = useCallback(() => {
    if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
      setError('Tu navegador no soporta reconocimiento de voz.');
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
      waveIntervalRef.current = setInterval(() => {
        setWaveformData(Array(28).fill(0).map(() => Math.random() * 100));
      }, 80);
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const result = event.results[event.results.length - 1];
      if (result?.[0]) {
        setTranscript(result[0].transcript);
        setInput(result[0].transcript);
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

    recognition.onend = () => stopWaveform();

    recognitionRef.current = recognition;
    recognition.start();
  }, [parseWithAI, stopWaveform]);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  const handleConfirm = async () => {
    if (parsedResult) {
      setState('processing');
      await onSave(parsedResult, transcript);
      // Reset everything
      setState('idle');
      setInput('');
      setTranscript('');
      setParsedResult(null);
      setError('');
    }
  };

  const handleReset = () => {
    setState('idle');
    setInput('');
    setTranscript('');
    setParsedResult(null);
    setError('');
    stopWaveform();
    recognitionRef.current?.stop();
  };

  const hasContent = input.trim().length > 0;
  const isActive = state !== 'idle';

  return (
    <div className={cn('w-full', className)}>
      {/* Result card */}
      <AnimatePresence>
        {state === 'success' && parsedResult && (
          <motion.div
            className="card mb-3 space-y-3"
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ type: 'spring', stiffness: 300, damping: 25 }}
          >
            <div className="flex items-center justify-between">
              <span className={cn(
                'text-xs font-semibold uppercase tracking-wider px-2.5 py-1 rounded-lg',
                parsedResult.transaction_type === 'income'
                  ? 'bg-income/20 text-income'
                  : 'bg-expense/20 text-expense',
              )}>
                {parsedResult.transaction_type === 'income' ? 'Ingreso' : 'Gasto'}
              </span>
              <div className="flex items-center gap-1.5">
                {parsedResult.category_name && (
                  <span className="text-xs text-slate-400">{parsedResult.category_name}</span>
                )}
                <button onClick={handleReset} className="p-1 text-slate-500 active:text-slate-300">
                  <X size={14} />
                </button>
              </div>
            </div>

            <div className="text-center py-1">
              <span className="text-3xl font-bold text-slate-100">
                {parsedResult.currency_code === 'USD' ? '$' : 'S/'}
                {parsedResult.amount.toFixed(2)}
              </span>
            </div>

            <p className="text-sm text-slate-300 text-center">{parsedResult.description}</p>

            <div className="flex gap-2 pt-1">
              <button onClick={handleReset} className="btn-secondary flex-1 flex items-center justify-center gap-1.5 py-2.5 text-sm">
                Cancelar
              </button>
              <button onClick={handleConfirm} className="btn-primary flex-1 flex items-center justify-center gap-1.5 py-2.5 text-sm">
                <Check size={16} />
                Guardar
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Error message */}
      <AnimatePresence>
        {state === 'error' && (
          <motion.div
            className="card mb-3 flex items-center gap-3"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
          >
            <div className="w-8 h-8 rounded-full bg-expense/20 flex items-center justify-center flex-shrink-0">
              <X size={16} className="text-expense" />
            </div>
            <p className="text-sm text-slate-300 flex-1">{error}</p>
            <button onClick={handleReset} className="text-xs text-primary-400 active:text-primary-300 font-medium">
              Reintentar
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Waveform (during listening) */}
      <AnimatePresence>
        {state === 'listening' && (
          <motion.div
            className="mb-3"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
          >
            <div className="flex items-center justify-center gap-[2px] h-12 mb-2">
              {waveformData.map((height, i) => (
                <motion.div
                  key={i}
                  className="w-[2.5px] rounded-full bg-primary-500"
                  animate={{ height: `${Math.max(4, height * 0.45)}px` }}
                  transition={{ duration: 0.08, ease: 'easeOut' }}
                />
              ))}
            </div>
            {transcript && (
              <p className="text-sm text-slate-400 text-center italic">"{transcript}"</p>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Processing indicator */}
      <AnimatePresence>
        {state === 'processing' && (
          <motion.div
            className="flex items-center justify-center gap-2 mb-3 py-3"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <Loader2 size={18} className="text-primary-400 animate-spin" />
            <span className="text-sm text-slate-400">Procesando con IA...</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Input bar */}
      <motion.div
        className={cn(
          'rounded-2xl border bg-slate-900 p-2 transition-all duration-300',
          state === 'listening'
            ? 'border-primary-500/70 shadow-lg shadow-primary-500/10'
            : state === 'error'
              ? 'border-expense/50'
              : 'border-slate-700',
        )}
        layout
      >
        {/* Textarea (hidden during listening) */}
        {state !== 'listening' && state !== 'processing' && state !== 'success' && (
          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder='Escribe "gasté 50 en almuerzo" o toca el mic...'
            className="w-full bg-transparent border-none text-slate-100 text-base placeholder-slate-400 focus:outline-none resize-none min-h-[44px] max-h-[120px] px-3 py-2"
            rows={1}
            disabled={isActive}
          />
        )}

        {/* Actions row */}
        <div className="flex items-center justify-between px-1 pt-1">
          {/* Left: AI badge */}
          <div className="flex items-center gap-1.5 text-xs text-slate-500">
            <Sparkles size={13} />
            <span>Wabid</span>
          </div>

          {/* Right: action button */}
          <motion.button
            whileTap={{ scale: 0.9 }}
            onClick={() => {
              if (state === 'listening') {
                stopListening();
              } else if (hasContent && state === 'idle') {
                handleSubmitText();
              } else if (state === 'idle') {
                startListening();
              } else if (state === 'error') {
                handleReset();
              }
            }}
            disabled={state === 'processing' || state === 'success'}
            className={cn(
              'w-9 h-9 rounded-full flex items-center justify-center transition-all duration-200',
              state === 'listening'
                ? 'bg-expense text-slate-950'
                : hasContent
                  ? 'bg-primary-600 text-slate-950'
                  : 'bg-slate-800 text-slate-400 active:bg-slate-700',
            )}
          >
            {state === 'listening' ? (
              <MicOff size={18} />
            ) : hasContent ? (
              <ArrowUp size={18} />
            ) : (
              <Mic size={18} />
            )}
          </motion.button>
        </div>
      </motion.div>
    </div>
  );
}
