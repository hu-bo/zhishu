import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { createLowlight } from "lowlight";
import type { LanguageFn } from "lowlight";

interface HighlightTextNode {
  type: "text";
  value: string;
}

interface HighlightElementNode {
  type: "element";
  properties?: { className?: string[] };
  children: HighlightNode[];
}

type HighlightNode = HighlightTextNode | HighlightElementNode;

interface HighlightToken {
  text: string;
  classes: string[];
}

interface CodeHighlightState {
  decorations: DecorationSet;
  languages: readonly string[];
}

type LanguageLoader = () => Promise<LanguageFn>;

const lowlight = createLowlight();
const languageLoads = new Map<string, Promise<boolean>>();
const failedLanguageLoads = new Set<string>();

const languageLoaders: Readonly<Record<string, LanguageLoader>> = {
  bash: async () => (await import("highlight.js/lib/languages/bash")).default,
  css: async () => (await import("highlight.js/lib/languages/css")).default,
  go: async () => (await import("highlight.js/lib/languages/go")).default,
  java: async () => (await import("highlight.js/lib/languages/java")).default,
  javascript: async () => (await import("highlight.js/lib/languages/javascript")).default,
  json: async () => (await import("highlight.js/lib/languages/json")).default,
  markdown: async () => (await import("highlight.js/lib/languages/markdown")).default,
  python: async () => (await import("highlight.js/lib/languages/python")).default,
  rust: async () => (await import("highlight.js/lib/languages/rust")).default,
  sql: async () => (await import("highlight.js/lib/languages/sql")).default,
  typescript: async () => (await import("highlight.js/lib/languages/typescript")).default,
  xml: async () => (await import("highlight.js/lib/languages/xml")).default,
  yaml: async () => (await import("highlight.js/lib/languages/yaml")).default,
};

const languageAliases: Readonly<Record<string, string>> = {
  htm: "xml",
  html: "xml",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  sh: "bash",
  shell: "bash",
  ts: "typescript",
  tsx: "typescript",
};

const aliasesByLanguage: Readonly<Record<string, readonly string[]>> = {
  bash: ["sh", "shell"],
  javascript: ["js", "jsx"],
  python: ["py"],
  typescript: ["ts", "tsx"],
  xml: ["html", "htm"],
};

const codeHighlightKey = new PluginKey<CodeHighlightState>("zhishu-code-block-highlighting");
const refreshHighlightMeta = "refresh";

function canonicalLanguage(language: string): string {
  const normalized = language.trim().toLowerCase();
  return languageAliases[normalized] ?? normalized;
}

function flattenHighlightNodes(
  nodes: readonly HighlightNode[],
  parentClasses: readonly string[] = [],
): HighlightToken[] {
  const tokens: HighlightToken[] = [];
  for (const node of nodes) {
    if (node.type === "text") {
      if (node.value.length > 0) tokens.push({ text: node.value, classes: [...parentClasses] });
      continue;
    }
    const classes = [...parentClasses, ...(node.properties?.className ?? [])];
    tokens.push(...flattenHighlightNodes(node.children, classes));
  }
  return tokens;
}

function createCodeHighlightState(document: ProseMirrorNode): CodeHighlightState {
  const decorations: Decoration[] = [];
  const languages = new Set<string>();

  document.descendants((node, position) => {
    if (node.type.name !== "codeBlock") return;
    const rawLanguage = node.attrs.language;
    const language = typeof rawLanguage === "string" ? canonicalLanguage(rawLanguage) : "";
    if (!language) return;
    languages.add(language);
    if (!lowlight.registered(language)) return;

    let offset = position + 1;
    let highlighted: ReturnType<typeof lowlight.highlight>;
    try {
      highlighted = lowlight.highlight(language, node.textContent);
    } catch {
      return;
    }
    for (const token of flattenHighlightNodes(highlighted.children as HighlightNode[])) {
      const end = offset + token.text.length;
      if (token.classes.length > 0 && end > offset) {
        decorations.push(
          Decoration.inline(
            offset,
            end,
            { class: token.classes.join(" ") },
            { inclusiveEnd: false },
          ),
        );
      }
      offset = end;
    }
  });

  return { decorations: DecorationSet.create(document, decorations), languages: [...languages] };
}

function loadLanguage(language: string): Promise<boolean> {
  if (lowlight.registered(language)) return Promise.resolve(true);
  const existing = languageLoads.get(language);
  if (existing) return existing;
  const loader = languageLoaders[language];
  if (!loader) return Promise.resolve(false);

  const pending = loader()
    .then((grammar) => {
      lowlight.register(language, grammar);
      const aliases = aliasesByLanguage[language];
      if (aliases) lowlight.registerAlias(language, aliases);
      return true;
    })
    .catch(() => {
      failedLanguageLoads.add(language);
      return false;
    });
  languageLoads.set(language, pending);
  return pending;
}

function requestLanguages(view: EditorView, requested: Set<string>): void {
  const state = codeHighlightKey.getState(view.state);
  if (!state) return;

  for (const language of state.languages) {
    if (
      !languageLoaders[language] ||
      lowlight.registered(language) ||
      failedLanguageLoads.has(language) ||
      requested.has(language)
    ) {
      continue;
    }
    requested.add(language);
    void loadLanguage(language).then((loaded) => {
      requested.delete(language);
      if (loaded && !view.isDestroyed) {
        view.dispatch(view.state.tr.setMeta(codeHighlightKey, refreshHighlightMeta));
      }
    });
  }
}

function createsHighlightPlugin() {
  return new Plugin<CodeHighlightState>({
    key: codeHighlightKey,
    state: {
      init: (_configuration, state) => createCodeHighlightState(state.doc),
      apply: (transaction, previous, _oldState, nextState) => {
        if (
          transaction.docChanged ||
          transaction.getMeta(codeHighlightKey) === refreshHighlightMeta
        ) {
          return createCodeHighlightState(nextState.doc);
        }
        return {
          decorations: previous.decorations.map(transaction.mapping, transaction.doc),
          languages: previous.languages,
        };
      },
    },
    props: {
      decorations: (state) => codeHighlightKey.getState(state)?.decorations ?? null,
    },
    view: (initialView) => {
      let view = initialView;
      const requested = new Set<string>();
      requestLanguages(view, requested);
      return {
        update(nextView) {
          view = nextView;
          requestLanguages(view, requested);
        },
      };
    },
  });
}

export function createCodeBlockHighlightingExtension() {
  return Extension.create({
    name: "zhishuCodeBlockHighlighting",
    addProseMirrorPlugins() {
      return [createsHighlightPlugin()];
    },
  });
}
