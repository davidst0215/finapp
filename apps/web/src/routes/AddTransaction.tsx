import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mic, MicOff, Check } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { TransactionType, InputMethod } from '@/types/database';
import { cn } from '@/lib/utils';

const typeOptions: { value: TransactionType; label: string; color: string }[] = [
  { value: 'expense', label: 'Gasto', color: 'bg-expense' },
  { value: 'income', label: 'Ingreso', color: 'bg-income' },
  { value: 'transfer', label: 'Transferencia', color: 'bg-transfer' },
];

export function AddTransactionPage() {
  const navigate = useNavigate();
  const { accounts, categories, fetchAccounts, fetchCategories, addTransaction } = useAppStore();

  const [type, setType] = useState<TransactionType>('expense');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 16));
  const [saving, setSaving] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [voiceText, setVoiceText] = useState('');

  useEffect(() => {
    fetchAccounts();
    fetchCategories();
  }, [fetchAccounts, fetchCategories]);

  // Set default account
  useEffect(() => {
    if (accounts.length > 0 && !accountId) {
      setAccountId(accounts[0]!.account_id);
    }
  }, [accounts, accountId]);

  const filteredCategories = categories.filter(c => c.category_type === (type === 'transfer' ? 'expense' : type));

  const handleVoice = () => {
    if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
      alert('Tu navegador no soporta reconocimiento de voz. Usa Chrome.');
      return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    recognition.lang = 'es-PE';
    recognition.continuous = false;
    recognition.interimResults = false;

    recognition.onstart = () => setIsListening(true);
    recognition.onend = () => setIsListening(false);

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const transcript = event.results[0]?.[0]?.transcript ?? '';
      setVoiceText(transcript);
      parseVoiceInput(transcript);
    };

    recognition.onerror = () => setIsListening(false);
    recognition.start();
  };

  const parseVoiceInput = (text: string) => {
    // Parseo local básico (Fase 2 agregará OpenAI)
    const lower = text.toLowerCase();

    // Detectar monto
    const milMatch = lower.match(/(\d+)\s*mil/);
    const numMatch = lower.match(/(\d+(?:\.\d+)?)/);
    if (milMatch) {
      setAmount(String(Number(milMatch[1]) * 1000));
    } else if (numMatch) {
      setAmount(numMatch[1]!);
    }

    // Detectar tipo
    if (lower.includes('gast') || lower.includes('pag') || lower.includes('compr')) {
      setType('expense');
    } else if (lower.includes('cobr') || lower.includes('pagar') || lower.includes('ingres') || lower.includes('sueldo')) {
      setType('income');
    }

    // Usar el texto como descripción
    setDescription(text);
  };

  const handleSubmit = async () => {
    if (!amount || !accountId) return;

    setSaving(true);
    const inputMethod: InputMethod = voiceText ? 'voice' : 'manual';

    await addTransaction({
      transaction_type: type,
      amount: parseFloat(amount),
      currency_code: 'PEN',
      description: description || null,
      notes: null,
      account_id: accountId,
      category_id: categoryId || null,
      transaction_date: new Date(date).toISOString(),
      transfer_to_account_id: null,
      input_method: inputMethod,
      raw_voice_text: voiceText || null,
      is_recurring: false,
      recurring_id: null,
      tags: null,
    });

    setSaving(false);
    navigate('/transactions');
  };

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-bold">Nuevo movimiento</h1>

      {/* Tipo de transacción */}
      <div className="flex gap-2">
        {typeOptions.map(opt => (
          <button
            key={opt.value}
            onClick={() => setType(opt.value)}
            className={cn(
              'flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all',
              type === opt.value
                ? `${opt.color} text-white`
                : 'bg-slate-800 text-slate-400'
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Monto + Voz */}
      <div className="card space-y-3">
        <label className="text-xs text-slate-400 uppercase tracking-wider">Monto</label>
        <div className="flex items-center gap-3">
          <div className="flex-1 relative">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 text-lg">S/</span>
            <input
              type="number"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder="0.00"
              className="input pl-10 text-2xl font-bold"
              inputMode="decimal"
              autoFocus
            />
          </div>
          <button
            onClick={handleVoice}
            className={cn(
              'w-14 h-14 rounded-full flex items-center justify-center transition-all flex-shrink-0',
              isListening
                ? 'bg-expense text-white animate-pulse'
                : 'bg-slate-800 text-slate-400 active:bg-slate-700'
            )}
          >
            {isListening ? <MicOff size={22} /> : <Mic size={22} />}
          </button>
        </div>
        {voiceText && (
          <p className="text-xs text-slate-500 italic">"{voiceText}"</p>
        )}
      </div>

      {/* Descripción */}
      <div>
        <input
          type="text"
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="Descripción (opcional)"
          className="input"
        />
      </div>

      {/* Cuenta */}
      <div>
        <label className="text-xs text-slate-400 uppercase tracking-wider mb-2 block">Cuenta</label>
        <div className="flex gap-2 overflow-x-auto no-scrollbar">
          {accounts.map(acc => (
            <button
              key={acc.account_id}
              onClick={() => setAccountId(acc.account_id)}
              className={cn(
                'px-4 py-2 rounded-xl text-sm whitespace-nowrap transition-all flex-shrink-0',
                accountId === acc.account_id
                  ? 'bg-primary-600 text-white'
                  : 'bg-slate-800 text-slate-400'
              )}
            >
              {acc.account_name}
            </button>
          ))}
        </div>
      </div>

      {/* Categoría */}
      <div>
        <label className="text-xs text-slate-400 uppercase tracking-wider mb-2 block">Categoría</label>
        <div className="grid grid-cols-3 gap-2">
          {filteredCategories.map(cat => (
            <button
              key={cat.category_id}
              onClick={() => setCategoryId(cat.category_id)}
              className={cn(
                'px-3 py-2.5 rounded-xl text-xs font-medium transition-all text-center',
                categoryId === cat.category_id
                  ? 'bg-primary-600 text-white'
                  : 'bg-slate-800 text-slate-400'
              )}
            >
              <span className="block text-base mb-0.5">{cat.icon ?? '📋'}</span>
              {cat.category_name}
            </button>
          ))}
        </div>
      </div>

      {/* Fecha */}
      <div>
        <label className="text-xs text-slate-400 uppercase tracking-wider mb-2 block">Fecha y hora</label>
        <input
          type="datetime-local"
          value={date}
          onChange={e => setDate(e.target.value)}
          className="input"
        />
      </div>

      {/* Botón guardar */}
      <button
        onClick={handleSubmit}
        disabled={!amount || !accountId || saving}
        className="btn-primary w-full flex items-center justify-center gap-2"
      >
        <Check size={18} />
        {saving ? 'Guardando...' : 'Guardar'}
      </button>
    </div>
  );
}
