import { useEffect, useState } from 'react';
import { apiBaseUrl } from '../../api/transport';
import { AssistantChat } from '../assistant/assistant-chat';
import {
  publicTransport,
  type ConversationTransport,
} from '../../components/chat/conversation-transport';

interface Shell {
  id: string;
  slug: string;
  name: string;
  description: string;
  welcome: string;
  suggestedQuestions: string[];
  accessMode: 'public' | 'code';
  revision: number;
}

/** /ask/$slug — public knowledge Q&A restricted to the site's approved documents. */
export function PublicAskPage({ slug }: { slug: string }) {
  const [shell, setShell] = useState<Shell | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [transport, setTransport] = useState<ConversationTransport | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const response = await fetch(
        `${apiBaseUrl}/api/public/qa-sites/by-slug/${encodeURIComponent(slug)}`,
        { credentials: 'include' },
      );
      if (!response.ok) {
        setError(response.status === 404 ? '站点不存在或已下线。' : '站点当前不可访问。');
        return;
      }
      const value = (await response.json()) as Shell;
      setShell(value);
      if (value.accessMode === 'public') await enter(value.id, '');
    })();
  }, [slug]);

  async function enter(siteId: string, accessCode: string) {
    setError(null);
    const response = await fetch(`${apiBaseUrl}/api/public/qa-sites/${siteId}/visitor-session`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(accessCode ? { accessCode } : {}),
    });
    if (!response.ok) {
      setError(response.status === 401 ? '访问码不正确。' : '无法建立访客会话。');
      return;
    }
    const next = publicTransport(siteId);
    setTransport(next);
    // Reuse the most recent active visitor conversation.
    const listResponse = await fetch(`${next.base}/conversations`, { credentials: 'include' });
    if (listResponse.ok) {
      const list = (await listResponse.json()) as { id: string; status: string }[];
      const active = list.find((conversation) => conversation.status === 'active');
      if (active) setConversationId(active.id);
    }
  }

  if (error && !shell)
    return (
      <main className="ask-root">
        <p className="ask-error">{error}</p>
      </main>
    );
  if (!shell)
    return (
      <main className="ask-root" role="status">
        正在载入站点…
      </main>
    );
  if (!transport)
    return (
      <main className="ask-root">
        <h1>{shell.name}</h1>
        {shell.description ? <p>{shell.description}</p> : null}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void enter(shell.id, code);
          }}
        >
          {shell.accessMode === 'code' && (
            <label>
              访问码
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                type="password"
                autoComplete="off"
              />
            </label>
          )}
          <button type="submit">开始提问</button>
          {error ? <p className="ask-error">{error}</p> : null}
        </form>
      </main>
    );
  return (
    <main className="ask-root ask-chat">
      <div className="flex items-center justify-between">
        <h1>{shell.name}</h1>
        <button type="button" className="text-sm underline" onClick={() => setConversationId(null)}>
          新对话
        </button>
      </div>
      <AssistantChat
        key={`public:${shell.id}:${conversationId ?? 'new'}`}
        transport={transport}
        mode="public"
        scopeKey={['public', shell.id]}
        welcome={shell.welcome || undefined}
        suggested={shell.suggestedQuestions}
        initialConversationId={conversationId}
      />
    </main>
  );
}
