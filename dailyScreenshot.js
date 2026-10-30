#!/usr/bin/env node
// Daily job: open TARGET_URL with Playwright, screenshot it, post to Zoom.
// On any capture/upload failure, posts a text alert instead so a missed day
// is visible in the channel.
//
// Env (.env): TARGET_URL (required), SCREENSHOT_FULL_PAGE=true|false,
//             SCREENSHOT_MESSAGE (prefix text), KEEP_DAYS (default 30)

const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const { sendScreenshot, sendMessage } = require('./sendScreenshot');

const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');

function stamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

async function capture(url, filePath, fullPage) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    // 'networkidle' never fires on pages with analytics/chat widgets.
    await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForTimeout(Number(process.env.SETTLE_MS || 3000));
    await page.screenshot({ path: filePath, fullPage });
  } finally {
    await browser.close();
  }
}

async function pruneOld(keepDays) {
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  for (const name of await fs.readdir(SCREENSHOT_DIR)) {
    const p = path.join(SCREENSHOT_DIR, name);
    const { mtimeMs } = await fs.stat(p);
    if (mtimeMs < cutoff) await fs.unlink(p);
  }
}

async function main() {
  const url = process.env.TARGET_URL;
  if (!url) throw new Error('TARGET_URL is not set in .env');
  const fullPage = process.env.SCREENSHOT_FULL_PAGE !== 'false';
  const prefix = process.env.SCREENSHOT_MESSAGE || 'Daily snapshot';
  const keepDays = Number(process.env.KEEP_DAYS || 30);

  await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
  const now = new Date();
  const filePath = path.join(SCREENSHOT_DIR, `${stamp(now)}.png`);
  const when = now.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

  console.log(`[daily] Capturing ${url}`);
  await capture(url, filePath, fullPage);
  console.log(`[daily] Saved ${path.relative(__dirname, filePath)}`);

  const { fileId } = await sendScreenshot(filePath, `${prefix} – ${when}\n${url}`);
  console.log(`[daily] Posted to Zoom. File ID: ${fileId}`);

  await pruneOld(keepDays);
}

// sendScreenshot loads .env on use; load it here too so TARGET_URL is available.
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

main().catch(async (err) => {
  console.error(`[daily] Error: ${err.message}`);
  try {
    await sendMessage(`Daily screenshot FAILED (${process.env.TARGET_URL || 'no URL'}): ${err.message}`);
    console.error('[daily] Failure alert posted to Zoom.');
  } catch (alertErr) {
    console.error(`[daily] Could not post failure alert: ${alertErr.message}`);
  }
  process.exit(1);
});
