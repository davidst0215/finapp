// node --experimental-strip-types --test apps/web/tests/google/lima.test.ts
// (fuera de src/ a propósito: tsc de la web no incluye tipos de Node)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, chipLabel, dayHeading, dayKeys, durationLabel, limaDateKey, limaHM, minutesOf, shortHM, weekdayOf, whenLabel } from '../../src/components/google/lima.ts';

const LUNES_8AM = new Date('2026-10-05T13:00:00Z'); // lunes 5 oct 2026, 08:00 en Lima

describe('hora de Lima en la UI', () => {
  it('el día cambia a las 05:00 UTC', () => {
    assert.equal(limaDateKey(new Date('2026-10-05T04:59:59Z')), '2026-10-04');
    assert.equal(limaDateKey(new Date('2026-10-05T05:00:00Z')), '2026-10-05');
    assert.equal(limaDateKey(new Date('2026-10-06T02:00:00Z')), '2026-10-05');
  });

  it('hora en 24 h, con cero a la izquierda y sin "24:xx" a medianoche', () => {
    assert.equal(limaHM(LUNES_8AM), '08:00');
    assert.equal(limaHM(new Date('2026-10-05T05:05:00Z')), '00:05');
    assert.equal(limaHM(new Date('2026-10-06T04:59:00Z')), '23:59');
  });

  it('suma días con cambio de mes y año', () => {
    assert.equal(addDays('2026-10-31', 1), '2026-11-01');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
    assert.deepEqual(dayKeys('2026-10-04', 3), ['2026-10-04', '2026-10-05', '2026-10-06']);
  });

  it('día de la semana y etiquetas', () => {
    assert.equal(weekdayOf('2026-10-05'), 1);
    assert.equal(chipLabel('2026-10-04'), 'Dom 4');
    assert.equal(chipLabel('2026-10-07'), 'Mié 7');
    assert.equal(dayHeading('2026-10-05', '2026-10-05'), 'Lunes 5 de octubre');
    assert.equal(dayHeading('2027-01-01', '2026-12-30'), 'Viernes 1 de enero de 2027');
  });

  it('formatos cortos', () => {
    assert.equal(shortHM('09:00'), '9:00');
    assert.equal(shortHM('11:30'), '11:30');
    assert.equal(shortHM('00:15'), '0:15');
    assert.equal(minutesOf('13:45'), 13 * 60 + 45);
    assert.equal(durationLabel(30), '30 min');
    assert.equal(durationLabel(60), '1 h');
    assert.equal(durationLabel(90), '1 h 30');
  });

  it('cuándo llegó un correo: hoy, ayer o fecha', () => {
    assert.equal(whenLabel('2026-10-05T18:12:00Z', LUNES_8AM), 'hoy 13:12');
    assert.equal(whenLabel('2026-10-05T03:14:00Z', LUNES_8AM), 'ayer 22:14'); // 22:14 del domingo en Lima
    assert.equal(whenLabel('2026-10-01T15:00:00Z', LUNES_8AM), 'jue 1 oct');
    assert.equal(whenLabel('basura', LUNES_8AM), '');
  });
});
