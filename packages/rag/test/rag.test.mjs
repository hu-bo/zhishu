/* global AbortSignal, process */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { QdrantClient } from "@qdrant/js-client-rest";
import { Embeddings } from "@langchain/core/embeddings";
import { QdrantVectorStore } from "@langchain/qdrant";
import {
  prepareDocumentChunks,
  prepareDocument,
  sourceSnapshotId,
  initializeCollection,
  writeDocumentIndex,
  updateIndexPolicy,
  deterministicPointId,
  createKnowledgeRetriever,
} from "../dist/index.js";

const index = {
  collectionName: `zhishu_test_${randomUUID().replaceAll("-", "")}`,
  embeddingFingerprint: "deterministic-v1",
  dimensions: 3,
  metric: "cosine",
  normalizerVersion: "block-utf16-v1",
  chunkerVersion: "langchain-1.0.2-utf8-v1",
  targetTokens: 96,
  maxTokens: 160,
  overlapTokens: 16,
};
const paragraph = (id, text) => ({
  type: "paragraph",
  attrs: { blockId: id },
  content: text ? [{ type: "text", text }] : [],
});
const snapshot = (
  content = [paragraph("block_text", "中文知识库中的真实原文。")],
  id = "doc_test",
) => ({
  documentId: id,
  generationId: "gen_test",
  durableSeq: Number.MAX_SAFE_INTEGER,
  schemaVersion: 5,
  extensions: [],
  snapshotRevision: 1,
  content: { type: "doc", content },
});
class TestEmbeddings extends Embeddings {
  constructor() {
    super({});
    this.documents = 0;
    this.queries = 0;
  }
  async embedDocuments(texts) {
    this.documents += texts.length;
    return texts.map(() => [1, 0, 0]);
  }
  async embedQuery() {
    this.queries++;
    return [1, 0, 0];
  }
}
test("LangChain chunking preserves Chinese, emoji UTF-16 ranges, duplicate headings, lists and table row context", async () => {
  const text = "中文😀测试".repeat(55),
    code = "const x = 1;\n".repeat(18);
  const blocks = [
    {
      type: "heading",
      attrs: { blockId: "block_h1", level: 1 },
      content: [{ type: "text", text: "重复标题" }],
    },
    paragraph("block_text", text),
    {
      type: "heading",
      attrs: { blockId: "block_h2", level: 1 },
      content: [{ type: "text", text: "重复标题" }],
    },
    {
      type: "codeBlock",
      attrs: { blockId: "block_code", language: "ts" },
      content: [{ type: "text", text: code }],
    },
    {
      type: "bulletList",
      attrs: { blockId: "block_list" },
      content: [
        {
          type: "listItem",
          attrs: { blockId: "block_item" },
          content: [paragraph("block_li", "列表只提取一次")],
        },
      ],
    },
    {
      type: "table",
      attrs: { blockId: "block_table" },
      content: [
        {
          type: "tableRow",
          content: [
            { type: "tableHeader", content: [paragraph("block_header", "表头")] },
            { type: "tableCell", content: [paragraph("block_cell", "单元格")] },
          ],
        },
      ],
    },
  ];
  const original = snapshot(blocks),
    prepared = await prepareDocument(original, index),
    items = prepared.chunks;
  assert.deepEqual(items, await prepareDocumentChunks(original, index));
  const texts = new Map([
    ["block_h1", "重复标题"],
    ["block_h2", "重复标题"],
    ["block_text", text],
    ["block_code", code],
    ["block_li", "列表只提取一次"],
    ["block_table", prepared.blocks.find((block) => block.id === "block_table").text],
  ]);
  for (const item of items) {
    const { blockId, start, end } = item.source.locator;
    assert.equal(texts.get(blockId).slice(start, end), item.text);
    assert.ok(Buffer.byteLength(`${item.title}\n${item.text}`) <= index.maxTokens);
    assert.ok(!/[\uD800-\uDBFF]$/.test(item.text));
    assert.ok(!/^[\uDC00-\uDFFF]/.test(item.text));
  }
  assert.equal(items.filter((item) => item.source.locator.blockId === "block_li").length, 1);
  assert.ok(
    items.some(
      (item) => item.source.locator.blockId === "block_table" && item.text.includes("单元格"),
    ),
  );
  assert.equal(items.filter((item) => item.source.locator.blockId === "block_cell").length, 0);
  assert.equal(new Set(items.map((item) => item.evidenceId)).size, items.length);
  assert.deepEqual(await prepareDocumentChunks(snapshot([]), index), []);
  assert.throws(
    () => sourceSnapshotId({ ...original, durableSeq: Number.MAX_SAFE_INTEGER + 1 }),
    /UNSAFE/,
  );
});
test("empty authorization keys skip query embedding and Qdrant entirely", async () => {
  const embeddings = new TestEmbeddings();
  const retriever = createKnowledgeRetriever({
    index,
    embeddings,
    client: {},
    resolveScope: async () => ({ tenantId: "t", workspaceIds: ["s"], readAclKeys: [] }),
    authorizeCandidates: async () => {
      throw new Error("unreachable");
    },
    verifyEvidence: async () => true,
  });
  assert.deepEqual(
    await retriever.retrieve({
      query: "正文",
      scope: {},
      contextTokenBudget: 100,
      signal: AbortSignal.timeout(1_000),
    }),
    { freshness: "current", items: [] },
  );
  assert.equal(embeddings.queries, 0);
});
test(
  "real Qdrant insert_only, conditional nested policy, projection-first authorization, tenant isolation and stale candidate expansion",
  { skip: !process.env.QDRANT_TEST_URL },
  async () => {
    const client = new QdrantClient({
        url: process.env.QDRANT_TEST_URL,
        checkCompatibility: false,
      }),
      embeddings = new TestEmbeddings(),
      signal = AbortSignal.timeout(30_000);
    await initializeCollection(client, index);
    try {
      const base = {
        client,
        embeddings,
        options: index,
        snapshot: snapshot(),
        tenantId: "tenant_a",
        workspaceId: "space_a",
        indexVersion: "v1",
        metadataRevision: "1",
        aclRevision: "1",
        readAclKeys: ["space:space_a"],
        signal,
      };
      const result = await writeDocumentIndex(base);
      assert.equal(result.chunkCount, 1);
      await writeDocumentIndex({ ...base, tenantId: "tenant_b" });
      await writeDocumentIndex({ ...base, indexVersion: "stale" });
      const id = deterministicPointId("tenant_a", "doc_test", "v1", 0);
      await updateIndexPolicy({
        ...base,
        documentId: "doc_test",
        previousRevision: "1",
        aclRevision: "3",
        readAclKeys: ["document:doc_test"],
      });
      // A stale full build and stale policy update must never overwrite the newer authorization payload.
      await writeDocumentIndex(base);
      await updateIndexPolicy({
        ...base,
        documentId: "doc_test",
        previousRevision: "1",
        aclRevision: "2",
        readAclKeys: ["user:removed"],
      });
      const point = (
        await client.retrieve(index.collectionName, { ids: [id], with_payload: true })
      )[0];
      assert.equal(point.payload.metadata.aclRevision, "3");
      assert.deepEqual(point.payload.metadata.readAclKeys, ["document:doc_test"]);
      assert.equal(point.payload.metadata.durableSeq, String(Number.MAX_SAFE_INTEGER));
      assert.equal(point.payload.content, "中文知识库中的真实原文。");
      const store = new QdrantVectorStore(embeddings, {
        client,
        collectionName: index.collectionName,
      });
      assert.ok(
        (
          await store.similaritySearch("中文", 1, {
            must: [{ key: "metadata.tenantId", match: { value: "tenant_a" } }],
          })
        )[0].pageContent.includes("中文"),
      );
      let allowed = true,
        reviewed = 0;
      const queryCalls = [],
        originalQuery = client.query.bind(client);
      client.query = async (...args) => {
        queryCalls.push(args[1]);
        return originalQuery(...args);
      };
      const retriever = createKnowledgeRetriever({
        index,
        embeddings,
        client,
        candidateLimit: 1,
        maxCandidates: 8,
        resolveScope: async () => ({
          tenantId: "tenant_a",
          workspaceIds: ["space_a"],
          readAclKeys: ["space:space_a", "document:doc_test"],
        }),
        authorizeCandidates: async (_scope, candidates) => {
          reviewed += candidates.length;
          assert.ok(
            candidates.every(
              (c) =>
                !Object.hasOwn(c, "content") &&
                !Object.hasOwn(c, "title") &&
                c.tenantId === "tenant_a",
            ),
          );
          return candidates.filter((c) => allowed && c.indexVersion === "v1").map((c) => c.pointId);
        },
        verifyEvidence: async () => allowed,
      });
      const found = await retriever.retrieve({
        query: "中文",
        scope: {},
        contextTokenBudget: 2_000,
        signal,
      });
      assert.equal(found.items.length, 1);
      assert.ok(reviewed >= 2);
      assert.ok(
        queryCalls.every(
          (call) =>
            !call.with_payload.include.includes("content") &&
            !call.with_payload.include.includes("metadata.title"),
        ),
      );
      allowed = false;
      await assert.rejects(
        retriever.retrieve({ query: "中文", scope: {}, contextTokenBudget: 2_000, signal }),
        /ACCESS_REVOKED/,
      );
      // Ordinary membership changes involve only resolveScope: no points or vectors are rewritten.
      const count = await client.count(index.collectionName, { exact: true });
      assert.equal(count.count, 3);
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7V8AAAAASUVORK5CYII=",
        "base64",
      );
      const imported = await writeDocumentIndex({
        ...base,
        snapshot: undefined,
        source: {
          format: "csv",
          sourceId: "doc_csv",
          content: `名称,图片\n示例,"![图](data:image/png;base64,${png.toString("base64")})"`,
        },
        version: { generationId: "gen_csv", durableSeq: "9007199254740993" },
        indexVersion: "csv_v1",
        parsing: {
          imageStorage: { uploadImage: async () => ({ url: "https://oss.example/x.png" }) },
        },
      });
      assert.equal(imported.images.length, 1);
      const csvRetriever = createKnowledgeRetriever({
        index,
        embeddings,
        client,
        resolveScope: async () => ({
          tenantId: "tenant_a",
          workspaceIds: ["space_a"],
          documentIds: ["doc_csv"],
          readAclKeys: ["space:space_a"],
        }),
        authorizeCandidates: async (_scope, candidates) =>
          candidates
            .filter(
              (candidate) =>
                candidate.documentId === "doc_csv" &&
                candidate.indexVersion === "csv_v1" &&
                candidate.durableSeq === "9007199254740993",
            )
            .map((candidate) => candidate.pointId),
        verifyEvidence: async () => true,
      });
      const csvEvidence = await csvRetriever.retrieve({
        query: "图片",
        scope: {},
        contextTokenBudget: 4_000,
        signal,
      });
      assert.ok(csvEvidence.items.some((item) => item.text.includes("https://oss.example/x.png")));
      assert.ok(
        csvEvidence.items.every(
          (item) => item.source.sourceId === "doc_csv" && item.source.locator.kind === "section",
        ),
      );
      const badEmbeddings = new TestEmbeddings();
      badEmbeddings.embedDocuments = async () => [[Number.NaN, 0, 0]];
      await assert.rejects(
        writeDocumentIndex({ ...base, embeddings: badEmbeddings }),
        /INVALID_EMBEDDING/,
      );
    } finally {
      await client.deleteCollection(index.collectionName);
    }
  },
);
