import { Chip } from '../tareas/Chip';
import type { ClienteChip } from '../tareas/types';

interface ClienteChipsProps {
  clientes: readonly ClienteChip[];
  selected: string | null;
  onSelect: (cliente: string | null) => void;
}

/**
 * "Todo" y un chip por cliente, en una sola línea que se desplaza. El último chip asoma cortado a propósito:
 * es la pista de que hay más. El relleno vertical deja sitio a la zona táctil de 44 px de cada chip.
 */
export function ClienteChips({ clientes, selected, onSelect }: ClienteChipsProps) {
  return (
    <div role="group" aria-label="Filtrar por cliente" className="no-scrollbar -mx-4 overflow-x-auto">
      <div className="flex w-max gap-2 px-4 py-1.5">
        <Chip on={selected === null} aria-pressed={selected === null} onClick={() => onSelect(null)}>
          Todo
        </Chip>
        {clientes.map((item) => (
          <Chip
            key={item.cliente}
            on={selected === item.cliente}
            aria-pressed={selected === item.cliente}
            aria-label={`${item.cliente}, ${item.count} ${item.count === 1 ? 'documento' : 'documentos'}`}
            onClick={() => onSelect(item.cliente)}
          >
            {item.cliente}
          </Chip>
        ))}
      </div>
    </div>
  );
}
