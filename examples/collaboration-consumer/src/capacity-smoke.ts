import assert from "node:assert/strict";
import net from "node:net";

const host = process.env.COLLABORATION_CAPACITY_HOST ?? "127.0.0.1";
const port = Number(process.env.COLLABORATION_CAPACITY_PORT ?? 3001);
const expectedAcceptedConnections = Number(process.env.COLLABORATION_CAPACITY_LIMIT ?? 100);
const timeoutMs = 2_000;

if (!Number.isSafeInteger(expectedAcceptedConnections) || expectedAcceptedConnections < 1) {
  throw new Error("COLLABORATION_CAPACITY_LIMIT must be a positive integer.");
}

function connect(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("collaboration-capacity-connect-timeout"));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function waitForClose(socket: net.Socket): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("overflow-connection-was-not-closed"));
    }, timeoutMs);
    socket.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      if ((error as NodeJS.ErrnoException).code === "ECONNRESET") resolve();
      else reject(error);
    });
  });
}

const accepted: net.Socket[] = [];

try {
  for (let index = 0; index < expectedAcceptedConnections; index += 1) {
    accepted.push(await connect());
  }
  const closed = new Set<net.Socket>();
  for (const socket of accepted) socket.once("close", () => closed.add(socket));

  const overflow = await connect();
  await waitForClose(overflow);
  assert.equal(closed.size, 0, "all connections within the configured capacity must remain open");
  console.log(
    JSON.stringify({
      host,
      port,
      acceptedConnections: accepted.length,
      overflowRejected: true,
    }),
  );
} finally {
  for (const socket of accepted) socket.destroy();
}
