import { createServer } from "node:http";
import { deflateSync } from "node:zlib";
import assert from "node:assert/strict";
/** Protocol fixture, never installed as a production image provider. */
export async function startImageProviderFixture() {
  const crc = (bytes: Buffer) => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (name: string, bytes: Buffer) => {
    const type = Buffer.from(name),
      size = Buffer.alloc(4),
      checksum = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length);
    checksum.writeUInt32BE(crc(Buffer.concat([type, bytes])));
    return Buffer.concat([size, type, bytes, checksum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1024, 0);
  ihdr.writeUInt32BE(1024, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const scanlines = Buffer.alloc(1024 * (1 + 1024 * 4), 255);
  for (let y = 0; y < 1024; y++) scanlines[y * (1 + 1024 * 4)] = 0;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(scanlines)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  let calls = 0;
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.url, "/v1/images/generations");
      assert.equal(req.method, "POST");
      assert.equal(req.headers.authorization, "Bearer image-fixture-key");
      const parts: Buffer[] = [];
      for await (const part of req) parts.push(Buffer.from(part));
      const body = JSON.parse(Buffer.concat(parts).toString()) as Record<string, unknown>;
      assert.equal(body.output_format, "png");
      assert.equal(body.n, 1);
      assert.equal(body.size, "1024x1024");
      calls++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }));
    } catch {
      res.writeHead(400);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("NO_ADDRESS");
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    calls: () => calls,
    png,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
