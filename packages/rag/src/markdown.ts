import { fromMarkdown } from "mdast-util-from-markdown";
import { toMarkdown } from "mdast-util-to-markdown";
import { gfmFromMarkdown, gfmToMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { fromHtml } from "hast-util-from-html";
import { toMdast } from "hast-util-to-mdast";
import type { Root, RootContent, Image, Definition } from "mdast";
import type { createImageProcessor } from "./images.js";

export const parseMarkdown = (text: string): Root =>
  fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
export const serializeMarkdown = (tree: Root): string =>
  toMarkdown(tree, {
    extensions: [gfmToMarkdown({ tableCellPadding: false, tablePipeAlign: false })],
    bullet: "-",
    fences: true,
  }).trimEnd();
export const parseHtml = (text: string): Root => {
  const html = fromHtml(text, { fragment: true });
  let nodes = 0,
    cells = 0;
  const inspect = (node: typeof html | (typeof html.children)[number], depth = 0): void => {
    if (++nodes > 100_000 || depth > 64) throw new Error("DOCUMENT_TOO_DEEP");
    if (node.type === "element" && ["td", "th"].includes(node.tagName)) {
      const rows = Number(node.properties.rowSpan ?? 1),
        columns = Number(node.properties.colSpan ?? 1);
      if (
        !Number.isSafeInteger(rows) ||
        rows < 1 ||
        rows > 20_000 ||
        !Number.isSafeInteger(columns) ||
        columns < 1 ||
        columns > 256 ||
        (cells += rows * columns) > 100_000
      )
        throw new Error("TABLE_LIMIT_EXCEEDED");
    }
    if ("children" in node) for (const child of node.children) inspect(child, depth + 1);
  };
  inspect(html);
  const tree = toMdast(html);
  return tree.type === "root" ? tree : { type: "root", children: [tree] };
};

export async function replaceMarkdownImages(
  tree: Root,
  images: ReturnType<typeof createImageProcessor>,
): Promise<void> {
  const definitions = new Map<string, { node: Definition; url: string }>();
  let nodes = 0;
  const collect = (node: Root | RootContent, depth = 0): void => {
    if (++nodes > 100_000 || depth > 64) throw new Error("DOCUMENT_TOO_DEEP");
    if (node.type === "definition")
      definitions.set(node.identifier.toUpperCase(), { node, url: node.url });
    if ("children" in node)
      for (const child of node.children) collect(child as RootContent, depth + 1);
  };
  collect(tree);
  const visit = async (parent: { children: RootContent[] }, depth: number): Promise<void> => {
    if (depth > 64) throw new Error("DOCUMENT_TOO_DEEP");
    for (let index = 0; index < parent.children.length; index++) {
      const node = parent.children[index]!;
      if (node.type === "html") {
        if (++nodes > 100_000) throw new Error("DOCUMENT_TOO_DEEP");
        const replacement = parseHtml(node.value).children.flatMap((child) =>
          child.type === "paragraph" ? child.children : [child],
        );
        parent.children.splice(index, 1, ...(replacement as RootContent[]));
        index--;
        continue;
      }
      if (node.type === "imageReference") {
        const definition = definitions.get(node.identifier.toUpperCase());
        if (!definition) throw new Error("UNRESOLVED_IMAGE_REFERENCE");
        const image: Image = {
          type: "image",
          url: await images.replace(definition.url),
          alt: node.alt,
          title: definition.node.title,
        };
        definition.node.url = image.url;
        parent.children[index] = image;
      } else if (node.type === "image") node.url = await images.replace(node.url);
      else if ("children" in node) await visit(node as { children: RootContent[] }, depth + 1);
    }
  };
  await visit(tree as { children: RootContent[] }, 0);
}

export function imageAtoms(text: string): string[] {
  const atoms: string[] = [];
  const visit = (node: Root | RootContent): void => {
    if (
      node.type === "image" &&
      node.position?.start.offset !== undefined &&
      node.position.end.offset !== undefined
    )
      atoms.push(text.slice(node.position.start.offset, node.position.end.offset));
    if ("children" in node) for (const child of node.children) visit(child as RootContent);
  };
  visit(parseMarkdown(text));
  return atoms;
}
