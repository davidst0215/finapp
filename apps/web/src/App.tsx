import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { AppShell } from '@/components/layout/AppShell';
import { AuthPage } from '@/routes/Auth';
import { DashboardPage } from '@/routes/Dashboard';
import { TransactionsPage } from '@/routes/Transactions';
import { AddTransactionPage } from '@/routes/AddTransaction';
import { AccountsPage } from '@/routes/Accounts';
import { MorePage } from '@/routes/More';
import { BudgetsPage } from '@/routes/Budgets';
import { SavingsGoalsPage } from '@/routes/SavingsGoals';
import { RecurringPage } from '@/routes/Recurring';
import { AlertsPage } from '@/routes/Alerts';
import { AiChatPage } from '@/routes/AiChat';
import { ReportsPage } from '@/routes/Reports';
import { CalendarPage } from '@/routes/CalendarPage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading, initialized } = useAuthStore();

  if (!initialized || loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="w-8 h-8 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!user) return <Navigate to="/auth" replace />;
  return <>{children}</>;
}

export default function App() {
  const initialize = useAuthStore(s => s.initialize);

  useEffect(() => {
    initialize();
  }, [initialize]);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/auth" element={<AuthPage />} />
        <Route
          element={
            <ProtectedRoute>
              <AppShell />
            </ProtectedRoute>
          }
        >
          <Route path="/" element={<AddTransactionPage />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/transactions" element={<TransactionsPage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/more" element={<MorePage />} />
          <Route path="/budgets" element={<BudgetsPage />} />
          <Route path="/goals" element={<SavingsGoalsPage />} />
          <Route path="/recurring" element={<RecurringPage />} />
          <Route path="/alerts" element={<AlertsPage />} />
          <Route path="/ai-chat" element={<AiChatPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/calendar" element={<CalendarPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
