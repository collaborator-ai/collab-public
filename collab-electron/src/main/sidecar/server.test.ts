// src/main/sidecar/server.test.ts
//
// Integration tests for SidecarServer. Must run with node (not bun)
// because node-pty's native addon requires node's libuv event loop.
//
// Run: cd collab-electron && npx tsx --test src/main/sidecar/server.test.ts

import { describe, it, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { SidecarServer } from "./server";
import {
  makeRequest,
  type JsonRpcResponse,
  type JsonRpcNotification,
  type PingResult,
  type SessionCreateResult,
  type SessionReconnectResult,
  type SessionInfo,
} from "./protocol";

// Use short temp dir to stay under macOS 104-byte sun_path limit
const TEST_DIR = path.join(os.tmpdir(), `sc-${process.pid}`);
const CONTROL_SOCK = process.platform === "win32"
  ? `\\\\.\\pipe\\sc-${process.pid}-ctrl`
  : path.join(TEST_DIR, "ctrl.sock");
const SESSION_DIR = path.join(TEST_DIR, "s");
const PID_PATH = path.join(TEST_DIR, "pid");
const TOKEN = "test-token-abc123";

const TEST_CWD = process.platform === "win32" ? os.tmpdir() : "/tmp";
const TEST_SHELL = process.platform === "win32"
  ? {
    command: "powershell.exe",
    args: ["-NoLogo"],
    displayName: "PowerShell",
    target: "powershell",
    echo: (marker: string) => `Write-Output '${marker}'\n`,
    exit: "exit\r",
  }
  : {
    command: "/bin/sh",
    args: [],
    displayName: "sh",
    target: "shell",
    echo: (marker: string) => `echo ${marker}\n`,
    exit: "exit\n",
  };

let server: SidecarServer | null = null;

afterEach(async () => {
  if (server) {
    await server.shutdown();
    server = null;
  }
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

function connectControl(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(CONTROL_SOCK, () => resolve(sock));
    sock.on("error", reject);
  });
}

function rpcCall(
  sock: net.Socket,
  id: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  return new Promise((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        sock.off("data", onData);
        resolve(JSON.parse(buf.slice(0, nl)));
      }
    };
    sock.on("data", onData);
    sock.write(makeRequest(id, method, params));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connectDataSocket(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(socketPath, () => resolve(s));
    s.on("error", reject);
  });
}

function waitForOutput(
  sock: net.Socket,
  marker: string,
  timeoutMs = 5000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      sock.off("data", onData);
      reject(
        new Error(
          `Timed out waiting for "${marker}". Got: ${JSON.stringify(buf)}`,
        ),
      );
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      if (buf.includes(marker)) {
        clearTimeout(timer);
        sock.off("data", onData);
        resolve(buf);
      }
    };
    sock.on("data", onData);
  });
}

async function waitForNotification(
  messages: Array<JsonRpcNotification | JsonRpcResponse>,
  method: string,
  timeoutMs = 5000,
): Promise<JsonRpcNotification> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const notification = messages.find(
      (message) => "method" in message && message.method === method,
    );
    if (notification) {
      return notification as JsonRpcNotification;
    }
    await sleep(50);
  }

  throw new Error(`Timed out waiting for ${method}`);
}

function createServer(): SidecarServer {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  return new SidecarServer({
    controlSocketPath: CONTROL_SOCK,
    sessionSocketDir: SESSION_DIR,
    pidFilePath: PID_PATH,
    token: TOKEN,
  });
}

async function createSession(
  ctrl: net.Socket,
  id: number,
): Promise<SessionCreateResult> {
  const resp = await rpcCall(ctrl, id, "session.create", {
    command: TEST_SHELL.command,
    args: TEST_SHELL.args,
    displayName: TEST_SHELL.displayName,
    target: TEST_SHELL.target,
    cwdHostPath: TEST_CWD,
    cwd: TEST_CWD,
    cols: 80,
    rows: 24,
  });
  return resp.result as SessionCreateResult;
}

function earlyOutputShell(marker: string): {
  command: string;
  args: string[];
  displayName: string;
  target: string;
} {
  if (process.platform === "win32") {
    return {
      command: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoExit",
        "-Command",
        `Write-Output '${marker}'`,
      ],
      displayName: "PowerShell",
      target: "powershell",
    };
  }

  return {
    command: "/bin/sh",
    args: ["-lc", `echo ${marker}; exec /bin/sh`],
    displayName: "sh",
    target: "shell",
  };
}

function exitSoonShell(): {
  command: string;
  args: string[];
  displayName: string;
  target: string;
} {
  if (process.platform === "win32") {
    return {
      command: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-Command",
        "Start-Sleep -Milliseconds 200; exit 0",
      ],
      displayName: "PowerShell",
      target: "powershell",
    };
  }

  return {
    command: "/bin/sh",
    args: ["-lc", "sleep 0.2; exit 0"],
    displayName: "sh",
    target: "shell",
  };
}

/**
 * Collect newline-delimited JSON messages from a socket
 * into a shared array, useful for listening for notifications.
 */
function collectMessages(
  sock: net.Socket,
  dest: Array<JsonRpcNotification | JsonRpcResponse>,
): void {
  let buf = "";
  sock.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) {
        dest.push(JSON.parse(line));
      }
    }
  });
}

describe("SidecarServer", () => {
  it("starts and responds to ping", async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    server = new SidecarServer({
      controlSocketPath: CONTROL_SOCK,
      sessionSocketDir: SESSION_DIR,
      pidFilePath: PID_PATH,
      token: TOKEN,
      });
    await server.start();

    const sock = await connectControl();
    const resp = await rpcCall(sock, 1, "sidecar.ping");
    const result = resp.result as PingResult;

    assert.equal(result.token, TOKEN);
    assert.equal(result.pid, process.pid);
    assert.equal(typeof result.uptime, "number");

    sock.destroy();
  });
});

describe("SidecarServer session lifecycle", () => {
  it("session.create spawns a shell and returns socketPath", async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    server = new SidecarServer({
      controlSocketPath: CONTROL_SOCK,
      sessionSocketDir: SESSION_DIR,
      pidFilePath: PID_PATH,
      token: TOKEN,
      });
    await server.start();

    const sock = await connectControl();
    const resp = await rpcCall(sock, 1, "session.create", {
      command: TEST_SHELL.command,
      args: TEST_SHELL.args,
      displayName: TEST_SHELL.displayName,
      target: TEST_SHELL.target,
      cwdHostPath: TEST_CWD,
      cwd: TEST_CWD,
      cols: 80,
      rows: 24,
    });

    const result = resp.result as SessionCreateResult;
    assert.match(result.sessionId, /^[0-9a-f]{16}$/);
    assert.ok(result.socketPath.includes(result.sessionId));
    if (process.platform !== "win32") {
      assert.ok(fs.existsSync(result.socketPath));
    }

    sock.destroy();
  });

  it("data socket sends PTY output", async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    server = new SidecarServer({
      controlSocketPath: CONTROL_SOCK,
      sessionSocketDir: SESSION_DIR,
      pidFilePath: PID_PATH,
      token: TOKEN,
      });
    await server.start();

    const ctrl = await connectControl();
    const createResp = await rpcCall(ctrl, 1, "session.create", {
      command: TEST_SHELL.command,
      args: TEST_SHELL.args,
      displayName: TEST_SHELL.displayName,
      target: TEST_SHELL.target,
      cwdHostPath: TEST_CWD,
      cwd: TEST_CWD,
      cols: 80,
      rows: 24,
    });
    const { socketPath } =
      createResp.result as SessionCreateResult;

    // Connect data socket
    const data = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection(socketPath, () => resolve(s));
      s.on("error", reject);
    });

    // Send a command and wait for output
    data.write(TEST_SHELL.echo("sidecar-test-output"));
    const output = await new Promise<string>((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => {
        data.off("data", onData);
        reject(new Error(
          `Timed out waiting for PTY output. Got: ${JSON.stringify(buf)}`,
        ));
      }, 5000);
      const onData = (chunk: Buffer) => {
        buf += chunk.toString();
        if (buf.includes("sidecar-test-output")) {
          clearTimeout(timer);
          data.off("data", onData);
          resolve(buf);
        }
      };
      data.on("data", onData);
    });

    assert.ok(output.includes("sidecar-test-output"));

    data.destroy();
    ctrl.destroy();
  });

  it("replays early PTY output to the first attached data client", async () => {
    server = createServer();
    await server.start();

    const ctrl = await connectControl();
    const marker = "early-sidecar-marker";
    const shell = earlyOutputShell(marker);
    const createResp = await rpcCall(ctrl, 1, "session.create", {
      command: shell.command,
      args: shell.args,
      displayName: shell.displayName,
      target: shell.target,
      cwdHostPath: TEST_CWD,
      cwd: TEST_CWD,
      cols: 80,
      rows: 24,
    });
    const { socketPath } = createResp.result as SessionCreateResult;

    await sleep(300);

    const data = await connectDataSocket(socketPath);
    const output = await waitForOutput(data, marker);

    assert.ok(output.includes(marker));

    data.destroy();
    ctrl.destroy();
  });

  it("session.list returns created sessions", async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    server = new SidecarServer({
      controlSocketPath: CONTROL_SOCK,
      sessionSocketDir: SESSION_DIR,
      pidFilePath: PID_PATH,
      token: TOKEN,
      });
    await server.start();

    const sock = await connectControl();
    await rpcCall(sock, 1, "session.create", {
      command: TEST_SHELL.command,
      args: TEST_SHELL.args,
      displayName: TEST_SHELL.displayName,
      target: TEST_SHELL.target,
      cwdHostPath: TEST_CWD,
      cwd: TEST_CWD,
      cols: 80,
      rows: 24,
    });

    const listResp = await rpcCall(sock, 2, "session.list");
    const { sessions } =
      listResp.result as { sessions: SessionInfo[] };
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].shell, TEST_SHELL.command);

    sock.destroy();
  });

  it("session.kill removes session from list", async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    server = new SidecarServer({
      controlSocketPath: CONTROL_SOCK,
      sessionSocketDir: SESSION_DIR,
      pidFilePath: PID_PATH,
      token: TOKEN,
      });
    await server.start();

    const sock = await connectControl();
    const createResp = await rpcCall(sock, 1, "session.create", {
      command: TEST_SHELL.command,
      args: TEST_SHELL.args,
      displayName: TEST_SHELL.displayName,
      target: TEST_SHELL.target,
      cwdHostPath: TEST_CWD,
      cwd: TEST_CWD,
      cols: 80,
      rows: 24,
    });
    const { sessionId } =
      createResp.result as SessionCreateResult;

    await rpcCall(sock, 2, "session.kill", { sessionId });

    const listResp = await rpcCall(sock, 3, "session.list");
    const { sessions } =
      listResp.result as { sessions: SessionInfo[] };
    assert.equal(sessions.length, 0);

    sock.destroy();
  });

  it("session.reconnect returns scrollback over data socket", async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    server = new SidecarServer({
      controlSocketPath: CONTROL_SOCK,
      sessionSocketDir: SESSION_DIR,
      pidFilePath: PID_PATH,
      token: TOKEN,
      });
    await server.start();

    const ctrl = await connectControl();

    // Create session and write some output
    const createResp = await rpcCall(ctrl, 1, "session.create", {
      command: TEST_SHELL.command,
      args: TEST_SHELL.args,
      displayName: TEST_SHELL.displayName,
      target: TEST_SHELL.target,
      cwdHostPath: TEST_CWD,
      cwd: TEST_CWD,
      cols: 80,
      rows: 24,
    });
    const { sessionId, socketPath } =
      createResp.result as SessionCreateResult;

    // Connect, send command, wait for output, then disconnect
    const data1 = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection(socketPath, () => resolve(s));
      s.on("error", reject);
    });
    data1.write(TEST_SHELL.echo("reconnect-marker"));
    await new Promise<void>((resolve) => {
      const onData = (chunk: Buffer) => {
        if (chunk.toString().includes("reconnect-marker")) {
          data1.off("data", onData);
          resolve();
        }
      };
      data1.on("data", onData);
    });
    data1.destroy();
    await sleep(100);

    // Reconnect
    const reconResp = await rpcCall(ctrl, 2, "session.reconnect", {
      sessionId,
      cols: 80,
      rows: 24,
    });
    assert.equal(
      (reconResp.result as SessionReconnectResult).sessionId,
      sessionId,
    );

    // Connect new data socket — should receive scrollback
    const data2 = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection(socketPath, () => resolve(s));
      s.on("error", reject);
    });

    const scrollback = await new Promise<string>((resolve) => {
      let buf = "";
      const onData = (chunk: Buffer) => {
        buf += chunk.toString();
        if (buf.includes("reconnect-marker")) {
          data2.off("data", onData);
          resolve(buf);
        }
      };
      data2.on("data", onData);
      // Timeout fallback
      setTimeout(() => {
        data2.off("data", onData);
        resolve(buf);
      }, 2000);
    });

    assert.ok(scrollback.includes("reconnect-marker"));

    data2.destroy();
    ctrl.destroy();
  });
});

describe("Shell exit sends session.exited notification", () => {
  it("emits session.exited with sessionId and exitCode", async (t) => {
    if (process.platform === "win32") {
      t.skip(
        "Windows native PTY exit is covered by the client notification test",
      );
      return;
    }

    server = createServer();
    await server.start();

    const ctrl = await connectControl();
    const messages: Array<JsonRpcNotification | JsonRpcResponse> = [];
    collectMessages(ctrl, messages);

    const shell = exitSoonShell();
    const createResp = await rpcCall(ctrl, 1, "session.create", {
      command: shell.command,
      args: shell.args,
      displayName: shell.displayName,
      target: shell.target,
      cwdHostPath: TEST_CWD,
      cwd: TEST_CWD,
      cols: 80,
      rows: 24,
    });
    const { sessionId } = createResp.result as SessionCreateResult;

    const notification = await waitForNotification(messages, "session.exited");

    assert.equal(notification.method, "session.exited");
    assert.equal(notification.params?.sessionId, sessionId);
    assert.equal(typeof notification.params?.exitCode, "number");

    ctrl.destroy();
  });
});

describe("Last-attach-wins eviction", () => {
  it("closes socket A when socket B connects", async () => {
    server = createServer();
    await server.start();

    const ctrl = await connectControl();
    const { socketPath } = await createSession(ctrl, 1);

    // Connect data socket A and verify it works
    const dataA = await connectDataSocket(socketPath);
    dataA.write(TEST_SHELL.echo("socket-a-marker"));
    await waitForOutput(dataA, "socket-a-marker");

    // Connect data socket B (should evict A)
    const dataB = await connectDataSocket(socketPath);
    await sleep(200);

    // Verify A no longer receives new output.
    // After eviction, A should not get any data from a new command.
    let aGotNewData = false;
    dataA.on("data", () => { aGotNewData = true; });

    // Verify B receives output
    dataB.write(TEST_SHELL.echo("socket-b-marker"));
    const output = await waitForOutput(dataB, "socket-b-marker");
    assert.ok(output.includes("socket-b-marker"));

    // Give a moment for any stray data to arrive on A
    await sleep(100);
    assert.ok(
      !aGotNewData,
      "Socket A should not receive output after eviction",
    );

    dataA.destroy();
    dataB.destroy();
    ctrl.destroy();
  });
});

describe("session.resize works", () => {
  it("returns { ok: true } when resizing", async () => {
    server = createServer();
    await server.start();

    const ctrl = await connectControl();
    const { sessionId } = await createSession(ctrl, 1);

    const resp = await rpcCall(ctrl, 2, "session.resize", {
      sessionId,
      cols: 120,
      rows: 40,
    });

    assert.deepEqual(resp.result, { ok: true });
    assert.equal(resp.error, undefined);

    ctrl.destroy();
  });
});

describe("session.foreground returns a command name", () => {
  it("returns a non-empty command string", async () => {
    server = createServer();
    await server.start();

    const ctrl = await connectControl();
    const { sessionId, socketPath } = await createSession(ctrl, 1);

    // Connect data socket so the shell is active and wait for prompt
    const data = await connectDataSocket(socketPath);
    await sleep(500);

    const resp = await rpcCall(ctrl, 2, "session.foreground", {
      sessionId,
    });

    const result = resp.result as { command: string };
    assert.equal(typeof result.command, "string");
    assert.ok(
      result.command.length > 0,
      "Foreground command should be non-empty",
    );

    data.destroy();
    ctrl.destroy();
  });
});

describe("Reconnect queues output produced during gap", () => {
  it("scrollback includes output from both commands", async () => {
    server = createServer();
    await server.start();

    const ctrl = await connectControl();
    const { sessionId, socketPath } = await createSession(ctrl, 1);

    // Connect first data socket, send command, wait for output
    const data1 = await connectDataSocket(socketPath);
    data1.write(TEST_SHELL.echo("first-cmd-aaa"));
    await waitForOutput(data1, "first-cmd-aaa");

    // Disconnect first data socket
    data1.destroy();
    await sleep(200);

    // Connect a second data socket directly (no reconnect)
    // to send another command while the session is alive
    const data2 = await connectDataSocket(socketPath);
    data2.write(TEST_SHELL.echo("second-cmd-bbb"));
    await waitForOutput(data2, "second-cmd-bbb");

    // Disconnect second data socket
    data2.destroy();
    await sleep(200);

    // Now do a formal reconnect
    const reconResp = await rpcCall(ctrl, 2, "session.reconnect", {
      sessionId,
      cols: 80,
      rows: 24,
    });
    assert.equal(
      (reconResp.result as SessionReconnectResult).sessionId,
      sessionId,
    );

    // Connect new data socket to receive scrollback
    const data3 = await connectDataSocket(socketPath);
    const scrollback = await new Promise<string>((resolve) => {
      let buf = "";
      const onData = (chunk: Buffer) => {
        buf += chunk.toString();
        // Wait until we see both markers or timeout
        if (
          buf.includes("first-cmd-aaa")
          && buf.includes("second-cmd-bbb")
        ) {
          data3.off("data", onData);
          resolve(buf);
        }
      };
      data3.on("data", onData);
      setTimeout(() => {
        data3.off("data", onData);
        resolve(buf);
      }, 3000);
    });

    assert.ok(
      scrollback.includes("first-cmd-aaa"),
      "Scrollback should contain output from the first command",
    );
    assert.ok(
      scrollback.includes("second-cmd-bbb"),
      "Scrollback should contain output from the second command",
    );

    data3.destroy();
    ctrl.destroy();
  });
});

describe("Unknown RPC method returns error", () => {
  it("returns error code -32601 for unknown method", async () => {
    server = createServer();
    await server.start();

    const ctrl = await connectControl();
    const resp = await rpcCall(ctrl, 1, "nonexistent.method");

    assert.ok(resp.error, "Response should have an error");
    assert.equal(resp.error!.code, -32601);
    assert.ok(resp.error!.message.includes("nonexistent.method"));

    ctrl.destroy();
  });
});

describe("Windows WSL smoke", () => {
  const isWindows = process.platform === "win32";
  const runWslSmoke = process.env.RUN_WSL_SMOKE === "1";
  const defaultDistro = isWindows
    ? (() => {
      try {
        const out = execFileSync("wsl.exe", ["-l", "-q"], {
          encoding: "utf8",
          timeout: 5000,
          windowsHide: true,
        });
        return out.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
      } catch {
        return null;
      }
    })()
    : null;

  it("can spawn a WSL session when a distro is installed", async (t) => {
    if (!runWslSmoke) {
      t.skip("Set RUN_WSL_SMOKE=1 to run the WSL integration smoke test");
      return;
    }

    if (!isWindows || !defaultDistro) {
      t.skip("WSL not available");
      return;
    }

    server = createServer();
    await server.start();

    const ctrl = await connectControl();
    const createResp = await rpcCall(ctrl, 1, "session.create", {
      command: "wsl.exe",
      args: ["-d", defaultDistro],
      displayName: defaultDistro,
      target: `wsl:${defaultDistro}`,
      cwdHostPath: TEST_CWD,
      cwd: TEST_CWD,
      cols: 80,
      rows: 24,
    });
    const { sessionId, socketPath } = createResp.result as SessionCreateResult;

    const data = await connectDataSocket(socketPath);
    data.write("echo WSL_SMOKE_OK\n");
    const output = await waitForOutput(data, "WSL_SMOKE_OK", 10000);
    assert.ok(output.includes("WSL_SMOKE_OK"));

    await rpcCall(ctrl, 2, "session.kill", { sessionId });
    data.destroy();
    ctrl.destroy();
  });
});

describe("Stale sidecar shutdown does not clobber successor", () => {
  it("leaves the successor's endpoint and pid file intact", async (t) => {
    if (process.platform === "win32") {
      t.skip("Takeover semantics are unix-socket specific");
      return;
    }

    fs.mkdirSync(TEST_DIR, { recursive: true });
    const staleServer = new SidecarServer({
      controlSocketPath: CONTROL_SOCK,
      sessionSocketDir: SESSION_DIR,
      pidFilePath: PID_PATH,
      token: "stale-token",
    });
    await staleServer.start();

    // Successor takes over the same endpoint and pid file.
    server = createServer();
    await server.start();

    await staleServer.shutdown();

    assert.ok(
      fs.existsSync(PID_PATH),
      "stale shutdown must not delete the successor's pid file",
    );
    const pidData = JSON.parse(fs.readFileSync(PID_PATH, "utf8"));
    assert.equal(pidData.token, TOKEN);

    // The successor's control socket must still be reachable.
    const ctrl = await connectControl();
    const resp = await rpcCall(ctrl, 1, "sidecar.ping");
    assert.equal((resp.result as PingResult).token, TOKEN);
    ctrl.destroy();
  });
});
