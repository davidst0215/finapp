import { useEffect, useRef, useState } from 'react';
import { Send, Mic, MicOff, Bot, User, Trash2 } from 'lucide-react';
import { supabase, functionUrl } from '@/lib/supabase';
import { useVoiceInput } from '@/hooks/useVoiceInput';
import { cn } from '@/lib/utils';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const SUGGESTIONS = [
  '¿Cuánto gasté este mes?',
  '¿En qué gasto más?',
  '¿Cómo van mis presupuestos?',
  '¿Qué pagos tengo pendientes?',
  'Dame consejos para ahorrar',
  '¿Cómo va mi meta de ahorro?',
];

export function AiChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { isListening, transcript, isSupported, startListening, stopListening, resetTranscript } = useVoiceInput();

  useEffect(() => { loadHistory(); }, []);
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);
  useEffect(() => {
    if (transcript && !isListening) { setInput(transcript); resetTranscript(); }
  }, [transcript, isListening, resetTranscript]);

  async function loadHistory() {
    const { data } = await supabase
      .from('ai_chat_history')
      .select('role, content')
      .order('created_at', { ascending: true })
      .limit(50);
    if (data) setMessages(data.map(d => ({ role: d.role as 'user' | 'assistant', content: d.content })));
    setLoadingHistory(false);
  }

  async function handleSend(text?: string) {
    const msg = text ?? input.trim();
    if (!msg || loading) return;

    setMessages(prev => [...prev, { role: 'user', content: msg }]);
    setInput('');
    setLoading(true);

    // Add empty assistant message that we'll stream into
    setMessages(prev => [...prev, { role: 'assistant', content: '' }]);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('No hay sesión');

      const res = await fetch(functionUrl('ai-chat'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
          'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ message: msg, history: messages.slice(-10), stream: true }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) throw new Error('No stream');

      // Un evento SSE (o una letra con tilde) puede quedar partido entre dos fragmentos:
      // se decodifica en modo stream y la última línea incompleta espera al siguiente.
      let pending = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        pending += decoder.decode(value, { stream: true });
        const parts = pending.split('\n');
        pending = parts.pop() ?? '';
        const lines = parts.filter(l => l.startsWith('data: '));

        for (const line of lines) {
          const data = line.slice(6);
          if (data === '[DONE]') break;
          try {
            const parsed = JSON.parse(data);
            if (parsed.content) {
              setMessages(prev => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last && last.role === 'assistant') {
                  updated[updated.length - 1] = { ...last, content: last.content + parsed.content };
                }
                return updated;
              });
            }
          } catch { /* skip */ }
        }
      }
    } catch (err) {
      setMessages(prev => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last && last.role === 'assistant' && !last.content) {
          updated[updated.length - 1] = { ...last, content: `Error: ${err instanceof Error ? err.message : 'No se pudo conectar'}` };
        }
        return updated;
      });
    }

    setLoading(false);
    inputRef.current?.focus();
  }

  async function handleClearHistory() {
    await supabase.from('ai_chat_history').delete().neq('chat_id', '00000000-0000-0000-0000-000000000000');
    setMessages([]);
  }

  return (
    <div className="flex flex-col h-[calc(100vh-5rem)]">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-primary-600/20 flex items-center justify-center">
            <Bot size={16} className="text-primary-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold leading-tight">Wabid</h1>
            <p className="text-[10px] text-slate-500">Asistente financiero con IA</p>
          </div>
        </div>
        {messages.length > 0 && (
          <button onClick={handleClearHistory} className="text-slate-600 p-1.5 rounded-lg active:bg-slate-800">
            <Trash2 size={16} />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto no-scrollbar space-y-3 pb-2">
        {loadingHistory ? (
          <div className="text-center py-10 text-slate-500 text-sm">Cargando...</div>
        ) : messages.length === 0 ? (
          <div className="text-center py-6">
            <Bot size={36} className="mx-auto text-primary-500/40 mb-3" />
            <p className="text-sm text-slate-400 mb-1">Hola, soy Wabid</p>
            <p className="text-xs text-slate-600 mb-4">Pregúntame sobre tus finanzas</p>
            <div className="grid grid-cols-2 gap-2 px-2">
              {SUGGESTIONS.map(s => (
                <button key={s} onClick={() => handleSend(s)}
                  className="text-left text-xs px-3 py-2.5 rounded-xl bg-slate-900 border border-slate-800/60 text-slate-400 active:bg-slate-800 transition-colors">
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg, i) => (
            <div key={i} className={cn('flex gap-2', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
              {msg.role === 'assistant' && (
                <div className="w-6 h-6 rounded-full bg-primary-600/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <Bot size={12} className="text-primary-400" />
                </div>
              )}
              <div className={cn(
                'max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed',
                msg.role === 'user'
                  ? 'bg-primary-600 text-slate-950 rounded-br-md'
                  : 'bg-slate-800 text-slate-200 rounded-bl-md',
                msg.role === 'assistant' && !msg.content && 'animate-pulse',
              )}>
                {msg.content || '...'}
              </div>
              {msg.role === 'user' && (
                <div className="w-6 h-6 rounded-full bg-slate-700 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <User size={12} className="text-slate-400" />
                </div>
              )}
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="pt-2 border-t border-slate-800/60">
        {isListening && (
          <p className="text-center text-xs text-expense animate-pulse mb-1">Escuchando... {transcript}</p>
        )}
        <div className="flex items-center gap-2">
          {isSupported && (
            <button onClick={isListening ? stopListening : () => { resetTranscript(); startListening(); }}
              className={cn('w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0',
                isListening ? 'bg-expense text-slate-950 animate-pulse' : 'bg-slate-800 text-slate-400')}>
              {isListening ? <MicOff size={16} /> : <Mic size={16} />}
            </button>
          )}
          <input ref={inputRef} type="text" value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSend()}
            placeholder="Pregunta sobre tus finanzas..."
            className="input flex-1 py-2.5" disabled={loading} />
          <button onClick={() => handleSend()} disabled={!input.trim() || loading}
            className="w-9 h-9 rounded-full bg-primary-600 flex items-center justify-center text-slate-950 flex-shrink-0 disabled:opacity-50">
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
