import { BookOpen, PenLine, Search, Sparkles } from 'lucide-react';

interface Suggestion {
  icon: typeof BookOpen;
  title: string;
  hint?: string;
  /** Text prefilled into the composer when the card is picked. */
  prompt: string;
}

const INTERNAL_SUGGESTIONS = [
  {
    icon: BookOpen,
    title: '总结要点',
    hint: '把重点文档浓缩成几条可执行的要点',
    prompt: '把重点文档浓缩成几条可执行的要点：',
  },
  {
    icon: Search,
    title: '调研一个主题',
    hint: '检索资料并给出带来源引用的结论',
    prompt: '调研这个主题，并给出带来源引用的结论：',
  },
  {
    icon: PenLine,
    title: '起草一篇文章',
    hint: '基于所选资料生成草稿，保存到指定空间',
    prompt: '基于所选资料起草一篇文章，先给出大纲：',
  },
  {
    icon: Sparkles,
    title: '问一个流程问题',
    hint: '例如：这个流程的负责人是谁？',
    prompt: '这个流程的负责人是谁？',
  },
] as const satisfies readonly Suggestion[];

/**
 * Chat-first empty state: greeting plus suggestion cards. Picking a card prefills the
 * composer (never sends directly), so the user always reviews the wording first.
 */
export function AssistantEmpty({
  mode,
  welcome,
  suggested,
  onPick,
}: {
  mode: 'internal' | 'public';
  welcome?: string;
  suggested?: readonly string[];
  onPick: (prompt: string) => void;
}) {
  const greeting =
    welcome ??
    (mode === 'public'
      ? '向知识库提问。回答只基于站点批准的资料，并标注引用来源。'
      : '问答开始，创作收尾。同一个对话里查资料、做调研、写文章；创建草稿与写入正文永远由你确认。');
  const cards: Suggestion[] =
    mode === 'internal' && !suggested?.length
      ? [...INTERNAL_SUGGESTIONS]
      : (suggested ?? []).map((question) => ({
          icon: Sparkles,
          title: question,
          prompt: question,
        }));
  return (
    <div className="assistant-empty">
      <span className="assistant-empty__tile" aria-hidden="true">
        <Sparkles className="size-6" />
      </span>
      <p className="assistant-empty__greeting">{greeting}</p>
      {cards.length > 0 && (
        <div className="assistant-sug-grid">
          {cards.map((card) => (
            <button
              key={card.prompt}
              type="button"
              className="assistant-sug-card"
              onClick={() => onPick(card.prompt)}
            >
              <span className="assistant-sug-card__icon" aria-hidden="true">
                <card.icon className="size-4" />
              </span>
              <span className="assistant-sug-card__body">
                <span className="assistant-sug-card__title">{card.title}</span>
                {card.hint && <span className="assistant-sug-card__hint">{card.hint}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
