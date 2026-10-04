import { AlertCircle } from 'lucide-react';
import { Chip } from './Chip';
import { pluralize } from './format';

export interface ScopeFilter {
  trabajo: boolean;
  personal: boolean;
}

interface FilterChipsProps {
  scopes: ScopeFilter;
  onToggleScope: (scope: keyof ScopeFilter) => void;
  overdueOnly: boolean;
  /** Vencidas abiertas; el chip solo aparece si hay (o si el filtro sigue encendido). */
  overdueCount: number;
  onToggleOverdue: () => void;
}

/** Trabajo y Personal se encienden y apagan (al menos uno queda encendido); "N vencidas" deja solo las vencidas. */
export function FilterChips({ scopes, onToggleScope, overdueOnly, overdueCount, onToggleOverdue }: FilterChipsProps) {
  return (
    <div role="group" aria-label="Filtrar tareas" className="flex flex-wrap gap-x-2 gap-y-3">
      <Chip on={scopes.trabajo} aria-pressed={scopes.trabajo} onClick={() => onToggleScope('trabajo')}>
        Trabajo
      </Chip>
      <Chip on={scopes.personal} aria-pressed={scopes.personal} onClick={() => onToggleScope('personal')}>
        Personal
      </Chip>
      {(overdueCount > 0 || overdueOnly) && (
        <Chip
          tone="alert"
          on={overdueOnly}
          aria-pressed={overdueOnly}
          icon={<AlertCircle aria-hidden="true" size={15} />}
          onClick={onToggleOverdue}
        >
          {pluralize(overdueCount, 'vencida', 'vencidas')}
        </Chip>
      )}
    </div>
  );
}
