import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ConversationList } from '@/components/claude/ConversationList';
import { SessionChat, TaskChat } from '@/components/claude/ConversationView';
import { NewTaskScreen } from '@/components/claude/NewTaskScreen';
import { SettingsSheet } from '@/components/claude/SettingsSheet';
import { POLL_MS, useClaudeOverview, type ClaudeOverviewApi } from '@/components/claude/useClaudeOverview';

// Claude Code como app de chat. Cada pantalla es una ruta, así el botón atrás del celular hace lo esperable:
//   /claude              lista de conversaciones (cada sesión es un chat)
//   /claude/s/:id        conversación de una sesión
//   /claude/t/:id        tarea lanzada desde el celular que aún no abre sesión
//   /claude/nueva        nueva tarea (= nuevo chat)
//   /claude/ajustes      hoja de ajustes sobre la lista (laptops, modo ausente, permisos recientes)
export function ClaudeCodePage() {
  const { pathname } = useLocation();
  // Dentro de una conversación ya hay un sondeo propio de la línea de tiempo: la vista general baja el ritmo.
  const inChat = /^\/claude\/(s|t)\//.test(pathname);
  const api = useClaudeOverview(inChat ? POLL_MS * 2 : POLL_MS);

  return (
    <Routes>
      <Route index element={<List api={api} />} />
      <Route path="ajustes" element={<List api={api} settings />} />
      <Route path="nueva" element={<NewTaskScreen api={api} />} />
      <Route path="s/:sessionId" element={<SessionRoute api={api} />} />
      <Route path="t/:taskId" element={<TaskRoute api={api} />} />
      <Route path="*" element={<Navigate to="/claude" replace />} />
    </Routes>
  );
}

function List({ api, settings = false }: { api: ClaudeOverviewApi; settings?: boolean }) {
  const navigate = useNavigate();
  const close = () => (window.history.state && window.history.state.idx > 0 ? navigate(-1) : navigate('/claude', { replace: true }));
  return (
    <>
      <ConversationList overview={api.overview} loading={api.loading} error={api.error} onRetry={() => void api.refresh()} />
      {settings && <SettingsSheet api={api} onClose={close} />}
    </>
  );
}

function SessionRoute({ api }: { api: ClaudeOverviewApi }) {
  const { sessionId = '' } = useParams();
  // key: al pasar de una conversación a otra no se arrastra el estado (scroll, borradores, mensajes locales).
  return <SessionChat key={sessionId} sessionId={sessionId} api={api} />;
}

function TaskRoute({ api }: { api: ClaudeOverviewApi }) {
  const { taskId = '' } = useParams();
  return <TaskChat key={taskId} taskId={taskId} api={api} />;
}
