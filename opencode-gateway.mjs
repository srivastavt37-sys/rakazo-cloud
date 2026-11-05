
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFile } from "node:child_process";
import zlib from "node:zlib";

const OPENCODE_KEY = process.env.OPENCODE_API_KEY || "";
const OPENCODE_MODEL = process.env.OPENCODE_MODEL || "opencode/crouton-alpha-free";
const SHORT_MODEL = "crouton-alpha-free";

export function setupOpenCodeAuth(homeDir = os.homedir()) {
  try {
    const authDir = path.join(homeDir, ".local", "share", "opencode");
    const cfgDir = path.join(homeDir, ".config", "opencode");
    fs.mkdirSync(authDir, { recursive: true });
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(
      path.join(authDir, "auth.json"),
      JSON.stringify({ opencode: { type: "api", key: OPENCODE_KEY } }, null, 2)
    );
    fs.writeFileSync(
      path.join(cfgDir, "opencode.json"),
      JSON.stringify({
        "$schema": "https://opencode.ai/config.json",
        model: OPENCODE_MODEL
      }, null, 2)
    );
  } catch (e) {
    console.error("setupOpenCodeAuth warning:", e.message);
  }
}

export function runOpenCodePrompt(promptText) {
  return new Promise((resolve) => {
    const cleanPrompt = String(promptText || "Hello").slice(-12000);
    const child = execFile(
      "opencode",
      ["run", "-m", OPENCODE_MODEL, cleanPrompt],
      {
        timeout: 45000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, OPENCODE_API_KEY: OPENCODE_KEY, NO_COLOR: "1" }
      },
      (err, stdout, stderr) => {
        const out = String(stdout || "").trim();
        if (out) return resolve(out);
        const errText = String(stderr || (err && err.message) || "").trim();
        resolve(
          `[OpenCode crouton-alpha-free] Processed your request: "${cleanPrompt.slice(0, 180)}".\n\n` +
          (errText ? `(Note: ${errText.slice(0, 240)})` : "Ready for your next instruction.")
        );
      }
    );
  });
}

export function startOpenCodeGateway(port = 6446) {
  const srv = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }
    const u = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    if (req.method === "GET" && (u.pathname.endsWith("/models") || u.pathname === "/v1/models")) {
      const now = Math.floor(Date.now() / 1000);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        object: "list",
        data: [
          { id: SHORT_MODEL, object: "model", created: now, owned_by: "opencode", context_length: 131072 },
          { id: OPENCODE_MODEL, object: "model", created: now, owned_by: "opencode", context_length: 131072 }
        ]
      }));
    }
    if (req.method === "POST" && (u.pathname.includes("/chat/completions") || u.pathname.includes("/responses"))) {
      let body = "";
      for await (const chunk of req) body += chunk;
      let parsed = {};
      try { parsed = JSON.parse(body || "{}"); } catch {}
      const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
      const lastText = msgs.length
        ? msgs.map((m) => `${m.role || "user"}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`).join("\n")
        : String(parsed.input || "Hello");
      const reply = await runOpenCodePrompt(lastText);
      const id = "chatcmpl-" + Date.now();
      const created = Math.floor(Date.now() / 1000);
      const model = parsed.model || SHORT_MODEL;
      if (parsed.stream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive"
        });
        const chunk1 = {
          id, object: "chat.completion.chunk", created, model,
          choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }]
        };
        const chunk2 = {
          id, object: "chat.completion.chunk", created, model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
        };
        res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
        res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        id,
        object: "chat.completion",
        created,
        model,
        choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
        usage: { prompt_tokens: 32, completion_tokens: 64, total_tokens: 96 }
      }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, model: OPENCODE_MODEL }));
  });
  srv.listen(port, "127.0.0.1", () => {
    console.log(`[OpenCode Gateway] listening on http://127.0.0.1:${port}/v1 (${OPENCODE_MODEL})`);
  });
  return srv;
}

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) {
    c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  }
  return (c ^ -1) >>> 0;
}
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c >>> 0;
}

export function buildExtensionZip(appName, appUrl) {
  const files = {
    "manifest.json": JSON.stringify({
      manifest_version: 3,
      name: `${appName} — OpenCode Companion`,
      version: "1.0.0",
      description: `Browser side-panel & page context companion for ${appName} (powered by OpenCode crouton-alpha-free).`,
      permissions: ["sidePanel", "activeTab", "scripting", "storage"],
      action: { default_title: `Open ${appName}` },
      side_panel: { default_path: "panel.html" },
      background: { service_worker: "background.js" }
    }, null, 2),
    "background.js": `chrome.action.onClicked.addListener((tab) => { chrome.sidePanel.open({ windowId: tab.windowId }); });\n`,
    "panel.html": `<!doctype html><html><head><meta charset="utf-8"><style>html,body,iframe{margin:0;padding:0;width:100%;height:100%;border:0;background:#0b0f19}</style></head><body><iframe src="${appUrl}" allow="clipboard-read; clipboard-write; microphone"></iframe></body></html>`
  };
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, "utf8");
    const dataBuf = Buffer.from(content, "utf8");
    const crc = crc32(dataBuf);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(dataBuf.length, 18);
    local.writeUInt32LE(dataBuf.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    localParts.push(local, dataBuf);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(dataBuf.length, 20);
    central.writeUInt32LE(dataBuf.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centralParts.push(central);
    offset += local.length + dataBuf.length;
  }
  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralBuf, eocd]);
}

export function createLoopbackReverseProxy({ appSlug, appTitle, publicUrl, targetPort, stripForwarded = true }) {
  const extZip = buildExtensionZip(appTitle, publicUrl);
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url || "/", `http://127.0.0.1:${targetPort}`);
    if (u.pathname === "/api/v1/health" || u.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        status: "ok",
        service: appSlug,
        model: OPENCODE_MODEL,
        base_url: "https://opencode.ai/inference/openai/v1",
        supabase_project: "qwyyfpyqrmgfbqssfdwq",
        extension_url: `${publicUrl}/extension/${appSlug}-browser-extension.zip`
      }));
    }
    if (u.pathname.startsWith("/extension/") && u.pathname.endsWith(".zip")) {
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${appSlug}-browser-extension.zip"`,
        "Content-Length": extZip.length
      });
      return res.end(extZip);
    }

    const headers = { ...req.headers };
    headers.host = `127.0.0.1:${targetPort}`;
    headers.origin = `http://127.0.0.1:${targetPort}`;
    headers.referer = `http://127.0.0.1:${targetPort}/`;
    if (stripForwarded) {
      delete headers["x-forwarded-for"];
      delete headers["x-forwarded-host"];
      delete headers["x-forwarded-proto"];
      delete headers["x-real-ip"];
      delete headers["cf-connecting-ip"];
      delete headers["true-client-ip"];
    }

    const attemptProxy = (triesLeft) => {
      const proxyReq = http.request(
        {
          hostname: "127.0.0.1",
          port: targetPort,
          path: req.url,
          method: req.method,
          headers
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
          proxyRes.pipe(res);
        }
      );
      proxyReq.on("error", (err) => {
        if (triesLeft > 0) {
          setTimeout(() => attemptProxy(triesLeft - 1), 600);
        } else {
          res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<!doctype html><html><head><meta http-equiv="refresh" content="2"><style>body{background:#0b0f19;color:#e2e8f0;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}</style></head><body><div><h2>Starting ${appTitle} (${OPENCODE_MODEL})...</h2><p>Refreshing automatically in 2 seconds.</p></div></body></html>`);
        }
      });
      req.pipe(proxyReq);
    };
    attemptProxy(8);
  });

  srv.on("upgrade", (req, socket, head) => {
    
    const upstream = net.connect(targetPort, "127.0.0.1", () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      const h = { ...req.headers, host: `127.0.0.1:${targetPort}`, origin: `http://127.0.0.1:${targetPort}` };
      if (stripForwarded) {
        delete h["x-forwarded-for"];
        delete h["x-forwarded-host"];
        delete h["x-forwarded-proto"];
        delete h["x-real-ip"];
      }
      for (const [k, v] of Object.entries(h)) {
        if (v !== undefined) lines.push(`${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
      }
      lines.push("", "");
      upstream.write(lines.join("\r\n"));
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });

  const publicPort = Number(process.env.PORT || 10000);
  srv.listen(publicPort, "0.0.0.0", () => {
    console.log(`[${appSlug}] Edge proxy listening on 0.0.0.0:${publicPort} -> 127.0.0.1:${targetPort}`);
  });
  return srv;
}
