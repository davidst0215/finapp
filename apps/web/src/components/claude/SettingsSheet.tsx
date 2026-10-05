import { useEffect, useState } from 'react';
import { Terminal } from 'lucide-react';
import { Sheet } from '@/components/tareas/Sheet';
import { LaptopsCard } from './LaptopsCard';
import { PairDevicePanel } from './PairDevicePanel';
import { RecentApprovals } from './RecentApprovals';
import type { ClaudeOverviewApi } from './useClaudeOverview';
import { useNow } from './useTick';

// Lo que se toca de vez en cuando (emparejar, modo ausente, laptops, permisos pasados) vive en una hoja secundaria para no
// estorbar la lista de conversaciones.
export function SettingsSheet({ api, onClose }: { api: ClaudeOverviewApi; onClose: () => void }) {
  const now = useNow(30_000);
  const devices = api.overview?.devices ?? [];
  const [connecting, setConnecting] = useState(false);

  // Sin laptop, lo único que se puede hacer aquí es conectarla: se abre directo.
  useEffect(() => {
    if (api.overview && devices.length === 0) setConnecting(true);
  }, [api.overview, devices.length]);

  return (
    <Sheet
      open
      onOpenChange={(open) => !open && onClose()}
      title="Ajustes de Claude Code"
      description="Laptops conectadas, modo ausente y permisos recientes"
      hideDescription
    >
      <div className="space-y-5 pb-2">
        {connecting && <PairDevicePanel onPair={api.pair} onClose={() => setConnecting(false)} />}

        {devices.length > 0 ? (
          <LaptopsCard
            devices={devices}
            now={now}
            onToggleApprovals={(id, enabled) => void api.setApprovals(id, enabled)}
            onRevoke={(id) => void api.revoke(id)}
            onConnect={() => setConnecting(true)}
          />
        ) : (
          !connecting && (
            <div className="flex items-start gap-3 rounded-2xl border border-slate-700 bg-slate-800/40 p-4">
              <Terminal size={20} strokeWidth={1.7} className="mt-0.5 flex-shrink-0 text-slate-300" aria-hidden="true" />
              <p className="text-sm text-slate-300">Aún no hay ninguna laptop conectada.</p>
            </div>
          )
        )}

        <RecentApprovals approvals={api.overview?.recent ?? []} now={now} />
      </div>
    </Sheet>
  );
}
