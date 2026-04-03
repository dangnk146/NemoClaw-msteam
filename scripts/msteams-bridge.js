#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * MS Teams → NemoClaw host-side bridge.
 *
 * Runs on the HOST (not inside the sandbox). Receives Bot Framework
 * webhook POSTs from Microsoft Teams, forwards the message to the
 * OpenClaw agent inside the sandbox via SSH, then sends the reply
 * back to Teams using the Bot Framework REST API.
 *
 * This mirrors the Telegram bridge pattern — no outbound connections
 * from inside the sandbox are needed for Teams messaging.
 *
 * Env:
 *   MSTEAMS_APP_ID       — Azure Bot app ID
 *   MSTEAMS_APP_PASSWORD — Azure Bot app password (client secret)
 *   MSTEAMS_TENANT_ID    — Azure AD tenant ID (or "common")
 *   MSTEAMS_WEBHOOK_PORT — Port to listen on (default: 3978)
 *   MSTEAMS_WEBHOOK_PATH — Webhook path (default: /api/messages)
 *   SANDBOX_NAME         — Sandbox name (default: nemoclaw)
 *   NVIDIA_API_KEY       — For inference inside sandbox
 */

"use strict";

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { execFileSync, spawn } = require("child_process");
const { resolveOpenshell } = require("../bin/lib/resolve-openshell");
const { shellQuote, validateName } = require("../bin/lib/runner");

const OPENSHELL = resolveOpenshell();
if (!OPENSHELL) {
  console.error("[msteams-bridge] openshell not found on PATH");
  process.exit(1);
}

const APP_ID       = process.env.MSTEAMS_APP_ID;
const APP_PASSWORD = process.env.MSTEAMS_APP_PASSWORD;
const TENANT_ID    = process.env.MSTEAMS_TENANT_ID || "common";
const PORT         = parseInt(process.env.MSTEAMS_WEBHOOK_PORT || "3978", 10);
const PATH_PREFIX  = process.env.MSTEAMS_WEBHOOK_PATH || "/api/messages";
const SANDBOX      = process.env.SANDBOX_NAME || "nemoclaw";
const API_KEY      = process.env.NVIDIA_API_KEY || "";

try { validateName(SANDBOX, "SANDBOX_NAME"); } catch (e) { console.error(e.message); process.exit(1); }

if (!APP_ID || !APP_PASSWORD) {
  console.error("[msteams-bridge] MSTEAMS_APP_ID and MSTEAMS_APP_PASSWORD are required");
  process.exit(1);
}

// ── Bot Framework token cache ─────────────────────────────────────

let _tokenCache = null;

async function getBotToken() {
  const now = Date.now();
  if (_tokenCache && _tokenCache.expiresAt > now + 60_000) {
    return _tokenCache.token;
  }

  const body = new URLSearchParams({
    grant_type:    "client_credentials",
    client_id:     APP_ID,
    client_secret: APP_PASSWORD,
    scope:         "https://api.botframework.com/.default",
  }).toString();

  const token = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "login.microsoftonline.com",
      path:     `/${TENANT_ID}/oauth2/v2.0/token`,
      method:   "POST",
      headers:  {
        "Content-Type":   "application/x-www-form-urlencoded",
        "Content-Length":  Buffer.byteLength(body),
      },
    }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        try {
          const data = JSON.parse(buf);
          if (data.access_token) resolve(data);
          else reject(new Error(`Token error: ${buf}`));
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });

  _tokenCache = {
    token:     token.access_token,
    expiresAt: now + (token.expires_in || 3600) * 1000,
  };
  return _tokenCache.token;
}

// ── Send reply to Teams ───────────────────────────────────────────

async function sendReply(serviceUrl, conversationId, activityId, text) {
  const token = await getBotToken();
  const url   = new URL(`v3/conversations/${conversationId}/activities/${activityId}`, serviceUrl);

  const body = JSON.stringify({
    type:      "message",
    text,
    from:      { id: APP_ID },
    replyToId: activityId,
  });

  return new Promise((resolve, reject) => {
    const opts = {
      hostname: url.hostname,
      path:     url.pathname,
      method:   "POST",
      headers:  {
        "Content-Type":   "application/json",
        "Content-Length":  Buffer.byteLength(body),
        "Authorization":  `Bearer ${token}`,
      },
    };
    const req = https.request(opts, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Run agent inside sandbox (same as telegram-bridge) ────────────

function runAgentInSandbox(message, sessionId) {
  return new Promise((resolve) => {
    let sshConfig;
    try {
      sshConfig = execFileSync(OPENSHELL, ["sandbox", "ssh-config", SANDBOX], { encoding: "utf-8" });
    } catch (e) {
      return resolve(`Error connecting to sandbox: ${e.message}`);
    }

    const fs       = require("fs");
    const confDir  = fs.mkdtempSync("/tmp/nemoclaw-ms-ssh-");
    const confPath = `${confDir}/config`;
    fs.writeFileSync(confPath, sshConfig, { mode: 0o600 });

    const safeSession = String(sessionId).replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40);
    const cmd = `export NVIDIA_API_KEY=${shellQuote(API_KEY)} && openclaw agent --agent main --local -m ${shellQuote(message)} --session-id ${shellQuote("ms-" + safeSession)}`;

    const proc = spawn("ssh", ["-T", "-F", confPath, `openshell-${SANDBOX}`, cmd], {
      timeout: 120_000,
      stdio:   ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));

    proc.on("close", (code) => {
      try { fs.unlinkSync(confPath); fs.rmdirSync(confDir); } catch { /* ignored */ }

      const lines = stdout.split("\n").filter((l) =>
        !l.startsWith("Setting up NemoClaw") &&
        !l.startsWith("[plugins]") &&
        !l.startsWith("(node:") &&
        !l.includes("NemoClaw ready") &&
        !l.includes("NemoClaw registered") &&
        !l.includes("┌─") && !l.includes("│ ") && !l.includes("└─") &&
        l.trim() !== "",
      );

      const response = lines.join("\n").trim();
      if (response)        resolve(response);
      else if (code !== 0) resolve(`Agent exited with code ${code}. ${stderr.trim().slice(0, 500)}`);
      else                 resolve("(no response)");
    });

    proc.on("error", (err) => resolve(`Error: ${err.message}`));
  });
}

// ── Webhook server ────────────────────────────────────────────────

const busyConversations = new Set();

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== PATH_PREFIX) {
    res.writeHead(404);
    res.end();
    return;
  }

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    let activity;
    try { activity = JSON.parse(body); } catch {
      res.writeHead(400);
      res.end("Bad JSON");
      return;
    }

    // Acknowledge immediately — Teams retries if no 200 within 5s
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");

    if (activity.type !== "message" || !activity.text) return;

    const convId     = activity.conversation?.id;
    const actId      = activity.id;
    const serviceUrl = activity.serviceUrl;
    const text       = activity.text?.trim();
    const sender     = activity.from?.name || activity.from?.id || "unknown";
    const sessionId  = convId ? crypto.createHash("md5").update(convId).digest("hex").slice(0, 12) : "default";

    if (!convId || !actId || !serviceUrl || !text) return;

    console.log(`[teams] ${sender}: ${text.slice(0, 100)}`);

    if (busyConversations.has(convId)) {
      await sendReply(serviceUrl, convId, actId, "Still processing your previous message.").catch(() => {});
      return;
    }

    busyConversations.add(convId);
    try {
      const reply = await runAgentInSandbox(text, sessionId);
      console.log(`[teams] agent reply: ${reply.slice(0, 100)}...`);
      const result = await sendReply(serviceUrl, convId, actId, reply);
      if (result.status >= 400) {
        console.error(`[teams] reply failed (${result.status}): ${result.body.slice(0, 200)}`);
      }
    } catch (err) {
      console.error(`[teams] reply error: ${err.message}`);
      await sendReply(serviceUrl, convId, actId, `Error: ${err.message}`).catch(() => {});
    } finally {
      busyConversations.delete(convId);
    }
  });
});

server.listen(PORT, () => {
  console.log("");
  console.log("  ┌─────────────────────────────────────────────────────┐");
  console.log("  │  NemoClaw MS Teams Bridge                           │");
  console.log("  │                                                     │");
  console.log(`  │  Listening: http://0.0.0.0:${PORT}${PATH_PREFIX.padEnd(24)}│`);
  console.log(`  │  Sandbox:   ${(SANDBOX + "                              ").slice(0, 40)}│`);
  console.log("  │                                                     │");
  console.log("  │  Set Azure Bot messaging endpoint to:               │");
  console.log(`  │  https://<your-host>:${PORT}${PATH_PREFIX.padEnd(20)}    │`);
  console.log("  └─────────────────────────────────────────────────────┘");
  console.log("");
});
