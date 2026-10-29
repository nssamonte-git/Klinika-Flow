import { createServer } from "node:http";
import { resolve } from "node:path";
import next from "next";
import { createRealtimeGateway } from "../src/server/realtime";

const port = Number(process.env.PORT || "3000"), hostname = process.env.HOSTNAME || "127.0.0.1";
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT.");
const dev = process.env.NODE_ENV !== "production";
let handle: ReturnType<ReturnType<typeof next>["getRequestHandler"]> | undefined;
const server = createServer((req, res) => { if (!handle) { res.writeHead(503); res.end(); return; } void handle(req, res); });
const app = next({ dir: resolve(process.cwd(), "web"), dev, hostname, port, httpServer: server, webpack: true });
await app.prepare();
handle = app.getRequestHandler();
const gateway = createRealtimeGateway(server);
server.listen(port, hostname, () => { console.log(`KlinikaFlow HTTP and optional realtime gateway listening on http://${hostname}:${port}`); });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { gateway.close(); server.close(); void app.close().finally(() => process.exit(0)); });
