/* global AbortController, AbortSignal, fetch */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { validateEvidenceBundle } from "@zhishu/ai-contracts";
import { prepareDocument, prepareDocumentChunks, writeDocumentIndex } from "../dist/index.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7V8AAAAASUVORK5CYII=",
  "base64",
);
const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
const index = {
  collectionName: "ingestion_test",
  embeddingFingerprint: "stub-v1",
  dimensions: 3,
  metric: "cosine",
  normalizerVersion: "v2",
  chunkerVersion: "v2",
  targetTokens: 240,
  maxTokens: 400,
  overlapTokens: 24,
};
const source = (format, content) => ({
  format,
  sourceId: "doc_import",
  title: "导入文档",
  content,
});
const paragraph = (id, text) => ({
  type: "paragraph",
  attrs: { blockId: id },
  content: [{ type: "text", text }],
});
const snapshot = (content) => ({
  documentId: "doc_native",
  generationId: "gen_native",
  durableSeq: 12,
  schemaVersion: 5,
  extensions: [],
  snapshotRevision: 1,
  content: { type: "doc", content },
});
const checkLocators = (prepared) => {
  for (const chunk of prepared.chunks) {
    const locator = chunk.source.locator,
      id = locator.kind === "block" ? locator.blockId : locator.sectionId;
    const block = prepared.blocks.find((block) => block.id === id);
    assert.equal(block.text.slice(locator.start, locator.end), chunk.text);
    assert.ok(Buffer.byteLength(`${chunk.title}\n${chunk.text}`) <= index.maxTokens);
    assert.equal(validateEvidenceBundle({ freshness: "current", items: [chunk] }).success, true);
  }
};

test("native tables preserve row relationships, merged-cell values and exact normalized block ranges", async () => {
  const cell = (text, attrs) => ({
    type: "tableCell",
    attrs,
    content: [paragraph(`block_${text}`, text)],
  });
  const table = {
    type: "table",
    attrs: { blockId: "block_table" },
    content: [
      {
        type: "tableRow",
        content: ["部门", "成员", "职责"].map((text, i) => ({
          type: "tableHeader",
          content: [paragraph(`block_head${i}`, text)],
        })),
      },
      { type: "tableRow", content: [cell("产品", { rowspan: 2 }), cell("小王"), cell("设计")] },
      { type: "tableRow", content: [cell("小李"), cell("开发")] },
    ],
  };
  // Block IDs are opaque ASCII identities, independent of display text.
  for (const [r, row] of table.content.entries())
    for (const [c, item] of row.content.entries())
      item.content[0].attrs.blockId = `block_r${r}c${c}`;
  const prepared = await prepareDocument(snapshot([table]), index);
  assert.ok(prepared.text.includes("|产品|小王|设计|"));
  assert.ok(prepared.text.includes("|产品|小李|开发|"));
  assert.ok(
    prepared.chunks.every(
      (chunk) => chunk.source.locator.blockId === "block_table" && chunk.title.includes("部门"),
    ),
  );
  checkLocators(prepared);
});

test("CSV handles BOM, quoted commas/newlines, escaped quotes, duplicate headers, formulas and custom delimiters", async () => {
  const prepared = await prepareDocument(
    source("csv", '\ufeff部门,姓名,备注\r\n产品,"张,三","第一行\r\n第二行"\r\n产品,"李""四",=1+1'),
    index,
  );
  assert.ok(prepared.text.includes("张,三"));
  assert.ok(prepared.text.includes('李"四'));
  assert.ok(prepared.text.includes("第一行 ⏎ 第二行"));
  assert.ok(prepared.text.includes("=1+1"));
  checkLocators(prepared);
  const duplicate = await prepareDocument(source("csv", "值,值\n1,2"), index);
  assert.ok(duplicate.text.includes("|值|值|"));
  const headless = await prepareDocument(
    { ...source("csv", "甲;乙\n丙;丁"), delimiter: ";", hasHeader: false },
    index,
  );
  assert.ok(headless.text.includes("列 1"));
  assert.ok(headless.text.includes("甲"));
  assert.deepEqual(await prepareDocumentChunks(source("csv", ""), index), []);
  await assert.rejects(prepareDocument(source("csv", 'a,b\n"unclosed'), index), /INVALID_CSV/);
  await assert.rejects(
    prepareDocument(source("csv", "a,b\n1,2\n3,4"), index, { limits: { maxRows: 2 } }),
    /CSV_LIMIT_EXCEEDED/,
  );
  await assert.rejects(
    prepareDocument(source("csv", "a,b,c"), index, { limits: { maxColumns: 2 } }),
    /CSV_LIMIT_EXCEEDED/,
  );
});

test("Markdown/HTML images upload through a real HTTP storage adapter, deduplicate and replace URLs before chunking", async () => {
  const stored = new Map();
  const server = createServer(async (request, response) => {
    const bytes = [];
    for await (const part of request) bytes.push(part);
    stored.set(request.url, {
      bytes: Buffer.concat(bytes),
      mediaType: request.headers["content-type"],
    });
    response.writeHead(201).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  let uploads = 0,
    reads = 0;
  const imageStorage = {
    readImage: async ({ reference, signal }) => {
      signal.throwIfAborted();
      assert.equal(reference, "./chart.png");
      reads++;
      return { bytes: png, mediaType: "image/png" };
    },
    uploadImage: async ({ bytes, mediaType, sha256, signal, sourceId, fileName }) => {
      assert.equal(sourceId, "doc_import");
      assert.equal(fileName, `${sha256}.png`);
      assert.equal(sha256, createHash("sha256").update(bytes).digest("hex"));
      const url = `${base}/${sha256}.png`,
        response = await fetch(url, {
          method: "PUT",
          body: bytes,
          headers: { "content-type": mediaType },
          signal,
        });
      assert.equal(response.status, 201);
      uploads++;
      return { url };
    },
  };
  try {
    const markdown = `# 图片说明\n\n正文 ![第一张](${dataUrl}) 结束。\n\n![同一张][figure] 和 ![重复引用][figure]\n\n[figure]: ${dataUrl}\n\n![文件](./chart.png)\n\n|项目|示意图|\n|---|---|\n|架构|![表格内](${dataUrl})|`;
    const prepared = await prepareDocument(source("markdown", markdown), index, {
      imageStorage,
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(uploads, 1);
    assert.equal(reads, 1);
    assert.equal(prepared.images.length, 1);
    assert.ok(!prepared.text.includes("data:image"));
    assert.ok(!prepared.text.includes("./chart.png"));
    assert.ok(prepared.text.includes(base));
    assert.deepEqual([...stored.values()][0].bytes, png);
    assert.equal([...stored.values()][0].mediaType, "image/png");
    assert.ok(prepared.chunks.some((chunk) => chunk.text.includes(prepared.images[0].url)));
    for (const chunk of prepared.chunks)
      if (chunk.text.includes(base)) assert.ok(chunk.text.includes(prepared.images[0].url));
    checkLocators(prepared);
    const html = await prepareDocument(
      source(
        "html",
        `<h2>图表</h2><table><tr><th>名称</th><th>图</th></tr><tr><td>示例</td><td><img alt="图示" src="${dataUrl}"></td></tr></table><script>alert(1)</script>`,
      ),
      index,
      { imageStorage },
    );
    assert.equal(html.images.length, 1);
    assert.ok(html.text.includes(base));
    assert.ok(!html.text.includes("alert(1)"));
    checkLocators(html);
    const mixed = await prepareDocument(
      source(
        "markdown",
        `内联 <img src="${dataUrl}" alt="内联图">\n\n~~~html\n<img src="${dataUrl}">\n~~~`,
      ),
      { ...index, targetTokens: 500, maxTokens: 800 },
      { imageStorage },
    );
    assert.equal(mixed.images.length, 1);
    assert.ok(mixed.text.includes('<img src="data:image/png'));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("native assets use caller-authorized reading and leave the persistent snapshot intact", async () => {
  const original = snapshot([
    {
      type: "image",
      attrs: {
        blockId: "block_image",
        assetId: "asset_test",
        mediaType: "image/png",
        alt: "流程图",
      },
    },
  ]);
  const before = JSON.stringify(original);
  const prepared = await prepareDocument(original, index, {
    imageStorage: {
      readImage: async ({ assetId, reference }) => {
        assert.equal(assetId, "asset_test");
        assert.equal(reference, "asset:asset_test");
        return { bytes: png };
      },
      uploadImage: async () => ({ url: "https://custom-storage.example/diagram.png" }),
    },
  });
  assert.ok(prepared.text.includes("https://custom-storage.example/diagram.png"));
  assert.equal(JSON.stringify(original), before);
  checkLocators(prepared);
});

test("image failures, invalid URLs, MIME spoofing, budgets and cancellation produce no successful prepared document", async () => {
  const document = source("markdown", `![test](${dataUrl})`);
  await assert.rejects(prepareDocument(document, index), /IMAGE_STORAGE_REQUIRED/);
  await assert.rejects(
    prepareDocument(source("markdown", "![x](https://private.example/image.png)"), index, {
      imageStorage: { uploadImage: async () => ({ url: "https://storage.example/x.png" }) },
    }),
    /IMAGE_READER_REQUIRED/,
  );
  await assert.rejects(
    prepareDocument(document, index, {
      limits: { maxImageBytes: 10 },
      imageStorage: {
        uploadImage: async () => {
          throw new Error("must not run");
        },
      },
    }),
    /IMAGE_TOO_LARGE/,
  );
  await assert.rejects(
    prepareDocument(document, index, {
      imageStorage: {
        uploadImage: async () => {
          throw new Error("secret provider response");
        },
      },
    }),
    /^Error: IMAGE_UPLOAD_FAILED$/,
  );
  await assert.rejects(
    prepareDocument(document, index, {
      imageStorage: { uploadImage: async () => ({ url: "javascript:alert(1)" }) },
    }),
    /INVALID_IMAGE_URL/,
  );
  await assert.rejects(
    prepareDocument(
      source("markdown", `![x](${dataUrl.replace("image/png", "image/jpeg")})`),
      index,
      { imageStorage: { uploadImage: async () => ({ url: "https://storage.example/x" }) } },
    ),
    /INVALID_IMAGE_MEDIA_TYPE/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    prepareDocument(document, index, {
      signal: controller.signal,
      imageStorage: {
        uploadImage: async () => {
          throw new Error("must not run");
        },
      },
    }),
    /abort/i,
  );
  await assert.rejects(
    prepareDocument(
      source("html", '<table><tr><td rowspan="999999999">x</td></tr></table>'),
      index,
    ),
    /TABLE_LIMIT_EXCEEDED/,
  );
});

test("CSV and uploaded image text reaches the same Qdrant indexing path with a trusted external version", async () => {
  const points = new Map();
  const input = {
    options: index,
    source: source("csv", `名称,图片\n图示,"![图](${dataUrl})"`),
    version: { generationId: "gen_import", durableSeq: "9007199254740993" },
    tenantId: "tenant_a",
    workspaceId: "space_a",
    indexVersion: "v_import",
    metadataRevision: "1",
    aclRevision: "1",
    readAclKeys: ["space:space_a"],
    signal: AbortSignal.timeout(5_000),
    parsing: {
      imageStorage: {
        uploadImage: async () => ({ url: "https://arbitrary-oss.example/chart.png" }),
      },
    },
    embeddings: { embedDocuments: async (texts) => texts.map(() => [1, 0, 0]) },
    client: {
      upsert: async (_collection, { points: batch }) => {
        for (const point of batch) points.set(point.id, point);
      },
      retrieve: async (_collection, { ids }) => ids.map((id) => points.get(id)).filter(Boolean),
    },
  };
  const result = await writeDocumentIndex(input);
  assert.equal(result.images.length, 1);
  assert.ok(result.chunkCount > 0);
  assert.ok(
    [...points.values()].some((point) =>
      point.payload.content.includes("https://arbitrary-oss.example/chart.png"),
    ),
  );
  assert.ok(
    [...points.values()].every(
      (point) =>
        point.payload.metadata.durableSeq === "9007199254740993" &&
        point.payload.metadata.documentId === "doc_import",
    ),
  );
});
