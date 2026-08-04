#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import vm from "node:vm";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const helperPath = path.join(repoRoot, "custom_modules/MMM-AgentSurface/node_helper.js");
let scenarios = 0;

function scenario(_name, run) {
  scenarios += 1;
  return run();
}

function fakeResponse() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

function fakeRequest({ headers = {}, body = {} } = {}) {
  return { headers, body };
}

function loadHelper() {
  const routes = [];
  const sent = [];
  const module = { exports: {} };
  const fakeNodeHelper = {
    create(definition) {
      return {
        expressApp: {
          post(routePath, handler) {
            routes.push({ method: "POST", path: routePath, handler });
          },
          get(routePath, handler) {
            routes.push({ method: "GET", path: routePath, handler });
          }
        },
        sendSocketNotification(notification, payload) {
          sent.push({ notification, payload });
        },
        ...definition
      };
    }
  };
  const sandbox = {
    module,
    exports: module.exports,
    console,
    process,
    Buffer,
    require(name) {
      if (name === "node_helper") return fakeNodeHelper;
      if (name === "crypto") return crypto;
      if (name === "fs") return fs;
      if (name === "path") return path;
      if (name === "./mirror-os-shell.js") return requireMirrorOsShell();
      // Control checks must not exercise real data-source collectors.
      if (name === "./providers/index.js") return [];
      throw new Error(`unexpected require: ${name}`);
    },
    __dirname: path.join(repoRoot, "custom_modules/MMM-AgentSurface")
  };
  vm.runInNewContext(readFileSync(helperPath, "utf8"), sandbox, { filename: helperPath });
  const helper = sandbox.module.exports;
  helper.start();
  return { helper, routes, sent };
}

function requireMirrorOsShell() {
  const shellPath = path.join(repoRoot, "custom_modules/MMM-AgentSurface/mirror-os-shell.js");
  const module = { exports: {} };
  vm.runInNewContext(readFileSync(shellPath, "utf8"), { module, exports: module.exports, globalThis: {} }, { filename: shellPath });
  return module.exports;
}

function authHeaders(token = "test-control-token") {
  return { authorization: `Bearer ${token}` };
}

// Dispatch like an HTTP client: match method AND path against registered
// routes so method registration semantics are actually exercised.
async function dispatch(routes, method, routePath, req) {
  const pathMatches = routes.filter((route) => route.path === routePath);
  if (pathMatches.length === 0) return { statusCode: 404, body: { ok: false, errors: ["no route registered for path"] } };
  const route = pathMatches.find((entry) => entry.method === method);
  if (!route) return { statusCode: 405, body: { ok: false, errors: ["method not registered for path"] } };
  const res = fakeResponse();
  const result = route.handler(req, res);
  if (result && typeof result.then === "function") await result;
  return res;
}

function reportPages(helper, state = {}) {
  helper.socketNotificationReceived("MMM_AGENT_SURFACE_PAGE_STATE", {
    currentPageId: "home",
    rotationPaused: false,
    lastCommandSource: "system",
    pages: ["home", "agents", "calendar", "weather", "path", "sports"],
    ...state
  });
}

const previousToken = process.env.MIRROR_CONTROL_TOKEN;
process.env.MIRROR_CONTROL_TOKEN = "test-control-token";

try {
  await scenario("control routes require configured token", async () => {
    delete process.env.MIRROR_CONTROL_TOKEN;
    const { routes } = loadHelper();
    const res = await dispatch(routes, "GET", "/MMM-AgentSurface/api/control/state", fakeRequest({ headers: authHeaders() }));
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.errors[0], "MIRROR_CONTROL_TOKEN is required for page control");
    process.env.MIRROR_CONTROL_TOKEN = "test-control-token";
  });

  await scenario("unauthorized controls are rejected", async () => {
    const { routes } = loadHelper();
    const res = await dispatch(routes, "POST", "/MMM-AgentSurface/api/control", fakeRequest({ headers: authHeaders("wrong"), body: { command: "next" } }));
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.errors[0], "unauthorized");
  });

  await scenario("wrong-length and equal-length wrong tokens are both rejected, correct token accepted", async () => {
    const { helper, routes } = loadHelper();
    const configured = "test-control-token";
    const wrongSameLength = "x".repeat(configured.length);
    assert.notEqual(wrongSameLength, configured);
    for (const bad of ["a", wrongSameLength, configured + "-suffix"]) {
      const res = await dispatch(routes, "POST", "/MMM-AgentSurface/api/control", fakeRequest({ headers: authHeaders(bad), body: { command: "next" } }));
      assert.equal(res.statusCode, 401, `token ${JSON.stringify(bad)} must be rejected`);
    }
    const ok = await dispatch(routes, "POST", "/MMM-AgentSurface/api/control", fakeRequest({ headers: authHeaders(configured), body: { command: "next" } }));
    assert.equal(ok.statusCode, 200);
    // Length-mismatched inputs must go through the same fixed-length
    // comparison path without throwing (crypto.timingSafeEqual throws on
    // unequal buffer lengths when inputs are not hashed first).
    assert.equal(helper.timingSafeEqualString("short", "a-much-longer-token-value"), false);
    assert.equal(helper.timingSafeEqualString(configured, configured), true);
    assert.equal(helper.timingSafeEqualString("", configured), false);
  });

  await scenario("show fails closed until the display module reports its page registry", async () => {
    const { routes } = loadHelper();
    const res = await dispatch(routes, "POST", "/MMM-AgentSurface/api/control", fakeRequest({ headers: authHeaders(), body: { command: "show", pageId: "weather" } }));
    assert.equal(res.statusCode, 503);
    assert.match(res.body.errors[0], /page registry not reported/);
  });

  await scenario("valid commands emit socket controls", async () => {
    const { helper, routes, sent } = loadHelper();
    reportPages(helper);
    const res = await dispatch(routes, "POST", "/MMM-AgentSurface/api/control", fakeRequest({ headers: authHeaders(), body: { command: "show", pageId: "weather" } }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.accepted.command, "show");
    assert.equal(res.body.accepted.pageId, "weather");
    assert.equal(sent.at(-1).notification, "MMM_AGENT_SURFACE_CONTROL");
    assert.equal(sent.at(-1).payload.command, "show");
  });

  await scenario("show validates against the configured page set, not the fallback order", async () => {
    const { helper, routes, sent } = loadHelper();
    reportPages(helper, { pages: ["home", "agents"] });
    const before = sent.length;
    const rejected = await dispatch(routes, "POST", "/MMM-AgentSurface/api/control", fakeRequest({ headers: authHeaders(), body: { command: "show", pageId: "sports" } }));
    assert.equal(rejected.statusCode, 400, "fallback-only page must be rejected when config narrows the page set");
    assert.match(rejected.body.errors[0], /pageId must be one of: home, agents/);
    assert.equal(sent.length, before, "rejected show must not emit a socket control");
    const accepted = await dispatch(routes, "POST", "/MMM-AgentSurface/api/control", fakeRequest({ headers: authHeaders(), body: { command: "show", pageId: "agents" } }));
    assert.equal(accepted.statusCode, 200);
    assert.equal(sent.at(-1).payload.pageId, "agents");
  });

  await scenario("invalid page names leave state unchanged", async () => {
    const { helper, routes } = loadHelper();
    reportPages(helper, { currentPageId: "agents", lastCommandSource: "command" });
    const res = await dispatch(routes, "POST", "/MMM-AgentSurface/api/control", fakeRequest({ headers: authHeaders(), body: { command: "show", pageId: "not-a-page" } }));
    assert.equal(res.statusCode, 400);
    assert.match(res.body.errors[0], /pageId must be one of/);
    assert.equal(res.body.state.currentPageId, "agents");
  });

  await scenario("current page state is observable", async () => {
    const { helper, routes } = loadHelper();
    reportPages(helper, { currentPageId: "path", rotationPaused: true, lastCommandSource: "command" });
    const res = await dispatch(routes, "GET", "/MMM-AgentSurface/api/control/state", fakeRequest({ headers: authHeaders() }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.state.currentPageId, "path");
    assert.equal(res.body.state.rotationPaused, true);
    assert.equal(res.body.state.lastCommandSource, "command");
  });

  await scenario("next previous pause and resume commands are accepted", async () => {
    const { routes, sent } = loadHelper();
    for (const command of ["next", "previous", "pause", "resume"]) {
      const res = await dispatch(routes, "POST", "/MMM-AgentSurface/api/control", fakeRequest({ headers: authHeaders(), body: { command } }));
      assert.equal(res.statusCode, 200);
      assert.equal(sent.at(-1).payload.command, command);
    }
  });

  await scenario("command source defaults to command and forwards to the display", async () => {
    const { helper, routes, sent } = loadHelper();
    reportPages(helper);
    const omitted = await dispatch(routes, "POST", "/MMM-AgentSurface/api/control", fakeRequest({ headers: authHeaders(), body: { command: "next" } }));
    assert.equal(omitted.statusCode, 200);
    assert.equal(sent.at(-1).payload.source, "command", "omitted source must default to command");
    const voice = await dispatch(routes, "POST", "/MMM-AgentSurface/api/control", fakeRequest({ headers: authHeaders(), body: { command: "show", pageId: "weather", source: " VOICE " } }));
    assert.equal(voice.statusCode, 200);
    assert.equal(voice.body.accepted.source, "voice", "source must be trimmed/lowercased");
    assert.equal(sent.at(-1).payload.source, "voice");
    const remote = await dispatch(routes, "POST", "/MMM-AgentSurface/api/control", fakeRequest({ headers: authHeaders(), body: { command: "pause", source: "remote" } }));
    assert.equal(remote.statusCode, 200);
    assert.equal(sent.at(-1).payload.source, "remote");
  });

  await scenario("unknown command sources fail closed without emitting controls", async () => {
    const { helper, routes, sent } = loadHelper();
    reportPages(helper);
    const before = sent.length;
    for (const bad of ["alexa", "", 7, { source: "voice" }]) {
      const res = await dispatch(routes, "POST", "/MMM-AgentSurface/api/control", fakeRequest({ headers: authHeaders(), body: { command: "next", source: bad } }));
      assert.equal(res.statusCode, 400, `source ${JSON.stringify(bad)} must be rejected`);
      assert.match(res.body.errors[0], /source must be one of: command, remote, voice/);
    }
    assert.equal(sent.length, before, "rejected sources must not emit socket controls");
  });

  await scenario("http methods are enforced per route", async () => {
    const { routes } = loadHelper();
    const wrongMethodOnControl = await dispatch(routes, "GET", "/MMM-AgentSurface/api/control", fakeRequest({ headers: authHeaders() }));
    assert.equal(wrongMethodOnControl.statusCode, 405, "GET must not reach the control POST handler");
    const wrongMethodOnState = await dispatch(routes, "POST", "/MMM-AgentSurface/api/control/state", fakeRequest({ headers: authHeaders() }));
    assert.equal(wrongMethodOnState.statusCode, 405, "POST must not reach the state GET handler");
    const unknownPath = await dispatch(routes, "POST", "/MMM-AgentSurface/api/nope", fakeRequest({ headers: authHeaders() }));
    assert.equal(unknownPath.statusCode, 404);
  });

  await scenario("state exposes the page registry fail-closed", async () => {
    const { helper, routes } = loadHelper();
    const before = await dispatch(routes, "GET", "/MMM-AgentSurface/api/control/state", fakeRequest({ headers: authHeaders() }));
    assert.equal(before.statusCode, 200);
    assert.equal(before.body.pages, null, "pages must be null until the display module reports its registry");
    reportPages(helper, { pages: ["home", "agents", "path"] });
    const after = await dispatch(routes, "GET", "/MMM-AgentSurface/api/control/state", fakeRequest({ headers: authHeaders() }));
    assert.equal(after.statusCode, 200);
    // JSON round-trip: helper objects come from a separate vm realm, so
    // strict deepEqual would fail on prototype identity alone.
    assert.equal(JSON.stringify(after.body.pages), JSON.stringify([
      { id: "home", label: "Home" },
      { id: "agents", label: "Agents" },
      { id: "path", label: "PATH" }
    ]));
  });

  await scenario("remote page is served as static HTML without secrets", async () => {
    const { routes } = loadHelper();
    // The shell itself is unauthenticated by design: it must carry no data
    // and no token material — everything stateful goes through the control API.
    const res = await dispatch(routes, "GET", "/MMM-AgentSurface/remote", fakeRequest());
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"], /text\/html/);
    assert.match(res.body, /<!doctype html>/i);
    assert.ok(!res.body.includes(process.env.MIRROR_CONTROL_TOKEN), "remote HTML must not embed the control token");
    assert.match(res.body, /\/MMM-AgentSurface\/api\/control/, "remote must target the authenticated control API");
    const wrongMethod = await dispatch(routes, "POST", "/MMM-AgentSurface/remote", fakeRequest());
    assert.equal(wrongMethod.statusCode, 405);
  });

  await scenario("remote page never weakens control auth", async () => {
    const { helper, routes } = loadHelper();
    reportPages(helper);
    await dispatch(routes, "GET", "/MMM-AgentSurface/remote", fakeRequest());
    const noAuthState = await dispatch(routes, "GET", "/MMM-AgentSurface/api/control/state", fakeRequest());
    assert.equal(noAuthState.statusCode, 401, "state must stay closed without a token even after the remote shell is served");
    const noAuthCommand = await dispatch(routes, "POST", "/MMM-AgentSurface/api/control", fakeRequest({ body: { command: "pause" } }));
    assert.equal(noAuthCommand.statusCode, 401, "control must stay closed without a token even after the remote shell is served");
  });

  console.log(JSON.stringify({ ok: true, scenarios }));
} catch (error) {
  console.error(error.message);
  process.exit(1);
} finally {
  if (previousToken === undefined) delete process.env.MIRROR_CONTROL_TOKEN;
  else process.env.MIRROR_CONTROL_TOKEN = previousToken;
}
