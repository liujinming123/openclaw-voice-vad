#!/usr/bin/env node
/**
 * 测试 reasoning 消息
 */

import WebSocket from 'ws';
import { randomUUID } from 'crypto';

const GATEWAY_URL = 'ws://127.0.0.1:18789';
const GATEWAY_TOKEN = 'f3a1ed4004b4d584b7577ac4c5744e912fbca7e30c36c82f';

console.log('=== 测试 Reasoning 消息 ===\n');

const ws = new WebSocket(GATEWAY_URL, {
  headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` }
});

let isAuthenticated = false;
let pendingRequests = new Map();
let currentRunId = null;
let thinkingText = '';
let assistantText = '';

function sendRequest(method, params) {
  const id = randomUUID();
  ws.send(JSON.stringify({ type: 'req', id, method, params }));
  return id;
}

ws.on('open', () => {
  console.log('[1] 已连接');
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());

  if (msg.type === 'event' && msg.event === 'connect.challenge') {
    console.log('[2] 收到 challenge，发送 connect...\n');
    sendRequest('connect', {
      minProtocol: 3,
      maxProtocol: 3,
      client: { id: 'cli', displayName: 'Test', version: '1.0.0', platform: process.platform, mode: 'cli' },
      auth: { token: GATEWAY_TOKEN },
      role: 'operator'
    });
  }

  if (msg.type === 'res') {
    const pending = pendingRequests.get(msg.id);
    if (pending) {
      pendingRequests.delete(msg.id);
      
      if (msg.payload?.type === 'hello-ok') {
        console.log('[3] 认证成功！发送消息（需要推理的问题）...\n');
        isAuthenticated = true;
        
        const agentId = sendRequest('agent', {
          message: '3456 + 7890 等于多少？一步步算给我看',
          sessionKey: 'agent:main:main',
          idempotencyKey: `reasoning-${Date.now()}`
        });
        
        pendingRequests.set(agentId, { type: 'agent' });
      } else if (pending.type === 'agent' && msg.ok) {
        currentRunId = msg.payload.runId;
        console.log('[4] Agent 已接受，Run ID:', currentRunId);
        console.log('[4] 等待流式消息...\n');
        
        const waitId = sendRequest('agent.wait', {
          runId: currentRunId,
          timeoutMs: 60000
        });
        
        pendingRequests.set(waitId, { type: 'wait' });
      } else if (pending.type === 'wait' && msg.ok) {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('📝 Thinking（推理过程）:');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(thinkingText || '(没有 reasoning)');
        
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('💬 Assistant（最终回复）:');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(assistantText || '(没有回复)');
        
        setTimeout(() => ws.close(), 500);
      }
    }
  }

  // 监听 agent 流式事件
  if (msg.type === 'event' && msg.event === 'agent' && msg.payload?.runId === currentRunId) {
    const stream = msg.payload.stream;
    const text = msg.payload.data?.text || '';
    const delta = msg.payload.data?.delta || '';
    
    if (stream === 'thinking') {
      thinkingText = text;
      process.stdout.write(`[thinking] ${delta}`);
    } else if (stream === 'assistant') {
      assistantText = text;
      if (thinkingText === '') {
        process.stdout.write(`[assistant] ${delta}`);
      }
    }
  }
});

ws.on('close', () => {
  console.log('\n\n[CLOSE] 连接关闭');
});

ws.on('error', (err) => {
  console.log('[ERR]', err.message);
});

setTimeout(() => {
  if (!isAuthenticated) {
    console.log('[TIMEOUT] 超时');
    ws.close();
  }
}, 90000);
