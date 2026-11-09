import { Node } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";

export function createMentionExtension() {
  return Node.create({
    name: "mention",
    group: "inline",
    inline: true,
    atom: true,
    selectable: true,
    marks: "",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          appendTransaction(transactions, _previous, state) {
            if (!transactions.some((transaction) => transaction.docChanged)) return null;
            const transaction = state.tr;
            state.doc.descendants((node, position) => {
              if (node.type.name === "mention" && node.marks.length)
                transaction.removeMark(position, position + node.nodeSize);
            });
            return transaction.steps.length ? transaction : null;
          },
        }),
      ];
    },
    addAttributes() {
      return {
        identityId: {
          default: null,
          parseHTML: (element) => element.getAttribute("data-mention-id"),
        },
        label: {
          default: null,
          parseHTML: (element) => element.getAttribute("data-mention-label"),
        },
      };
    },
    parseHTML() {
      return [
        {
          tag: "span[data-mention-id][data-mention-label]",
          getAttrs: (element) => {
            const identity = element.getAttribute("data-mention-id") ?? "";
            const label = element.getAttribute("data-mention-label") ?? "";
            return /^[A-Za-z0-9._:@-]{1,256}$/.test(identity) &&
              label.trim().length > 0 &&
              label.length <= 80
              ? null
              : false;
          },
        },
      ];
    },
    renderHTML({ node }) {
      const label = String(node.attrs.label ?? "成员");
      const identityId = String(node.attrs.identityId ?? "");
      let hue = 0;
      for (const character of identityId) hue = (hue * 31 + character.codePointAt(0)!) % 360;
      return [
        "span",
        {
          "data-mention-id": identityId,
          "data-mention-label": label,
          "data-mention-initial": [...label][0] ?? "@",
          "data-mention-color": String(hue),
          style: `--zhishu-mention-hue:${hue}`,
          title: `成员：${label}`,
          contenteditable: "false",
        },
        `@${label}`,
      ];
    },
    renderText({ node }) {
      return `@${String(node.attrs.label ?? "成员")}`;
    },
  });
}
