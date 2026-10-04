import { useId, useMemo, type ReactNode } from 'react';
import { Sheet } from './Sheet';
import { sectionize } from './format';
import type { Destination, VaultTask } from './types';

interface MoveSheetProps {
  /** La tarea a mover; con `null` la hoja está cerrada. */
  task: VaultTask | null;
  destinations: readonly Destination[];
  onClose: () => void;
  onPick: (task: VaultTask, destination: Destination) => void;
}

interface DestinationButtonProps {
  task: VaultTask;
  destination: Destination;
  name: string;
  onPick: (task: VaultTask, destination: Destination) => void;
}

function DestinationButton({ task, destination, name, onPick }: DestinationButtonProps) {
  const here = destination.folder === task.folder;
  const suggested = destination.folder === task.suggest;
  return (
    <button
      type="button"
      disabled={here}
      onClick={() => onPick(task, destination)}
      className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-[15px] transition-colors hover:bg-slate-800 active:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-300 disabled:opacity-50 disabled:hover:bg-transparent"
    >
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {suggested && (
        <span className="shrink-0 rounded-full border border-slate-600 px-2 py-0.5 text-[13px] font-bold text-slate-200">
          Sugerida
        </span>
      )}
      {here && <span className="shrink-0 text-[13px] font-semibold text-slate-400">Aquí</span>}
    </button>
  );
}

function SectionList({ project, children }: { project: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <li className="pt-2">
      <div role="group" aria-labelledby={headingId}>
        <p id={headingId} className="px-3 pb-0.5 pt-1 text-[13px] font-semibold text-slate-400">
          {project}
        </p>
        <ul className="pl-3">{children}</ul>
      </div>
    </li>
  );
}

/** Hoja "Mover a…": destinos agrupados por proyecto, con la sugerida marcada. El cajón no se ofrece. */
export function MoveSheet({ task, destinations, onClose, onPick }: MoveSheetProps) {
  const sections = useMemo(() => sectionize(destinations.filter((d) => d.scope !== 'cajon')), [destinations]);

  return (
    <Sheet
      open={task !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Mover a…"
      description={task?.text ?? ''}
    >
      {task && (
        <ul className="-mx-1">
          {sections.map((section) =>
            section.flat ? (
              section.items.map((destination) => (
                <li key={destination.folder}>
                  <DestinationButton task={task} destination={destination} name={section.project} onPick={onPick} />
                </li>
              ))
            ) : (
              <SectionList key={section.project} project={section.project}>
                {section.items.map((destination) => (
                  <li key={destination.folder}>
                    <DestinationButton
                      task={task}
                      destination={destination}
                      name={destination.frente ?? 'General'}
                      onPick={onPick}
                    />
                  </li>
                ))}
              </SectionList>
            ),
          )}
        </ul>
      )}
    </Sheet>
  );
}
