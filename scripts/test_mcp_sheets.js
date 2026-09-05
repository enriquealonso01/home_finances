import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const proc = spawn('node', [path.join(ROOT, 'mcps/sheets/server.js')], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buf = '';
proc.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    console.log('<-', JSON.stringify(msg).slice(0, 500));
    if (msg.id === 1) {
      send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
      send({ jsonrpc: '2.0', method: 'tools/list', id: 2 });
    } else if (msg.id === 2) {
      const tools = msg.result?.tools || [];
      console.log(`\nTOOLS LISTED: ${tools.length}`);
      tools.forEach(t => console.log(`  - ${t.name}`));
      proc.kill();
      process.exit(0);
    }
  }
});

function send(msg) {
  const str = JSON.stringify(msg);
  console.log('->', str.slice(0, 200));
  proc.stdin.write(str + '\n');
}

send({
  jsonrpc: '2.0',
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  },
  id: 1,
});

setTimeout(() => {
  console.error('TIMEOUT — server did not respond in 8s');
  proc.kill();
  process.exit(1);
}, 8000);
