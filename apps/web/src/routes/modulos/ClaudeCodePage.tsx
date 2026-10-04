import { useMemo, useState } from 'react';
import { Terminal, TriangleAlert } from 'lucide-react';
import { Spinner } from '@/components/ui/Spinner';
import { LaptopsCard } from '@/components/claude/LaptopsCard';
import { PairDevicePanel } from '@/components/claude/PairDevicePanel';
import { PermissionCard } from '@/components/claude/PermissionCard';
import { RecentApprovals } from '@/components/claude/RecentApprovals';
import { SessionsCard } from '@/components/claude/SessionsCard';
import { timeAgo } from '@/components/claude/format';
import type { DeviceView } from '@/components/claude/types';
import { useClaudeOverview } from '@/components/claude/useClaudeOverview';
import { useNow } from '@/components/claude/useTick';

// "Mi laptop · última señal hace 3 min": sin latido, "conectada" sería una afirmación que no podemos verificar.
function statusLine(devices: DeviceView[], now: number): string {
  if (devices.length === 0) return 'Sin laptop conectada';
  const label = devices.length === 1 ? (devices[0]?.name ?? 'Laptop') : `${devices.length} laptops`;
  const seen = devices.flatMap((d) => (d.last_seen_at ? [d.last_seen_at] : [])).sort().pop();
  return seen ? `${label} · última señal ${timeAgo(seen, now)}` : `${label} · esperando la primera señal`;
}

export function ClaudeCodePage() {
  const { overview, fetchedAt, error, loading, refresh, decide, setApprovals, revoke, pair } = useClaudeOverview();
  const [connecting, setConnecting] = useState(false);
  const now = useNow(30_000);

  const pendingBySession = useMemo(() => new Map((overview?.pending ?? []).map((a) => [a.session_id, a])), [overview]);

  const devices = overview?.devices ?? [];
  const pending = overview?.pending ?? [];

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">Claude Code</h1>
        <p className="text-sm text-slate-400">{overview ? statusLine(devices, now) : 'Cargando…'}</p>
      </header>

      {error && (
        <div role="alert" className="card flex items-center gap-3 border-expense/50">
          <TriangleAlert size={20} strokeWidth={1.7} className="flex-shrink-0 text-expense" aria-hidden="true" />
          <p className="min-w-0 flex-1 text-sm text-expense">{error}</p>
          <button
            type="button"
            onClick={() => void refresh()}
            className="min-h-[44px] flex-shrink-0 rounded-xl px-3 text-sm font-semibold text-slate-100 active:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
          >
            Reintentar
          </button>
        </div>
      )}

      {loading && !overview && <Spinner />}

      {pending.length > 0 && (
        <section aria-label="Permisos pendientes" aria-live="polite" className="space-y-3">
          {pending.map((a) => (
            <PermissionCard key={a.id} approval={a} fetchedAt={fetchedAt} onDecide={decide} />
          ))}
        </section>
      )}

      {connecting && <PairDevicePanel onPair={pair} onClose={() => setConnecting(false)} />}

      {overview && devices.length === 0 && !connecting && (
        <section className="card space-y-4">
          <div className="flex items-start gap-3">
            <Terminal size={22} strokeWidth={1.7} className="mt-0.5 flex-shrink-0 text-slate-200" aria-hidden="true" />
            <div className="space-y-1">
              <h2 className="text-base font-bold text-slate-100">Conecta tu laptop</h2>
              <p className="text-sm text-slate-300">
                Verás tus sesiones de Claude Code desde el celular y podrás aprobar permisos cuando te alejes. Todo va de tu laptop a tu
                cuenta de Wabid: nada pasa por claude.ai.
              </p>
            </div>
          </div>
          <button type="button" onClick={() => setConnecting(true)} className="btn-primary min-h-[48px] w-full">
            Conectar esta laptop
          </button>
        </section>
      )}

      {devices.length > 0 && (
        <>
          <LaptopsCard
            devices={devices}
            now={now}
            onToggleApprovals={(id, enabled) => void setApprovals(id, enabled)}
            onRevoke={(id) => void revoke(id)}
            onConnect={() => setConnecting(true)}
          />
          <SessionsCard sessions={overview?.sessions ?? []} pendingBySession={pendingBySession} now={now} />
          <RecentApprovals approvals={overview?.recent ?? []} now={now} />
        </>
      )}
    </div>
  );
}
