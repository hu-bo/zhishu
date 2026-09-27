import { validateDocumentContent } from "@zhishu/document-contracts";
import { createEditorSchema, validateContentForEditor } from "@zhishu/editor-core/schema";

const content = {
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { blockId: "block_schema_sample", level: 1 },
      content: [{ type: "text", text: "Node.js Schema Consumer" }],
    },
  ],
};

const contractsResult = validateDocumentContent(content);
if (!contractsResult.success) throw new Error("The contract rejected the valid sample.");

const schema = createEditorSchema();
const editorResult = validateContentForEditor(content, schema);
if (!editorResult.success) throw new Error("The editor schema rejected the valid sample.");

console.log(`Validated ${schema.nodes.heading.name} content in Node.js.`);
