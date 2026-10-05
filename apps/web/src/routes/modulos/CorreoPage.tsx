import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useCachedState } from '@/lib/moduleCache';
import { cn } from '@/lib/utils';
import { useToastStore } from '@/stores/toastStore';
import { DraftCard } from '@/components/correo/DraftCard';
import { MailRow } from '@/components/correo/MailRow';
import { MailTabs } from '@/components/correo/MailTabs';
import { countLabel, DRAFT_LIMIT, MAIL_LIMIT, upsertDraft, withoutDraft, type TabId } from '@/components/correo/mailModel';
import { ConnectGoogle } from '@/components/google/ConnectGoogle';
import { ErrorCard, RowsSkeleton } from '@/components/google/Feedback';
import { GoogleAccountFooter } from '@/components/google/GoogleAccountFooter';
import { googleCall, GoogleUiError, needsConnection } from '@/components/google/googleApi';
import type { DraftItem, MailItem } from '@/components/google/types';
import { iconButton } from '@/components/google/ui';
import { useGoogleStatus } from '@/components/google/useGoogleStatus';

type Mail = { important: MailItem[]; rest: MailItem[] };
const STALE_MS = 2 * 60_000;

const errorMessage = (e: unknown, fallback: string) => (e instanceof GoogleUiError ? e.message : fallback);

export function CorreoPage() {
  const addToast = useToastStore((s) => s.addToast);
  const { loading, status, error: statusError, reload: reloadStatus } = useGoogleStatus();

  const [tab, setTab] = useState<TabId>('importantes');
  const [mail, setMail] = useCachedState<Mail>('correo.mail');
  const [mailError, setMailError] = useState<string | null>(null);
  const [drafts, setDrafts] = useCachedState<DraftItem[]>('correo.drafts');
  const [draftsError, setDraftsError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const caps = status?.account?.capabilities;
  const connected = status?.connected === true;
  const canRead = connected && caps?.gmail_read === true;
  const canCompose = caps?.gmail_compose === true;
  const account = status?.account?.email ?? '';

  const latest = useRef(0);
  const loadedAt = useRef(0);
  const load = useCallback(async () => {
    const id = ++latest.current;
    setRefreshing(true);
    const [m, d] = await Promise.allSettled([
      googleCall<Mail>('mail.important', { max: MAIL_LIMIT, rest: true }),
      googleCall<{ drafts: DraftItem[] }>('mail.drafts', { max: DRAFT_LIMIT }),
    ]);
    if (id !== latest.current) return; // llegó una carga más nueva
    loadedAt.current = Date.now();

    if (m.status === 'fulfilled') {
      setMail(m.value);
      setMailError(null);
    } else if (needsConnection(m.reason)) {
      void reloadStatus();
    } else {
      setMailError(errorMessage(m.reason, 'No pude leer tu correo.'));
    }
    if (d.status === 'fulfilled') {
      setDrafts(d.value.drafts);
      setDraftsError(null);
    } else if (needsConnection(d.reason)) {
      void reloadStatus();
    } else {
      setDraftsError(errorMessage(d.reason, 'No pude leer tus borradores.'));
    }
    setRefreshing(false);
  }, [reloadStatus]);

  useEffect(() => {
    if (canRead) void load();
  }, [canRead, load]);

  // Al volver a la app después de un rato, la bandeja se actualiza sola.
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    refresh.current = () => void load();
  }, [load]);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - loadedAt.current > STALE_MS) refresh.current();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  const counts = useMemo<Record<TabId, string | null>>(
    () => ({
      importantes: mail ? countLabel(mail.important.length, MAIL_LIMIT) : null,
      borradores: drafts ? countLabel(drafts.length, DRAFT_LIMIT) : null,
      resto: mail ? countLabel(mail.rest.length, MAIL_LIMIT) : null,
    }),
    [mail, drafts],
  );

  const toggleRow = (id: string) => setOpenId((cur) => (cur === id ? null : id));

  const onDraftCreated = (draft: DraftItem) => {
    setDrafts((cur) => upsertDraft(cur ?? [], draft));
    setOpenId(null);
    setTab('borradores');
    addToast(draft.notice ?? 'Borrador listo. Revísalo y envíalo cuando quieras.', draft.notice ? 'warning' : 'success');
  };

  const mailList = (items: MailItem[], empty: { title: string; hint: string }) =>
    mailError ? (
      <ErrorCard message={mailError} onRetry={() => void load()} />
    ) : mail === null ? (
      <RowsSkeleton rows={4} label="Cargando correo" />
    ) : items.length === 0 ? (
      <div className="card space-y-2 py-8 text-center">
        <p className="text-lg font-bold text-slate-100">{empty.title}</p>
        <p className="mx-auto max-w-[32ch] text-base text-slate-400">{empty.hint}</p>
      </div>
    ) : (
      <ul className="card !py-1" aria-label="Correos">
        {items.map((item) => (
          <MailRow
            key={item.id}
            item={item}
            account={account}
            open={openId === item.id}
            canCompose={canCompose}
            onToggle={() => toggleRow(item.id)}
            onDraft={onDraftCreated}
            onNeedsConnection={() => void reloadStatus()}
          />
        ))}
      </ul>
    );

  const draftList =
    draftsError ? (
      <ErrorCard message={draftsError} onRetry={() => void load()} />
    ) : drafts === null ? (
      <RowsSkeleton rows={2} label="Cargando borradores" />
    ) : drafts.length === 0 ? (
      <div className="card space-y-2 py-8 text-center">
        <p className="text-lg font-bold text-slate-100">Sin borradores</p>
        <p className="mx-auto max-w-[32ch] text-base text-slate-400">Dile a Wabid «respóndele a Mónica que le paso las cifras hoy» y lo dejo aquí para que lo apruebes.</p>
      </div>
    ) : (
      <div className="space-y-3">
        {drafts.map((d) => (
          <DraftCard
            key={d.draft_id}
            draft={d}
            account={account}
            canCompose={canCompose}
            onChanged={(updated) => setDrafts((cur) => upsertDraft(cur ?? [], updated))}
            onSent={(sent) => setDrafts((cur) => withoutDraft(cur ?? [], sent.draft_id))}
            onStale={() => void load()}
            onNeedsConnection={() => void reloadStatus()}
          />
        ))}
      </div>
    );

  let body: React.ReactNode;
  if (loading) {
    body = <RowsSkeleton rows={4} label="Cargando tu correo" />;
  } else if (statusError) {
    body = <ErrorCard message={statusError} onRetry={() => void reloadStatus()} />;
  } else if (!connected) {
    body = <ConnectGoogle variant={status?.reauth ? 'reauth' : 'connect'} email={status?.account?.email} need="correo" />;
  } else if (!canRead) {
    body = <ConnectGoogle variant="permission" need="correo" />;
  } else {
    body = (
      <>
        <MailTabs value={tab} onChange={(t) => { setTab(t); setOpenId(null); }} counts={counts} />
        <div role="tabpanel" id="panel-importantes" aria-labelledby="tab-importantes" hidden={tab !== 'importantes'}>
          {tab === 'importantes' && mailList(mail?.important ?? [], { title: 'Nada importante', hint: 'No hay correos importantes de los últimos 7 días. Cuando llegue uno, aparece aquí.' })}
        </div>
        <div role="tabpanel" id="panel-borradores" aria-labelledby="tab-borradores" hidden={tab !== 'borradores'}>
          {tab === 'borradores' && draftList}
        </div>
        <div role="tabpanel" id="panel-resto" aria-labelledby="tab-resto" hidden={tab !== 'resto'}>
          {tab === 'resto' && mailList(mail?.rest ?? [], { title: 'Bandeja al día', hint: 'No hay más correos de los últimos 7 días.' })}
        </div>
      </>
    );
  }

  return (
    <div className="space-y-4">
      <header className="flex min-h-[44px] items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-slate-100">Correo</h1>
        {canRead && (
          <button type="button" onClick={() => void load()} disabled={refreshing} aria-label={refreshing ? 'Actualizando correo' : 'Actualizar correo'} className={iconButton}>
            <RefreshCw size={19} strokeWidth={1.8} aria-hidden="true" className={cn(refreshing && 'motion-safe:animate-spin')} />
          </button>
        )}
      </header>

      {body}

      {connected && status?.account && (
        <GoogleAccountFooter
          email={status.account.email}
          onDisconnected={() => {
            setMail(null);
            setDrafts(null);
            void reloadStatus();
          }}
        />
      )}
    </div>
  );
}
