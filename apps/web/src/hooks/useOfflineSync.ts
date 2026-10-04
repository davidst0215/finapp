import { useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useToastStore } from '@/stores/toastStore';

const QUEUE_KEY = 'finapp_offline_queue';

interface OfflineTransaction {
  id: string;
  transaction_type: string;
  amount: number;
  currency_code: string;
  description: string | null;
  account_id: string;
  category_id: string | null;
  transaction_date: string;
  input_method: string;
  raw_voice_text: string | null;
  created_at: string;
}

function getQueue(): OfflineTransaction[] {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]');
  } catch {
    return [];
  }
}

function saveQueue(queue: OfflineTransaction[]) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

export function addToOfflineQueue(tx: Omit<OfflineTransaction, 'id' | 'created_at'>) {
  const queue = getQueue();
  queue.push({
    ...tx,
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
  });
  saveQueue(queue);
}

export function getOfflineQueueCount(): number {
  return getQueue().length;
}

export function useOfflineSync() {
  const addToast = useToastStore(s => s.addToast);

  const syncQueue = useCallback(async () => {
    const queue = getQueue();
    if (queue.length === 0) return;

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    let synced = 0;
    const failed: OfflineTransaction[] = [];

    for (const tx of queue) {
      const { error } = await supabase.from('transactions').insert({
        transaction_type: tx.transaction_type,
        amount: tx.amount,
        currency_code: tx.currency_code,
        description: tx.description,
        account_id: tx.account_id,
        category_id: tx.category_id,
        transaction_date: tx.transaction_date,
        input_method: tx.input_method,
        raw_voice_text: tx.raw_voice_text,
        is_recurring: false,
        transfer_to_account_id: null,
        recurring_id: null,
        notes: null,
        tags: null,
      });

      if (error) {
        failed.push(tx);
      } else {
        synced++;
      }
    }

    saveQueue(failed);

    if (synced > 0) {
      addToast(`${synced} transacción${synced > 1 ? 'es' : ''} sincronizada${synced > 1 ? 's' : ''}`);
    }
  }, [addToast]);

  // Sync when coming back online
  useEffect(() => {
    const handler = () => {
      if (navigator.onLine) syncQueue();
    };

    window.addEventListener('online', handler);

    // Also try on mount
    if (navigator.onLine) syncQueue();

    return () => window.removeEventListener('online', handler);
  }, [syncQueue]);
}
