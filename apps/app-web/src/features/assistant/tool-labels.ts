/**
 * Chinese labels for tool names streamed by the assistant plugins. One source of truth
 * for the live tool-step rows; unknown names degrade honestly to "执行 <name>".
 * Names mirror packages/ai-plugins (rag / writing / research / image / scope installs).
 */
const TOOL_LABELS = {
  answer_with_citations: '组织带引用的回答',
  search_platform: '检索知识库',
  read_platform_source: '阅读来源',
  compose_document: '起草新内容',
  continue_document: '续写文档',
  rewrite_paragraph: '改写段落',
  rewrite_document: '整篇改写',
  summarize_document: '生成摘要',
  translate_paragraph: '翻译段落',
  research_document: '基于资料撰写',
  draft_document: '起草草稿文档',
  web_search: '联网搜索',
  read_web_source: '阅读网页来源',
  create_image: '生成图片',
  set_conversation_scope: '调整资料范围',
} as const satisfies Record<string, string>;

export function toolLabel(name: string): string {
  const known: Partial<Record<string, string>> = TOOL_LABELS;
  return known[name] ?? `执行 ${name}`;
}
