// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const os = require("os");
const path = require("path");

const NOTICE_ACCEPT_FLAG = "--yes-i-accept-third-party-software";
const NOTICE_ACCEPT_ENV = "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE";
const NOTICE_CONFIG_FILE = path.join(__dirname, "usage-notice.json");

function getUsageNoticeStateFile() {
  return path.join(process.env.HOME || os.homedir(), ".nemoclaw", "usage-notice.json");
}

function loadUsageNoticeConfig() {
  return JSON.parse(fs.readFileSync(NOTICE_CONFIG_FILE, "utf8"));
}

function hasAcceptedUsageNotice(version) {
  try {
    const saved = JSON.parse(fs.readFileSync(getUsageNoticeStateFile(), "utf8"));
    return saved?.acceptedVersion === version;
  } catch {
    return false;
  }
}

function saveUsageNoticeAcceptance(version) {
  const stateFile = getUsageNoticeStateFile();
  const dir = path.dirname(stateFile);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(
    stateFile,
    JSON.stringify({ acceptedVersion: version, acceptedAt: new Date().toISOString() }, null, 2),
    { mode: 0o600 },
  );
  fs.chmodSync(stateFile, 0o600);
}

function printUsageNotice(config = loadUsageNoticeConfig(), writeLine = console.error) {
  writeLine("");
  writeLine(`  ${config.title}`);
  writeLine("  ──────────────────────────────────────────────────");
  for (const line of config.body || []) {
    writeLine(`  ${line}`);
  }
  writeLine("");
}

async function ensureUsageNoticeConsent({
  nonInteractive = false,
  acceptedByFlag = false,
  promptFn = null,
  writeLine = console.error,
} = {}) {
  const config = loadUsageNoticeConfig();
  if (hasAcceptedUsageNotice(config.version)) {
    return true;
  }

  printUsageNotice(config, writeLine);

  if (nonInteractive) {
    if (!acceptedByFlag) {
      writeLine(
        `  Non-interactive onboarding requires ${NOTICE_ACCEPT_FLAG} or ${NOTICE_ACCEPT_ENV}=1.`,
      );
      return false;
    }
    writeLine(
      `  [non-interactive] Third-party software notice accepted via ${NOTICE_ACCEPT_FLAG}.`,
    );
    saveUsageNoticeAcceptance(config.version);
    return true;
  }

  if (!process.stdin.isTTY) {
    writeLine(
      `  Interactive onboarding requires a TTY. Re-run in a terminal or use --non-interactive with ${NOTICE_ACCEPT_FLAG}.`,
    );
    return false;
  }

  const ask = promptFn || require("./credentials").prompt;
  const answer = String(await ask(`  ${config.interactivePrompt}`))
    .trim()
    .toLowerCase();
  if (answer !== "yes") {
    writeLine("  Installation cancelled.");
    return false;
  }

  saveUsageNoticeAcceptance(config.version);
  return true;
}

async function cli(args = process.argv.slice(2)) {
  const acceptedByFlag =
    args.includes(NOTICE_ACCEPT_FLAG) || String(process.env[NOTICE_ACCEPT_ENV] || "") === "1";
  const nonInteractive = args.includes("--non-interactive");
  const ok = await ensureUsageNoticeConsent({
    nonInteractive,
    acceptedByFlag,
    writeLine: console.error,
  });
  process.exit(ok ? 0 : 1);
}

if (require.main === module) {
  cli().catch((error) => {
    console.error(error?.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  NOTICE_ACCEPT_ENV,
  NOTICE_ACCEPT_FLAG,
  NOTICE_CONFIG_FILE,
  ensureUsageNoticeConsent,
  getUsageNoticeStateFile,
  hasAcceptedUsageNotice,
  loadUsageNoticeConfig,
  printUsageNotice,
  saveUsageNoticeAcceptance,
};
