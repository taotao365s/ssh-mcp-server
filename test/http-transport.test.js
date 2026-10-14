import { describe, it } from 'node:test';
import assert from 'node:assert';
import { allowedHostHeaders, isLoopbackHost } from '../build/core/http-server.js';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');
const entrypoint = path.join(rootDir, 'build', 'index.js');
const endpointPattern = /MCP HTTP server listening on (http:\/\/\S+)/;

function createTempConfig() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-mcp-http-'));
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    test: {
      host: '127.0.0.1',
      port: 22,
      username: 'test',
      password: 'test',
      commandWhitelist: ['^echo'],
    },
  }));
  return { tmpDir, configPath };
}

function waitForOutput(stream, pattern, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${pattern}. Output:\n${output}`));
    }, timeoutMs);

    const onData = (chunk) => {
      output += chunk.toString();
      if (pattern.test(output)) {
        cleanup();
        resolve(output);
      }
    };

    const cleanup = () => {
      clearTimeout(timeout);
      stream.off('data', onData);
    };

    stream.on('data', onData);
  });
}

function waitForExit(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Process did not exit before timeout'));
    }, timeoutMs);

    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

function startServer(extraArgs) {
  const { tmpDir, configPath } = createTempConfig();
  const child = spawn(process.execPath, [
    entrypoint,
    '--config-file', configPath,
    '--mcp-transport', 'http',
    '--http-port', '0',
    ...extraArgs,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return { child, tmpDir };
}

async function stopServer(child, tmpDir) {
  try {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = waitForExit(child);
      child.kill('SIGKILL');
      await exited.catch(() => {});
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function postJson(url, body, token) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (token !== undefined) {
    headers.authorization = token;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, text, json };
}

function postWithHost(url, hostHeader) {
  const target = new URL(url);
  const payload = JSON.stringify(initializeBody);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: {
        host: hostHeader,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const initializeBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'http-transport-test', version: '1.0.0' },
  },
};

describe('loopback host detection', () => {
  it('accepts localhost, ::1, and dotted 127.0.0.0/8 addresses', () => {
    for (const host of ['localhost', '::1', '[::1]', '127.0.0.1', '127.0.0.2', '127.255.255.255']) {
      assert.strictEqual(isLoopbackHost(host), true, host);
    }
  });

  it('rejects names that only look like loopback and non-loopback addresses', () => {
    for (const host of ['127.evil.com', '127.', '127.1', '127.0.0', '127.0.0.256', '128.0.0.1', '0.0.0.0', 'example.com']) {
      assert.strictEqual(isLoopbackHost(host), false, host);
    }
  });

  it('allows the actual bind address together with the common loopback names', () => {
    assert.deepStrictEqual(allowedHostHeaders('127.0.0.2', 3000)?.sort(), [
      '127.0.0.1:3000',
      '127.0.0.2:3000',
      '[::1]:3000',
      'localhost:3000',
    ]);
  });

  it('does not treat a 127-prefixed hostname as loopback in the host allow-list', () => {
    assert.deepStrictEqual(allowedHostHeaders('127.evil.com', 3000), ['127.evil.com:3000']);
    assert.strictEqual(allowedHostHeaders('0.0.0.0', 3000), undefined);
  });
});

describe('MCP HTTP transport', () => {
  it('serves initialize and tools/list, and exits on SIGTERM', async () => {
    const { child, tmpDir } = startServer(['--http-host', '127.0.0.1']);

    try {
      const output = await waitForOutput(child.stderr, endpointPattern);
      const endpoint = output.match(endpointPattern)[1];

      const missing = await fetch(`${endpoint}/missing`, { method: 'POST' });
      assert.strictEqual(missing.status, 404);

      const initialized = await postJson(endpoint, initializeBody);
      assert.strictEqual(initialized.status, 200);
      assert.strictEqual(initialized.json?.result?.serverInfo?.name, 'ssh-mcp-server');

      const tools = await postJson(`${endpoint}/`, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      });
      assert.strictEqual(tools.status, 200);
      const names = tools.json?.result?.tools?.map((tool) => tool.name);
      assert.ok(names?.includes('execute-command'), tools.text);

      const target = new URL(endpoint);
      const rejectedHost = await postWithHost(endpoint, `evil.example:${target.port}`);
      assert.strictEqual(rejectedHost, 403);

      // Windows child.kill('SIGTERM') maps to TerminateProcess and does not
      // run the signal handler. The HTTP checks above still run there.
      if (process.platform !== 'win32') {
        child.kill('SIGTERM');
        const result = await waitForExit(child);
        assert.strictEqual(result.signal, null);
        assert.strictEqual(result.code, 0);
      }
    } finally {
      await stopServer(child, tmpDir);
    }
  });

  it('requires the configured bearer token', async () => {
    const { child, tmpDir } = startServer([
      '--http-host', '127.0.0.1',
      '--http-token', 'test-token',
    ]);

    try {
      const output = await waitForOutput(child.stderr, endpointPattern);
      const endpoint = output.match(endpointPattern)[1];

      const anonymous = await postJson(endpoint, initializeBody);
      assert.strictEqual(anonymous.status, 401);

      const wrong = await postJson(endpoint, initializeBody, 'Bearer wrong-token');
      assert.strictEqual(wrong.status, 401);

      const accepted = await postJson(endpoint, initializeBody, 'Bearer test-token');
      assert.strictEqual(accepted.status, 200);
      assert.strictEqual(accepted.json?.result?.serverInfo?.name, 'ssh-mcp-server');
    } finally {
      await stopServer(child, tmpDir);
    }
  });

  it('warns when listening beyond loopback without a token', async () => {
    const { child, tmpDir } = startServer(['--http-host', '0.0.0.0']);

    try {
      const output = await waitForOutput(child.stderr, /not a loopback address/);
      assert.match(output, /no bearer token/);

      const endpoint = output.match(endpointPattern)[1].replace('0.0.0.0', '127.0.0.1');
      const initialized = await postJson(endpoint, initializeBody);
      assert.strictEqual(initialized.status, 200);
      assert.match(output, /Any client that can reach this port/);
    } finally {
      await stopServer(child, tmpDir);
    }
  });

  it('mentions the bearer token when listening beyond loopback with one configured', async () => {
    const { child, tmpDir } = startServer([
      '--http-host', '0.0.0.0',
      '--http-token', 'test-token',
    ]);

    try {
      const output = await waitForOutput(child.stderr, /not a loopback address/);
      assert.match(output, /without the bearer token are rejected/);
      assert.doesNotMatch(output, /Any client that can reach this port/);
    } finally {
      await stopServer(child, tmpDir);
    }
  });

  it('keeps serving after a client aborts an in-flight request', async () => {
    const { child, tmpDir } = startServer(['--http-host', '127.0.0.1']);

    try {
      const output = await waitForOutput(child.stderr, endpointPattern);
      const endpoint = output.match(endpointPattern)[1];
      const target = new URL(endpoint);
      const payload = JSON.stringify(initializeBody);

      await new Promise((resolve) => {
        const req = httpRequest({
          hostname: target.hostname,
          port: target.port,
          path: target.pathname,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'content-length': Buffer.byteLength(payload),
          },
        }, () => {});
        req.on('error', () => resolve());
        req.on('close', () => resolve());
        req.end(payload);
        req.destroy();
      });

      const initialized = await postJson(endpoint, initializeBody);
      assert.strictEqual(initialized.status, 200, initialized.text);
    } finally {
      await stopServer(child, tmpDir);
    }
  });
});
