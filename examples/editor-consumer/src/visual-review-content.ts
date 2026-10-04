import type { DocumentContent } from "@zhishu/document-contracts";

/** Shared Chinese fixture for reviewing editor typography and common block states. */
export const visualReviewContent: DocumentContent = {
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { blockId: "block_review_title", level: 1 },
      content: [
        {
          type: "text",
          text: "知书团队知识库：从需求记录到可持续维护的产品规范与交付手册",
        },
      ],
    },
    {
      type: "paragraph",
      attrs: { blockId: "block_review_intro" },
      content: [
        { type: "text", text: "这份样本用于持续检查中文文档的" },
        { type: "text", text: "标题层级、段落节奏与混合内容", marks: [{ type: "bold" }] },
        {
          type: "text",
          text: "。桌面正文目标宽度约 800–900px，界面文字以 14px 为起点，正文以 16px、1.7–1.8 行高为起点；长句换行应自然，内容区不因侧栏展开而被挤窄。",
        },
      ],
    },
    {
      type: "heading",
      attrs: { blockId: "block_review_scope_heading", level: 2 },
      content: [{ type: "text", text: "本周交付范围" }],
    },
    {
      type: "bulletList",
      attrs: { blockId: "block_review_scope_list" },
      content: [
        {
          type: "listItem",
          attrs: { blockId: "block_review_scope_item_1" },
          content: [
            {
              type: "paragraph",
              attrs: { blockId: "block_review_scope_item_1_text" },
              content: [{ type: "text", text: "先确认用户目标、权限范围和保存责任" }],
            },
          ],
        },
        {
          type: "listItem",
          attrs: { blockId: "block_review_scope_item_2" },
          content: [
            {
              type: "paragraph",
              attrs: { blockId: "block_review_scope_item_2_text" },
              content: [{ type: "text", text: "把验收条件写成可以复现的操作步骤" }],
            },
          ],
        },
        {
          type: "listItem",
          attrs: { blockId: "block_review_scope_item_3" },
          content: [
            {
              type: "paragraph",
              attrs: { blockId: "block_review_scope_item_3_text" },
              content: [{ type: "text", text: "将代码、表格和附件保持在正文阅读顺序中" }],
            },
          ],
        },
      ],
    },
    {
      type: "taskList",
      attrs: { blockId: "block_review_task_list" },
      content: [
        {
          type: "taskItem",
          attrs: { blockId: "block_review_task_schema", checked: true },
          content: [{ type: "text", text: "核对内容契约与普通快照保存路径" }],
        },
        {
          type: "taskItem",
          attrs: { blockId: "block_review_task_keyboard", checked: false },
          content: [{ type: "text", text: "检查键盘焦点、窄屏布局和只读状态" }],
        },
        {
          type: "taskList",
          attrs: { blockId: "block_review_task_nested_list" },
          content: [
            {
              type: "taskItem",
              attrs: { blockId: "block_review_task_ime", checked: false },
              content: [{ type: "text", text: "确认输入法组合期间的按键行为" }],
            },
          ],
        },
      ],
    },
    {
      type: "heading",
      attrs: { blockId: "block_review_code_heading", level: 2 },
      content: [{ type: "text", text: "配置示例" }],
    },
    {
      type: "codeBlock",
      attrs: { blockId: "block_review_code", language: "typescript" },
      content: [
        {
          type: "text",
          text: 'const editor = createEditor({ documentId: "spec-review", content });\nawait saveSnapshot(editor.getJSON(), { expectedRevision });',
        },
      ],
    },
    {
      type: "heading",
      attrs: { blockId: "block_review_table_heading", level: 2 },
      content: [{ type: "text", text: "状态与责任" }],
    },
    {
      type: "table",
      attrs: { blockId: "block_review_table" },
      content: [
        {
          type: "tableRow",
          content: [
            {
              type: "tableHeader",
              content: [
                {
                  type: "paragraph",
                  attrs: { blockId: "block_review_table_head_area" },
                  content: [{ type: "text", text: "阶段" }],
                },
              ],
            },
            {
              type: "tableHeader",
              content: [
                {
                  type: "paragraph",
                  attrs: { blockId: "block_review_table_head_owner" },
                  content: [{ type: "text", text: "负责人" }],
                },
              ],
            },
            {
              type: "tableHeader",
              content: [
                {
                  type: "paragraph",
                  attrs: { blockId: "block_review_table_head_result" },
                  content: [{ type: "text", text: "交付结果" }],
                },
              ],
            },
          ],
        },
        {
          type: "tableRow",
          content: [
            {
              type: "tableCell",
              content: [
                {
                  type: "paragraph",
                  attrs: { blockId: "block_review_table_cell_design" },
                  content: [{ type: "text", text: "设计" }],
                },
              ],
            },
            {
              type: "tableCell",
              content: [
                {
                  type: "paragraph",
                  attrs: { blockId: "block_review_table_cell_owner" },
                  content: [{ type: "text", text: "产品与设计" }],
                },
              ],
            },
            {
              type: "tableCell",
              content: [
                {
                  type: "paragraph",
                  attrs: { blockId: "block_review_table_cell_design_result" },
                  content: [{ type: "text", text: "状态、异常和空态说明" }],
                },
              ],
            },
          ],
        },
        {
          type: "tableRow",
          content: [
            {
              type: "tableCell",
              content: [
                {
                  type: "paragraph",
                  attrs: { blockId: "block_review_table_cell_build" },
                  content: [{ type: "text", text: "实现" }],
                },
              ],
            },
            {
              type: "tableCell",
              content: [
                {
                  type: "paragraph",
                  attrs: { blockId: "block_review_table_cell_engineering" },
                  content: [{ type: "text", text: "工程团队" }],
                },
              ],
            },
            {
              type: "tableCell",
              content: [
                {
                  type: "paragraph",
                  attrs: { blockId: "block_review_table_cell_build_result" },
                  content: [{ type: "text", text: "可编辑、可保存、可恢复" }],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      type: "blockquote",
      attrs: { blockId: "block_review_note" },
      content: [
        {
          type: "paragraph",
          attrs: { blockId: "block_review_note_text" },
          content: [
            { type: "text", text: "验收原则：" },
            {
              type: "text",
              text: "连接成功、内容同步和服务端持久化确认是不同状态。",
              marks: [{ type: "italic" }],
            },
          ],
        },
      ],
    },
    {
      type: "image",
      attrs: {
        blockId: "block_review_attachment_image",
        assetId: "asset_visual_review_image",
        mediaType: "image/png",
        alt: "视觉验收样本附件，用于检查正文中的资源占位与选中态",
      },
    },
    {
      type: "pdfAttachment",
      attrs: {
        blockId: "block_review_attachment_pdf",
        assetId: "asset_visual_review_pdf",
        mediaType: "application/pdf",
        fileName:
          "产品规范与交付验收说明-团队知识库长期维护与跨部门协作流程-2026年度版本-review-copy.pdf",
      },
    },
  ],
};
