import { createConnection, createServer } from "node:net";

const server = createServer((downstream) => {
  const upstream = createConnection({ host: "127.0.0.1", port: 10015 });
  const close = () => {
    downstream.destroy();
    upstream.destroy();
  };

  downstream.on("error", close);
  downstream.on("close", () => upstream.destroy());
  upstream.on("error", close);
  upstream.on("connect", () => {
    upstream.setTimeout(0);
    downstream.pipe(upstream);
    upstream.pipe(downstream);
  });
  upstream.on("close", () => downstream.destroy());
  upstream.setTimeout(10_000, close);
});

server.maxConnections = 16;
server.on("error", (error) => {
  console.error("Browser CDP proxy failed", error.name);
  process.exit(1);
});
server.listen(10005, "0.0.0.0");

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
