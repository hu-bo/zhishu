/** Protocol framing only. Business adapters own validation, retries and cancellation semantics. */
export async function* sseData(
  response: Response,
  maximumFrameCharacters = 1048576,
): AsyncGenerator<string> {
  if (!response.body) throw new Error('未能读取流响应');
  const reader = response.body.getReader(),
    decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        if (boundary > maximumFrameCharacters) throw new Error('流响应超出限制');
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) yield data;
      }
      if (buffer.length > maximumFrameCharacters) throw new Error('流响应超出限制');
    }
    buffer += decoder.decode();
    if (buffer.trim()) throw new Error('流响应已中断');
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
