import { Outlet } from 'react-router-dom';
import { BottomNav } from './BottomNav';

export function AppShell() {
  return (
    <div className="min-h-screen bg-slate-950 max-w-lg mx-auto relative">
      <main className="pb-20 px-4 pt-4">
        <Outlet />
      </main>
      <BottomNav />
    </div>
  );
}
