// node --experimental-strip-types --test apps/web/tests/google/mailModel.test.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canSend, countLabel, dotKind, gmailDraftsUrl, gmailThreadUrl, rowTitle, senderName, upsertDraft, withoutDraft } from '../../src/components/correo/mailModel.ts';
import type { DraftItem } from '../../src/components/google/types.ts';

const draft = (id: string, over: Partial<DraftItem> = {}): DraftItem => ({
  draft_id: id, message_id: `m-${id}`, thread_id: 't', to: 'Mónica', to_email: 'monica@tdv.com', subject: 'Re: Informe 03', body: 'hola', snippet: 'hola',
  updated_at: '2026-10-05T14:00:00.000Z', editable: true, ...over,
});

describe('filas de correo', () => {
  it('título: remitente — asunto; sin nombre usa el correo', () => {
    assert.equal(rowTitle({ from_name: 'BCP', from_email: 'alertas@bcp.com.pe', subject: 'Cargo no reconocido' }), 'BCP — Cargo no reconocido');
    assert.equal(senderName({ from_name: '', from_email: 'x@y.co' }), 'x@y.co');
  });

  it('el punto: la alarma manda sobre sin leer', () => {
    assert.equal(dotKind({ alarm: true, unread: true }), 'alarm');
    assert.equal(dotKind({ alarm: false, unread: true }), 'unread');
    assert.equal(dotKind({ alarm: false, unread: false }), 'read');
  });

  it('contador: marca "+" cuando la lista llegó al límite', () => {
    assert.equal(countLabel(3, 10), '3');
    assert.equal(countLabel(0, 10), '0');
    assert.equal(countLabel(10, 10), '10+');
  });
});

describe('enlaces y borradores', () => {
  it('enlaces a Gmail con la cuenta conectada, codificados', () => {
    assert.equal(gmailThreadUrl('david@sayainvestments.co', '18c2f'), 'https://mail.google.com/mail/?authuser=david%40sayainvestments.co#all/18c2f');
    assert.equal(gmailDraftsUrl('david@sayainvestments.co'), 'https://mail.google.com/mail/?authuser=david%40sayainvestments.co#drafts');
    assert.ok(!gmailThreadUrl('a@b.co', 'x"><script>').includes('<'));
  });

  it('solo se envía con destinatario', () => {
    assert.equal(canSend(draft('a')), true);
    assert.equal(canSend(draft('a', { to_email: '' })), false);
    assert.equal(canSend(draft('a', { to_email: '  ' })), false);
  });

  it('quita y reemplaza borradores sin tocar el resto', () => {
    const list = [draft('a'), draft('b')];
    assert.deepEqual(withoutDraft(list, 'a').map((d) => d.draft_id), ['b']);
    assert.deepEqual(withoutDraft(list, 'zzz').map((d) => d.draft_id), ['a', 'b']);
    assert.deepEqual(upsertDraft(list, draft('b', { body: 'nuevo' })).map((d) => [d.draft_id, d.body]), [['a', 'hola'], ['b', 'nuevo']]);
    assert.deepEqual(upsertDraft(list, draft('c')).map((d) => d.draft_id), ['c', 'a', 'b']);
  });
});
