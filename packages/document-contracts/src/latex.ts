import { MAX_LATEX_LENGTH } from "./schema.js";

export const inlineLatexPattern =
  /(?<![\\$])(?:\$\$([^$\n]+)\$\$|\$([^$\s](?:[^$\n]*?[^$\s])?)\$(?![\d$]))/u;

export const displayLatexPattern = /^[ \t]{0,3}\$\$([^$]+?)\$\$[ \t]*\r?$/mu;

export function isValidMathSource(latex: string): boolean {
  return latex.length <= MAX_LATEX_LENGTH && /\S/u.test(latex);
}
