// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Interactive wizard to configure MS Teams channel in openclaw.json.
// Asks: appId, appPassword, tenantId, dmPolicy, groupPolicy, allowFrom.
// Teams/channels list is skipped — handled via pairing after setup.

"use strict";

const fs = require("fs");
const path = require("path");
const { prompt } = require("./credentials");

// ── Helpers ──────────────────────────────────────────────────────

function findOpenclawJson(startDir) {
  let dir = startDir || process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "openclaw.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: ~/.openclaw/openclaw.json
  const home = path.join(process.env.HOME || "/tmp", ".openclaw", "openclaw.json");
  if (fs.existsSync(home)) return home;
  return null;
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}

async function ask(question, defaultValue = "", opts = {}) {
  const hint = defaultValue ? ` [${defaultValue}]` : "";
  const answer = await prompt(`  ${question}${hint}: `, opts);
  return answer || defaultValue;
}

function validateGuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

// ── Wizard ───────────────────────────────────────────────────────

async function setupMsteams(opts = {}) {
  const configPath = opts.configPath || findOpenclawJson();

  console.log("");
  console.log("  MS Teams Setup");
  console.log("  ==============");
  console.log("");

  if (!configPath) {
    console.error("  Could not find openclaw.json.");
    console.error("  Run this command from your NemoClaw project directory.");
    process.exit(1);
  }

  console.log(`  Config: ${configPath}`);
  console.log("");

  const config = loadJson(configPath);
  const existing = config?.channels?.msteams || {};

  // ── Step 1: Azure Bot credentials ────────────────────────────

  console.log("  Step 1/4 — Azure Bot credentials");
  console.log("  Get these from: https://portal.azure.com > Azure Bot > Configuration");
  console.log("");

  let appId;
  while (true) {
    appId = await ask("App ID (GUID)", existing.appId || "");
    if (!appId) {
      console.error("  App ID is required.");
      continue;
    }
    if (!validateGuid(appId)) {
      console.error("  App ID must be a valid GUID).");
      continue;
    }
    break;
  }

  let appPassword;
  while (true) {
    appPassword = await ask("App Password (client secret)", "", { secret: true });
    if (!appPassword) {
      console.error("  App Password is required.");
      continue;
    }
    break;
  }

  let tenantId;
  while (true) {
    tenantId = await ask("Tenant ID (GUID)", existing.tenantId || "");
    if (!tenantId) {
      console.error("  Tenant ID is required.");
      continue;
    }
    if (!validateGuid(tenantId)) {
      console.error("  Tenant ID must be a valid GUID.");
      continue;
    }
    break;
  }

  // ── Step 2: Webhook port/path ─────────────────────────────────

  console.log("");
  console.log("  Step 2/6 — Webhook endpoint");
  console.log("  Teams delivers messages to this port/path on your host.");
  console.log("  Default port 3978 must be publicly reachable (or tunneled via ngrok/Tailscale).");
  console.log("");

  const existingPort = existing.webhook?.port || 3978;
  const existingPath = existing.webhook?.path || "/api/messages";

  let webhookPort;
  while (true) {
    const portRaw = await ask("Webhook port", String(existingPort));
    webhookPort = parseInt(portRaw, 10);
    if (!webhookPort || webhookPort < 1 || webhookPort > 65535) {
      console.error("  Must be a valid port number (1-65535).");
      continue;
    }
    break;
  }

  const webhookPath = await ask("Webhook path", existingPath);

  // ── Step 3: DM policy ────────────────────────────────────────

  console.log("");
  console.log("  Step 3/6 — DM policy");
  console.log("  Controls who can DM the bot directly.");
  console.log("    pairing   — only users who have been paired (recommended)");
  console.log("    allowlist — only users in allowFrom list");
  console.log("    open      — any user in the tenant can DM");
  console.log("    disabled  — DMs disabled");
  console.log("");

  let dmPolicy;
  while (true) {
    dmPolicy = (await ask("DM policy", existing.dmPolicy || "pairing")).toLowerCase().trim();
    if (!["pairing", "allowlist", "open", "disabled"].includes(dmPolicy)) {
      console.error("  Must be one of: pairing, allowlist, open, disabled");
      continue;
    }
    break;
  }

  // ── Step 4: Group policy ──────────────────────────────────────

  console.log("");
  console.log("  Step 4/6 — Group policy");
  console.log("  Controls which Teams channels/group chats the bot responds in.");
  console.log("    allowlist — only groups/channels in groupAllowFrom (recommended)");
  console.log("    open      — respond in any channel it is added to (mention-gated)");
  console.log("    disabled  — no group/channel responses");
  console.log("");

  let groupPolicy;
  while (true) {
    groupPolicy = (await ask("Group policy", existing.groupPolicy || "allowlist")).toLowerCase().trim();
    if (!["allowlist", "open", "disabled"].includes(groupPolicy)) {
      console.error("  Must be one of: allowlist, open, disabled");
      continue;
    }
    break;
  }

  // ── Step 5: allowFrom / groupAllowFrom ───────────────────────

  console.log("");
  console.log("  Step 5/6 — DM allowlist (optional)");
  console.log("  Comma-separated AAD object IDs allowed to DM the bot.");
  console.log("  Use stable AAD object IDs, not UPNs/display names.");
  console.log("  Leave blank to rely on dmPolicy alone.");
  console.log("");

  const existingAllowFrom = Array.isArray(existing.allowFrom) ? existing.allowFrom.join(", ") : "";
  const allowFromRaw = await ask("Allow from (DM)", existingAllowFrom);
  const allowFrom = allowFromRaw
    ? allowFromRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  let groupAllowFrom = [];
  if (groupPolicy === "allowlist") {
    console.log("");
    console.log("  Group allowlist — comma-separated AAD object IDs or UPNs allowed in group chats.");
    console.log("  Leave blank to inherit from DM allowFrom list.");
    console.log("");
    const existingGroupAllowFrom = Array.isArray(existing.groupAllowFrom) ? existing.groupAllowFrom.join(", ") : "";
    const groupAllowFromRaw = await ask("Group allow from", existingGroupAllowFrom);
    groupAllowFrom = groupAllowFromRaw
      ? groupAllowFromRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
  }

  // ── Step 6: requireMention ───────────────────────────────────

  console.log("");
  console.log("  Step 6/6 — Require @mention in channels/groups?");
  console.log("  When enabled, bot only responds when @mentioned (recommended).");
  console.log("");

  const requireMentionRaw = (await ask("Require @mention in groups/channels? [Y/n]", "Y")).toLowerCase().trim();
  const requireMention = requireMentionRaw !== "n";

  // ── Write config ─────────────────────────────────────────────

  if (!config.channels) config.channels = {};
  if (!config.plugins) config.plugins = {};
  if (!config.plugins.entries) config.plugins.entries = {};

  const existingTeams = existing.teams || {};

  config.channels.msteams = {
    enabled: true,
    appId: appId.trim(),
    appPassword,
    tenantId: tenantId.trim(),
    webhook: {
      port: webhookPort,
      path: webhookPath || "/api/messages",
    },
    dmPolicy,
    ...(allowFrom.length > 0 ? { allowFrom } : {}),
    groupPolicy,
    ...(groupPolicy === "allowlist" && groupAllowFrom.length > 0 ? { groupAllowFrom } : {}),
    requireMention,
    ...(Object.keys(existingTeams).length > 0 ? { teams: existingTeams } : {}),
  };

  config.plugins.entries.msteams = { enabled: true };

  saveJson(configPath, config);

  // Export env vars so patchStagedDockerfile() picks them up if called
  // in the same process (e.g. nemoclaw onboard after setup-msteams).
  process.env.MSTEAMS_APP_ID = appId.trim();
  process.env.MSTEAMS_APP_PASSWORD = appPassword;
  process.env.MSTEAMS_TENANT_ID = tenantId.trim();
  process.env.MSTEAMS_DM_POLICY = dmPolicy;
  process.env.MSTEAMS_GROUP_POLICY = groupPolicy;
  process.env.MSTEAMS_ALLOW_FROM = allowFrom.join(",");
  process.env.MSTEAMS_WEBHOOK_PORT = String(webhookPort);
  process.env.MSTEAMS_WEBHOOK_PATH = webhookPath || "/api/messages";

  console.log("");
  console.log("  MS Teams configuration saved.");
  console.log("");
  console.log("  Next steps:");
  console.log(`  1. In Azure Bot > Configuration, set Messaging endpoint:`);
  console.log(`     https://<your-public-host>:${webhookPort}${webhookPath || "/api/messages"}`);
  console.log("     (use ngrok or Tailscale Funnel for local dev)");
  console.log("  2. In Azure Bot > Channels, enable Microsoft Teams.");
  console.log("  3. Install the Teams app package (manifest.json + icons) into your team.");
  console.log("  4. Rebuild and restart the sandbox:");
  console.log("     nemoclaw onboard --resume");
  console.log("");
}

/**
 * Load MS Teams credentials từ openclaw.json vào process.env
 * để patchStagedDockerfile() có thể inject vào Dockerfile khi onboard.
 */
function loadMsteamsEnv(configPath) {
  const p = configPath || findOpenclawJson();
  if (!p) return;
  try {
    const cfg = loadJson(p);
    const ms = cfg?.channels?.msteams;
    if (!ms?.appId) return;
    process.env.MSTEAMS_APP_ID = ms.appId || "";
    process.env.MSTEAMS_APP_PASSWORD = ms.appPassword || "";
    process.env.MSTEAMS_TENANT_ID = ms.tenantId || "";
    process.env.MSTEAMS_DM_POLICY = ms.dmPolicy || "pairing";
    process.env.MSTEAMS_GROUP_POLICY = ms.groupPolicy || "allowlist";
    process.env.MSTEAMS_ALLOW_FROM = Array.isArray(ms.allowFrom) ? ms.allowFrom.join(",") : "";
    process.env.MSTEAMS_WEBHOOK_PORT = String(ms.webhook?.port || 3978);
    process.env.MSTEAMS_WEBHOOK_PATH = ms.webhook?.path || "/api/messages";
  } catch { /* ignore parse errors */ }
}

module.exports = { setupMsteams, loadMsteamsEnv };
