import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { setupOpenCodeAuth, startOpenCodeGateway, buildExtensionZip } from "./opencode-gateway.mjs";

setupOpenCodeAuth();
startOpenCodeGateway(6446);

const publicUrl = process.env.RENDER_EXTERNAL_URL || "https://rakazo-cloud.onrender.com";
const extZip = buildExtensionZip("Rakazo Cloud", publicUrl);
const webDist = "/app/apps/web/dist";
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon"
};

let ownerSessionCookie = "";
let apiReady = false;

const srv = http.createServer((req, res) => {
  const u = new URL(req.url || "/", "http://127.0.0.1:10000");
  if (u.pathname === "/api/v1/health" || u.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      status: "ok",
      service: "rakazo-cloud",
      api_ready: apiReady,
      model: "opencode/crouton-alpha-free",
      base_url: "https://opencode.ai/inference/openai/v1",
      supabase_project: "qwyyfpyqrmgfbqssfdwq",
      extension_url: `${publicUrl}/extension/rakazo-cloud-browser-extension.zip`
    }));
  }
  if (u.pathname.startsWith("/extension/") && u.pathname.endsWith(".zip")) {
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="rakazo-cloud-browser-extension.zip"',
      "Content-Length": extZip.length
    });
    return res.end(extZip);
  }

  // Proxy /api, /rpc, /.well-known to Rakazo API on 127.0.0.1:3100
  if (u.pathname.startsWith("/api") || u.pathname.startsWith("/rpc") || u.pathname.startsWith("/.well-known")) {
    const headers = { ...req.headers, host: req.headers.host || "127.0.0.1:3100" };
    if (ownerSessionCookie && !headers.cookie) {
      headers.cookie = ownerSessionCookie;
    }
    const pReq = http.request({
      hostname: "127.0.0.1",
      port: 3100,
      path: req.url,
      method: req.method,
      headers
    }, (pRes) => {
      const outHeaders = { ...pRes.headers };
      if (ownerSessionCookie && !req.headers.cookie && !outHeaders["set-cookie"]) {
        outHeaders["set-cookie"] = ownerSessionCookie;
      }
      res.writeHead(pRes.statusCode || 200, outHeaders);
      pRes.pipe(res);
    });
    pReq.on("error", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "starting", message: "Rakazo API warming up..." }));
    });
    return req.pipe(pReq);
  }

  // Serve static SPA from /app/apps/web/dist
  let relPath = u.pathname === "/" ? "/index.html" : u.pathname;
  let fullPath = path.join(webDist, relPath);
  if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
    fullPath = path.join(webDist, "index.html");
  }
  try {
    const data = fs.readFileSync(fullPath);
    const ext = path.extname(fullPath).toLowerCase();
    const outHeaders = { "Content-Type": MIME[ext] || "application/octet-stream" };
    if (ownerSessionCookie && !req.headers.cookie) {
      outHeaders["Set-Cookie"] = ownerSessionCookie;
    }
    res.writeHead(200, outHeaders);
    res.end(data);
  } catch (e) {
    res.writeHead(404).end("Not found");
  }
});

const publicPort = Number(process.env.PORT || 10000);
srv.listen(publicPort, "0.0.0.0", () => {
  console.log(`[rakazo-cloud] Edge server listening on 0.0.0.0:${publicPort}`);
});

// Boot Rakazo DB migrations, owner account, API, and Worker in background
(async () => {
  const env = {
    ...process.env,
    BETTER_AUTH_URL: publicUrl,
    WEB_ORIGIN: publicUrl,
    API_URL: "http://127.0.0.1:3100",
    API_HOST: "127.0.0.1",
    OWNER_EMAIL: process.env.OWNER_EMAIL || "admin@rakazo.local",
    OWNER_PASSWORD: process.env.OWNER_PASSWORD || "RakazoOpenCode2026!",
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET || "rakazo_opencode_secret_key_2026_99x_secure",
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    CONTENT_ENCRYPTION: "off",
    SIGNUPS_ENABLED: "true",
    RAKAZO_LOCAL_MODELS_URL: "http://127.0.0.1:6446/v1",
    RAKAZO_LOCAL_MODELS: "crouton-alpha-free,opencode/crouton-alpha-free",
    PI_DEFAULT_PROVIDER: "local",
    PI_DEFAULT_MODEL: "crouton-alpha-free"
  };
  try {
    console.log("[rakazo-cloud] Running database migrations...");
    execFileSync("node", ["--enable-source-maps", "apps/api/dist/cli/migrate-database.js"], { cwd: "/app", env, stdio: "inherit" });
    console.log("[rakazo-cloud] Bootstrapping owner account...");
    execFileSync("node", ["--enable-source-maps", "apps/api/dist/cli/bootstrap-owner.js"], { cwd: "/app", env, stdio: "inherit" });
  } catch (e) {
    console.error("[rakazo-cloud] Migration/bootstrap warning:", e.message);
  }
  const apiProc = spawn("node", ["--enable-source-maps", "apps/api/dist/index.js"], { cwd: "/app", env, stdio: "inherit" });
  const workerProc = spawn("node", ["--enable-source-maps", "apps/worker/dist/index.js"], { cwd: "/app", env, stdio: "inherit" });

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const r = await fetch("http://127.0.0.1:3100/ready");
      if (r.ok) {
        apiReady = true;
        console.log("[rakazo-cloud] API is ready! Signing in owner session...");
        const loginRes = await fetch("http://127.0.0.1:3100/api/auth/sign-in/email", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Origin": publicUrl },
          body: JSON.stringify({ email: env.OWNER_EMAIL, password: env.OWNER_PASSWORD })
        });
        const setCookie = loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : [loginRes.headers.get("set-cookie")].filter(Boolean);
        if (setCookie && setCookie.length) {
          ownerSessionCookie = setCookie.map((c) => c.split(";")[0]).join("; ");
          console.log("[rakazo-cloud] Captured owner session cookie for automatic sign-in.");
        }
        break;
      }
    } catch {}
  }
})();
