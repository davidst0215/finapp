import { useEffect, useRef, useState } from 'react';
import { Send, Mic, MicOff, Loader2, Bot, User, Trash2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useVoiceInput } from '@/hooks/useVoiceInput';
import { cn } from '@/lib/utils';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
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

  // Cargar historial
  useEffect(() => {
    loadHistory();
  }, []);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Cuando termina de hablar, poner texto en input
  useEffect(() => {
    if (transcript && !isListening) {
      setInput(transcript);
      resetTranscript();
    }
  }, [transcript, isListening, resetTranscript]);

  async function loadHistory() {
    const { data } = await supabase
      .from('ai_chat_history')
      .select('role, content, created_at')
      .order('created_at', { ascending: true })
      .limit(50);

    if (data) {
      setMessages(data.map(d => ({
        role: d.role as 'user' | 'assistant',
        content: d.content,
        timestamp: d.created_at,
      })));
    }
    setLoadingHistory(false);
  }

  async function handleSend(text?: string) {
    const msg = text ?? input.trim();
    if (!msg || loading) return;

    const userMsg: ChatMessage = { role: 'user', content: msg };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('No hay sesión activa');

      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ai-chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
          'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
          message: msg,
          history: messages.slice(-10),
        }),
      });

      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);

      const assistantMsg: ChatMessage = { role: 'assistant', content: data.reply };
      setMessages(prev => [...prev, assistantMsg]);
    } catch (err) {
      const errorMsg: ChatMessage = {
        role: 'assistant',
        content: `Error: ${err instanceof Error ? err.message : 'No se pudo conectar con el asistente'}`,
      };
      setMessages(prev => [...prev, errorMsg]);
    }

    setLoading(false);
    inputRef.current?.focus();
  }

  async function handleClearHistory() {
    await supabase.from('ai_chat_history').delete().neq('chat_id', '00000000-0000-0000-0000-000000000000');
    setMessages([]);
  }

  const handleVoice = () => {
    if (isListening) {
      stopListening();
    } else {
      resetTranscript();
      startListening();
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-7rem)]">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-primary-600 flex items-center justify-center">
            <Bot size={16} />
          </div>
          <div>
            <h1 className="text-lg font-bold leading-tight">FinBot</h1>
            <p className="text-[10px] text-slate-500">Asistente financiero con IA</p>
          </div>
        </div>
        {messages.length > 0 && (
          <button onClick={handleClearHistory} className="text-slate-600 p-1.5 rounded-lg hover:bg-slate-800">
            <Trash2 size={16} />
          </button>
        )}
      </div>

      {/* Mensajes */}
      <div className="flex-1 overflow-y-auto no-scrollbar space-y-3 pb-2">
        {loadingHistory ? (
          <div className="text-center py-10 text-slate-500">
            <Loader2 size={20} className="animate-spin mx-auto mb-2" />
            Cargando historial...
          </div>
        ) : messages.length === 0 ? (
          <div className="text-center py-6">
            <Bot size={40} className="mx-auto text-primary-600 mb-3" />
            <p className="text-sm text-slate-400 mb-1">Hola, soy FinBot</p>
            <p className="text-xs text-slate-600 mb-4">Pregúntame sobre tus finanzas</p>
            <div className="grid grid-cols-2 gap-2 px-2">
              {SUGGESTIONS.map(s => (
                <button
                  key={s}
                  onClick={() => handleSend(s)}
                  className="text-left text-xs px-3 py-2.5 rounded-xl bg-slate-900 border border-slate-800 text-slate-400 active:bg-slate-800 transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg, i) => (
            <div
              key={i}
              className={cn('flex gap-2', msg.role === 'user' ? 'justify-end' : 'justify-start')}
            >
              {msg.role === 'assistant' && (
                <div className="w-7 h-7 rounded-full bg-primary-600/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <Bot size={14} className="text-primary-400" />
                </div>
              )}
              <div
                className={cn(
                  'max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed',
                  msg.role === 'user'
                    ? 'bg-primary-600 text-white rounded-br-md'
                    : 'bg-slate-800 text-slate-200 rounded-bl-md'
                )}
              >
                <MessageContent content={msg.content} />
              </div>
              {msg.role === 'user' && (
                <div className="w-7 h-7 rounded-full bg-slate-700 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <User size={14} className="text-slate-400" />
                </div>
              )}
            </div>
          ))
        )}

        {loading && (
          <div className="flex gap-2">
            <div className="w-7 h-7 rounded-full bg-primary-600/20 flex items-center justify-center flex-shrink-0">
              <Bot size={14} className="text-primary-400" />
            </div>
            <div className="bg-slate-800 rounded-2xl rounded-bl-md px-4 py-3">
              <div className="flex gap-1">
                <div className="w-2 h-2 rounded-full bg-slate-500 animate-bounce" style={{ animationDelay: '0ms' }} />
                <div className="w-2 h-2 rounded-full bg-slate-500 animate-bounce" style={{ animationDelay: '150ms' }} />
                <div className="w-2 h-2 rounded-full bg-slate-500 animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="pt-2 border-t border-slate-800">
        {isListening && (
          <div className="text-center py-1 mb-1">
            <span className="text-xs text-expense animate-pulse">Escuchando... {transcript}</span>
          </div>
        )}
        <div className="flex items-center gap-2">
          {isSupported && (
            <button
              onClick={handleVoice}
              className={cn(
                'w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 transition-all',
                isListening ? 'bg-expense text-white animate-pulse' : 'bg-slate-800 text-slate-400'
              )}
            >
              {isListening ? <MicOff size={18} /> : <Mic size={18} />}
            </button>
          )}
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSend()}
            placeholder="Pregunta sobre tus finanzas..."
            className="input flex-1 py-2.5"
            disabled={loading}
          />
          <button
            onClick={() => handleSend()}
            disabled={!input.trim() || loading}
            className="w-10 h-10 rounded-full bg-primary-600 flex items-center justify-center flex-shrink-0 disabled:opacity-50 active:bg-primary-700"
          >
            <Send size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}

// Renderizar markdown básico
function MessageContent({ content }: { content: string }) {
  const lines = content.split('\n');
  return (
    <div className="space-y-1">
      {lines.map((line, i) => {
        if (line.startsWith('- ') || line.startsWith('• ')) {
          return <p key={i} className="pl-2 text-xs">{line}</p>;
        }
        if (line.startsWith('**') && line.endsWith('**')) {
          return <p key={i} className="font-semibold text-xs">{line.replace(/\*\*/g, '')}</p>;
        }
        if (line.trim() === '') return <br key={i} />;
        return <p key={i}>{line}</p>;
      })}
    </div>
  );
}
