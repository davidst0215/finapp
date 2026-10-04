import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import type { Account, Category, Transaction } from '@/types/database';

interface AppState {
  // Data
  accounts: Account[];
  categories: Category[];
  transactions: Transaction[];
  // Loading states
  loadingAccounts: boolean;
  loadingCategories: boolean;
  loadingTransactions: boolean;
  // Error
  error: string | null;
  // Actions
  fetchAccounts: () => Promise<void>;
  fetchCategories: () => Promise<void>;
  fetchTransactions: (limit?: number) => Promise<void>;
  addTransaction: (tx: Omit<Transaction, 'transaction_id' | 'created_at' | 'updated_at' | 'user_id'> & { transaction_id?: string }) => Promise<Transaction | null>;
  deleteTransaction: (id: string) => Promise<void>;
  clearError: () => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  accounts: [],
  categories: [],
  transactions: [],
  loadingAccounts: false,
  loadingCategories: false,
  loadingTransactions: false,
  error: null,

  fetchAccounts: async () => {
    // Wait for session before fetching
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    set({ loadingAccounts: true });
    const { data, error } = await supabase
      .from('accounts')
      .select('*')
      .eq('is_active', true)
      .order('account_name');
    if (error) {
      set({ error: error.message, loadingAccounts: false });
      return;
    }
    set({ accounts: data ?? [], loadingAccounts: false });
  },

  fetchCategories: async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    set({ loadingCategories: true });
    const { data, error } = await supabase
      .from('categories')
      .select('*')
      .eq('is_active', true)
      .order('category_name');
    if (error) {
      set({ error: error.message, loadingCategories: false });
      return;
    }
    set({ categories: data ?? [], loadingCategories: false });
  },

  fetchTransactions: async (limit = 50) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    set({ loadingTransactions: true });
    const { data, error } = await supabase
      .from('transactions')
      .select('*, category:categories(*), account:accounts!transactions_account_id_fkey(*)')
      .order('transaction_date', { ascending: false })
      .limit(limit);
    if (error) {
      set({ error: error.message, loadingTransactions: false });
      return;
    }
    set({ transactions: (data as Transaction[]) ?? [], loadingTransactions: false });
  },

  addTransaction: async (tx) => {
    const { data, error } = await supabase
      .from('transactions')
      .insert(tx)
      .select('*, category:categories(*), account:accounts!transactions_account_id_fkey(*)')
      .single();

    if (error || !data) {
      if (error) set({ error: error.message });
      return null;
    }

    const typed = data as Transaction;
    set({ transactions: [typed, ...get().transactions] });
    return typed;
  },

  deleteTransaction: async (id) => {
    const { error } = await supabase.from('transactions').delete().eq('transaction_id', id);
    if (error) {
      set({ error: error.message });
      return;
    }
    set({ transactions: get().transactions.filter(t => t.transaction_id !== id) });
  },

  clearError: () => set({ error: null }),
}));
