import { Sun } from 'lucide-react';
import { ModulePlaceholder } from '@/components/ui/ModulePlaceholder';

export function BriefPage() {
  return <ModulePlaceholder icon={Sun} title="Brief del día" description="Tu resumen de las 7:00: agenda, vencidas, pagos y esperas." />;
}
