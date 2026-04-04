export type TransactionType = 'income' | 'expense' | 'transfer';
export type AccountType = 'checking' | 'savings' | 'credit_card' | 'cash' | 'investment' | 'loan' | 'other';
export type CategoryType = 'income' | 'expense';
export type InputMethod = 'manual' | 'voice' | 'recurring' | 'import';
export type Frequency = 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'semiannual' | 'annual';
export type AlertType = 'budget_threshold' | 'budget_exceeded' | 'recurring_due' | 'goal_milestone' | 'unusual_spending' | 'credit_card_due' | 'low_balance';

export interface User {
  user_id: string;
  display_name: string;
  default_currency: string;
  timezone: string;
  created_at: string;
  updated_at: string;
}

export interface Account {
  account_id: string;
  user_id: string;
  account_name: string;
  account_type: AccountType;
  currency_code: string;
  current_balance: number;
  credit_limit: number | null;
  billing_day: number | null;
  payment_due_day: number | null;
  color: string | null;
  icon: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Category {
  category_id: string;
  user_id: string | null;
  parent_id: string | null;
  category_name: string;
  category_type: CategoryType;
  icon: string | null;
  color: string | null;
  is_system: boolean;
  is_active: boolean;
  created_at: string;
}

export interface Transaction {
  transaction_id: string;
  user_id: string;
  account_id: string;
  category_id: string | null;
  transaction_type: TransactionType;
  amount: number;
  currency_code: string;
  description: string | null;
  notes: string | null;
  transaction_date: string;
  transfer_to_account_id: string | null;
  input_method: InputMethod;
  raw_voice_text: string | null;
  is_recurring: boolean;
  recurring_id: string | null;
  tags: string[] | null;
  created_at: string;
  updated_at: string;
  // Joined fields
  category?: Category;
  account?: Account;
}

export interface RecurringTransaction {
  recurring_id: string;
  user_id: string;
  account_id: string;
  category_id: string | null;
  transaction_type: TransactionType;
  amount: number;
  currency_code: string;
  description: string;
  frequency: Frequency;
  day_of_month: number | null;
  start_date: string;
  end_date: string | null;
  next_due_date: string;
  is_active: boolean;
  auto_register: boolean;
  created_at: string;
  updated_at: string;
}

export interface Budget {
  budget_id: string;
  user_id: string;
  category_id: string;
  amount_limit: number;
  period_type: string;
  alert_threshold: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  // Joined
  category?: Category;
}

export interface SavingsGoal {
  goal_id: string;
  user_id: string;
  goal_name: string;
  target_amount: number;
  current_amount: number;
  currency_code: string;
  target_date: string | null;
  icon: string | null;
  color: string | null;
  is_completed: boolean;
  created_at: string;
  updated_at: string;
}

export interface SavingsContribution {
  contribution_id: string;
  goal_id: string;
  transaction_id: string | null;
  amount: number;
  contribution_date: string;
  created_at: string;
}

export interface Alert {
  alert_id: string;
  user_id: string;
  alert_type: AlertType;
  reference_id: string | null;
  title: string;
  message: string | null;
  is_read: boolean;
  is_dismissed: boolean;
  triggered_at: string;
}

export interface AiChatHistory {
  chat_id: string;
  user_id: string;
  role: string;
  content: string;
  tokens_used: number | null;
  model_used: string | null;
  created_at: string;
}

// Supabase Database type for client
export interface Database {
  public: {
    Tables: {
      users: { Row: User; Insert: Partial<User> & Pick<User, 'user_id' | 'display_name'>; Update: Partial<User> };
      accounts: { Row: Account; Insert: Omit<Account, 'account_id' | 'created_at' | 'updated_at'>; Update: Partial<Account> };
      categories: { Row: Category; Insert: Omit<Category, 'category_id' | 'created_at'>; Update: Partial<Category> };
      transactions: { Row: Transaction; Insert: Omit<Transaction, 'transaction_id' | 'created_at' | 'updated_at'>; Update: Partial<Transaction> };
      recurring_transactions: { Row: RecurringTransaction; Insert: Omit<RecurringTransaction, 'recurring_id' | 'created_at' | 'updated_at'>; Update: Partial<RecurringTransaction> };
      budgets: { Row: Budget; Insert: Omit<Budget, 'budget_id' | 'created_at' | 'updated_at'>; Update: Partial<Budget> };
      savings_goals: { Row: SavingsGoal; Insert: Omit<SavingsGoal, 'goal_id' | 'created_at' | 'updated_at'>; Update: Partial<SavingsGoal> };
      savings_contributions: { Row: SavingsContribution; Insert: Omit<SavingsContribution, 'contribution_id' | 'created_at'>; Update: Partial<SavingsContribution> };
      alerts: { Row: Alert; Insert: Omit<Alert, 'alert_id' | 'triggered_at'>; Update: Partial<Alert> };
      ai_chat_history: { Row: AiChatHistory; Insert: Omit<AiChatHistory, 'chat_id' | 'created_at'>; Update: Partial<AiChatHistory> };
    };
    Functions: {
      fn_get_monthly_summary: {
        Args: { p_year: number; p_month: number };
        Returns: { total_income: number; total_expenses: number; net_balance: number; transaction_count: number; top_category_name: string; top_category_amount: number }[];
      };
      fn_get_budget_status: {
        Args: Record<string, never>;
        Returns: { budget_id: string; category_name: string; category_icon: string | null; category_color: string | null; amount_limit: number; amount_spent: number; percentage_used: number; remaining: number }[];
      };
      fn_get_spending_by_category: {
        Args: { p_start_date: string; p_end_date: string };
        Returns: { category_id: string; category_name: string; icon: string | null; color: string | null; total_amount: number; transaction_count: number; percentage: number }[];
      };
    };
  };
}
