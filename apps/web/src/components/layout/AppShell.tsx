import { Outlet } from 'react-router-dom';
import { TabBar } from './TabBar';
import { ToastContainer } from '@/components/ui/Toast';
import { useAppStore } from '@/stores/appStore';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useNotifications } from '@/hooks/useNotifications';
import { useOfflineSync } from '@/hooks/useOfflineSync';

export function AppShell() {
  const { error, clearError, fetchAccounts, fetchCategories, fetchTransactions } = useAppStore();
  useNotifications();
  useOfflineSync();

  const handleRetry = () => {
    clearError();
    fetchAccounts();
    fetchCategories();
    fetchTransactions();
  };

  return (
    <div className="min-h-screen bg-slate-950 max-w-lg mx-auto relative">
      {error && (
        <div className="sticky top-0 z-40 px-4 py-2.5 bg-expense/10 border-b border-expense/20 flex items-center gap-3">
          <AlertTriangle size={16} className="text-expense flex-shrink-0" />
          <p className="text-xs text-expense flex-1 truncate">{error}</p>
          <button onClick={handleRetry} className="text-expense flex-shrink-0 p-1">
            <RefreshCw size={14} />
          </button>
        </div>
      )}
      <main className="pb-28 px-4 pt-4">
        <Outlet />
      </main>
      <TabBar />
      <ToastContainer />
    </div>
  );
}
