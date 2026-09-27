import { validateDocumentContent } from "@zhishu/document-contracts";

const content = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      attrs: { blockId: "block_contracts_consumer" },
      content: [{ type: "text", text: "Contracts only, running in Node.js." }],
    },
  ],
};

const result = validateDocumentContent(content);
if (!result.success) throw new Error("The document contracts rejected the sample.");

console.log(`Validated ${result.data.content[0]?.type} with document-contracts only.`);
