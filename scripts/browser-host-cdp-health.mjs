const TIMEOUT_MS = 2_500;
const MAX_DISCOVERY_BYTES = 16 * 1024;
const MAX_PAGE_TARGETS = 32;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function validateEndpoint(value, targetType) {
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== "ws:" ||
    !LOOPBACK_HOSTS.has(endpoint.hostname.toLowerCase()) ||
    endpoint.port !== "10005" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    !new RegExp(`^/devtools/${targetType}/[A-Za-z0-9._-]{1,200}$`, "u").test(endpoint.pathname)
  ) {
    throw new Error("invalid CDP endpoint");
  }
  return endpoint;
}

async function readBoundedJson(path) {
  const response = await fetch(`http://127.0.0.1:10005${path}`, {
    headers: { Host: "127.0.0.1:10005" },
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
    throw new Error("CDP discovery failed");
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DISCOVERY_BYTES) {
    throw new Error("CDP discovery response is too large");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("CDP discovery response is empty");
  const chunks = [];
  let received = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += chunk.value.byteLength;
    if (received > MAX_DISCOVERY_BYTES) {
      await reader.cancel();
      throw new Error("CDP discovery response is too large");
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function requirePageRoundTrip(endpoint) {
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("CDP page round trip timed out"));
    }, TIMEOUT_MS);
    const fail = () => {
      clearTimeout(timeout);
      socket.close();
      reject(new Error("CDP page round trip failed"));
    };
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id: 1, method: "Page.getFrameTree" }));
    });
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (
          message?.id !== 1 ||
          typeof message?.result?.frameTree?.frame?.id !== "string" ||
          typeof message?.result?.frameTree?.frame?.url !== "string"
        ) {
          return;
        }
        clearTimeout(timeout);
        socket.close();
        resolve();
      } catch {
        fail();
      }
    });
    socket.addEventListener("error", fail);
  });
}

try {
  const version = await readBoundedJson("/json/version");
  validateEndpoint(version?.webSocketDebuggerUrl, "browser");
  const targets = await readBoundedJson("/json/list");
  if (!Array.isArray(targets)) throw new Error("CDP target list is invalid");
  const pages = targets.filter((target) => target?.type === "page");
  if (pages.length === 0 || pages.length > MAX_PAGE_TARGETS) {
    throw new Error("CDP page target count is invalid");
  }
  const pageEndpoints = pages.map((page) => validateEndpoint(page?.webSocketDebuggerUrl, "page"));
  if (new Set(pageEndpoints.map((endpoint) => endpoint.href)).size !== pageEndpoints.length) {
    throw new Error("CDP page endpoint is duplicated");
  }
  let rendererPassed = false;
  for (const pageEndpoint of pageEndpoints) {
    try {
      await requirePageRoundTrip(pageEndpoint);
      rendererPassed = true;
      break;
    } catch {
      // Another bounded page target may still provide the renderer readiness proof.
    }
  }
  if (!rendererPassed) throw new Error("CDP renderer round trip failed");
} catch {
  process.exit(1);
}
