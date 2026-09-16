"use strict";

/**
 * Self-test for ts3-music-web (no TS3AudioBot required).
 * Run: npm run debug:test
 * If server.js is already listening on port 9090, also checks HTTP auth for /download.
 */

require("dotenv").config();
const assert = require("assert");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const DEFAULT_PORT = 9090;

function postJson(port, pathName, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathName,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = { _raw: text };
          }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function getReq(port, pathName, headers = {}) {
  return new Promise((resolve, reject) => {
    http
      .get({ hostname: "127.0.0.1", port, path: pathName, headers }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, len: Buffer.concat(chunks).length }));
      })
      .on("error", reject);
  });
}

function testStaticServerSource() {
  const serverPath = path.join(ROOT, "server.js");
  const code = fs.readFileSync(serverPath, "utf8");
  assert.ok(code.includes("function sessionTokenFromRequest"), "sessionTokenFromRequest should exist");
  assert.ok(code.includes("query.token"), "auth should accept query token for downloads");
  assert.ok(code.includes("botPollMs"), "botPollMs should exist");
  assert.ok(code.includes('socket.on("seek"'), "socket seek handler should exist");
  assert.ok(code.includes("confirmPhrase"), "deleteFile should require confirmPhrase");
  assert.ok(code.includes("mtime"), "scanMusic should include mtime");
  console.log("[debug-test] server.js static checks: OK");
}

function testStaticClient() {
  const htmlPath = path.join(ROOT, "public", "index.html");
  const html = fs.readFileSync(htmlPath, "utf8");
  assert.ok(html.includes("trackRowPlay"), "library row tap-to-play");
  assert.ok(html.includes("MediaMetadata") || html.includes("mediaSession"), "media session");
  assert.ok(html.includes("openAdmin"), "admin hub");
  assert.ok(html.includes("libSort"), "library sort");
  assert.ok(html.includes("x-session") && html.includes("dlFile"), "download via fetch + header");
  console.log("[debug-test] public/index.html static checks: OK");
}

async function testLiveIfRunning(port) {
  try {
    const ping = await getReq(port, "/");
    if (ping.status !== 200) throw new Error("unexpected status");
  } catch {
    console.log("[debug-test] no listener on", port, "- skip live HTTP checks");
    return;
  }

  const bad = await getReq(port, "/download/test.mp3?token=invalid");
  assert.strictEqual(bad.status, 401, "download with bad token should 401");

  const loginBad = await postJson(port, "/auth/login", { username: "x", password: "y" });
  assert.strictEqual(loginBad.status, 401, "bad login 401");

  // Uses whatever's actually in .env rather than a guessed credential.
  const ok = await postJson(port, "/auth/login", {
    username: process.env.WEB_USERNAME,
    password: process.env.WEB_PASSWORD,
  });
  if (ok.status !== 200 || !ok.json || !ok.json.token) {
    console.log("[debug-test] live: login failed with WEB_USERNAME/WEB_PASSWORD from .env — skip token tests");
    return;
  }
  const token = ok.json.token;

  const noAuth = await getReq(port, "/download/missing.mp3");
  assert.strictEqual(noAuth.status, 401, "download without auth 401");

  const q404 = await getReq(port, "/download/missing.mp3?token=" + encodeURIComponent(token));
  assert.strictEqual(q404.status, 404, "query token auth then 404 if file missing");

  const h404 = await getReq(port, "/download/missing.mp3", { "x-session": token });
  assert.strictEqual(h404.status, 404, "x-session header auth then 404");

  console.log("[debug-test] live HTTP checks on port", port, ": OK");
}

async function main() {
  testStaticServerSource();
  testStaticClient();
  const port = Number(process.env.WEB_PORT) || DEFAULT_PORT;
  try {
    await testLiveIfRunning(port);
  } catch (e) {
    console.error("[debug-test] live check error:", e.message);
    process.exitCode = 1;
  }
}

main();
