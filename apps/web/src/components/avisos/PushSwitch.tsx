import { canToggle, deviceText, type DeviceBusy, type DevicePhase } from './logic';
import { SwitchRow } from './SwitchRow';

type Props = {
  phase: DevicePhase;
  busy: DeviceBusy;
  error: string | null;
  onToggle: () => void;
};

// Interruptor de los avisos en este dispositivo. Mismo interruptor que los avisos automáticos (SwitchRow).
export function PushSwitch({ phase, busy, error, onToggle }: Props) {
  return (
    <SwitchRow
      title="Avisos en este dispositivo"
      description={deviceText(phase, busy)}
      checked={phase === 'on'}
      disabled={!canToggle(phase, busy)}
      onChange={onToggle}
      error={error}
    />
  );
}
