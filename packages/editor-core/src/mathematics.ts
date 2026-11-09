import { InputRule, PasteRule, type Editor } from "@tiptap/core";
import {
  BlockMath,
  InlineMath,
  Mathematics,
  type MathematicsOptions,
} from "@tiptap/extension-mathematics";
import { NodeSelection, Plugin } from "@tiptap/pm/state";
import { inlineLatexPattern, isValidMathSource } from "@zhishu/document-contracts";
import katex, { type KatexOptions } from "katex";

export type RequestMathSource = (request: {
  kind: "inline" | "block";
  initialSource?: string;
}) => string | null | Promise<string | null>;

export const promptMathSource: RequestMathSource = ({ kind, initialSource }) =>
  window.prompt(
    initialSource !== undefined
      ? "编辑 LaTeX 公式"
      : kind === "inline"
        ? "插入行内 LaTeX 公式"
        : "插入 LaTeX 公式块",
    initialSource ?? "",
  );

// Native MathML works in the editor and in offline HTML exports without font assets.
export const mathRenderOptions = {
  output: "mathml",
  throwOnError: false,
  trust: false,
  maxExpand: 200,
  maxSize: 20,
} satisfies KatexOptions;

export function renderMathToHtml(latex: string, displayMode: boolean): string | null {
  if (!isValidMathSource(latex)) return null;
  try {
    return katex.renderToString(latex, { ...mathRenderOptions, displayMode });
  } catch {
    return null;
  }
}

function acceptFormulaElement(element: HTMLElement): false | null {
  return isValidMathSource(element.getAttribute("data-latex") ?? "") ? null : false;
}

function editFormula(editor: Editor, position: number, requestSource: RequestMathSource): boolean {
  if (!editor.isEditable) return false;
  const node = editor.state.doc.nodeAt(position);
  if (node?.type.name !== "inlineMath" && node?.type.name !== "blockMath") return false;
  const current = String(node.attrs.latex);
  void Promise.resolve()
    .then(() =>
      requestSource({
        kind: node.type.name === "inlineMath" ? "inline" : "block",
        initialSource: current,
      }),
    )
    .then((source) => {
      if (editor.isDestroyed || !editor.isEditable) return;
      const latex = source?.trim();
      if (
        latex &&
        isValidMathSource(latex) &&
        latex !== current &&
        editor.state.doc.nodeAt(position) === node
      ) {
        editor.view.dispatch(editor.state.tr.setNodeAttribute(position, "latex", latex));
      }
      editor.commands.focus();
    })
    .catch(() => {
      if (!editor.isDestroyed) editor.commands.focus();
    });
  return true;
}

export const documentMathematics = Mathematics.extend<
  MathematicsOptions & { requestSource: RequestMathSource }
>({
  addOptions() {
    return { ...this.parent?.(), requestSource: promptMathSource };
  },
  addExtensions() {
    return [
      BlockMath.extend({
        // Block creation goes through the structure action, including in collaborative editors.
        addInputRules: () => [],
        parseHTML: () => [{ tag: 'div[data-type="block-math"]', getAttrs: acceptFormulaElement }],
        addNodeView() {
          const render = this.parent?.();
          if (!render) return null;
          return (props) => {
            const view = render(props);
            view.dom.setAttribute("data-blockid", String(props.node.attrs.blockId));
            return view;
          };
        },
        renderText: ({ node }) => `$$\n${node.attrs.latex}\n$$`,
      }).configure({ katexOptions: { ...mathRenderOptions, displayMode: true } }),
      InlineMath.extend({
        parseHTML: () => [{ tag: 'span[data-type="inline-math"]', getAttrs: acceptFormulaElement }],
        addInputRules() {
          return [
            new InputRule({
              find: new RegExp(`${inlineLatexPattern.source}$`, "u"),
              handler: ({ state, range, match }) => {
                const latex = (match[1] ?? match[2]!).trim();
                if (!isValidMathSource(latex)) return null;
                state.tr.replaceWith(range.from, range.to, this.type.create({ latex }));
              },
            }),
          ];
        },
        addPasteRules() {
          return [
            new PasteRule({
              find: new RegExp(inlineLatexPattern.source, "gu"),
              handler: ({ state, range, match }) => {
                const latex = (match[1] ?? match[2]!).trim();
                if (isValidMathSource(latex)) {
                  state.tr.replaceWith(range.from, range.to, this.type.create({ latex }));
                }
              },
            }),
          ];
        },
        renderText: ({ node }) => `$${node.attrs.latex}$`,
      }).configure({ katexOptions: mathRenderOptions }),
    ];
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    const requestSource = this.options.requestSource;
    return [
      new Plugin({
        props: {
          handleClickOn(_view, _position, _node, nodePosition, event, direct) {
            return direct && event.button === 0 && editFormula(editor, nodePosition, requestSource);
          },
          handleKeyDown(view, event) {
            const { selection } = view.state;
            return (
              event.key === "Enter" &&
              !event.isComposing &&
              !view.composing &&
              event.keyCode !== 229 &&
              selection instanceof NodeSelection &&
              editFormula(editor, selection.from, requestSource)
            );
          },
        },
      }),
    ];
  },
});
