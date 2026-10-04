import { CalendarDays } from 'lucide-react';
import { ModulePlaceholder } from '@/components/ui/ModulePlaceholder';

export function AgendaPage() {
  return <ModulePlaceholder icon={CalendarDays} title="Agenda" description="Tu día en Google Calendar, con preparación para cada reunión." />;
}
