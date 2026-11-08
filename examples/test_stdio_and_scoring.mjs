import { spawn, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

// 1. Test stdio MCP server handshake and tools/list introspection
const child = spawn(process.execPath, ['src/index.mjs'], { stdio: ['pipe', 'pipe', 'inherit'] });
const responses = [];

child.stdout.on('data', (chunk) => {
  for (const line of chunk.toString().split('\n').filter(Boolean)) {
    responses.push(JSON.parse(line));
  }
});

child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } }) + '\n');
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
child.stdin.end();

await new Promise((resolve) => child.on('close', resolve));

assert.equal(responses.length, 2, 'Expected 2 JSON-RPC responses (initialize + tools/list)');
assert.equal(responses[0].result.serverInfo.name, 'weatherxm-fact-mcp');
assert.equal(responses[1].result.tools.length, 4);
console.log('✅ stdio MCP server initialize + tools/list passed (4 tools verified)');

// 2. Run reference Python verification formulas
execFileSync('python3', ['examples/verification_formulas.py'], { stdio: 'inherit' });
