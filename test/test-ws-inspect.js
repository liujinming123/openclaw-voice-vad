#!/usr/bin/env node
/**
 * 查看 WebSocket 消息格式
 */

import WebSocket from 'ws';
import { randomUUID } from 'crypto';

const GATEWAY_URL = 'ws://127.0.0.1:18789';
const GATEWAY_TOKEN = 'f3a1ed4004b4d584b7577ac4c5744e912fbca7e30c36c82f';

console.log('=== 查看 WebSocket 消息格式 ===\n');

const ws = new WebSocket(GATEWAY_URL, {
  headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` }
});

let isAuthenticated = false;
let pendingRequests = new Map();
let currentRunId = null;
let allEvents = [];

function sendRequest(method, params) {
  const id = randomUUID();
  console.log(`[SEND] ${method} #${id.substring(0, 8)}...`);
  ws.send(JSON.stringify({ type: 'req', id, method, params }));
  return id;
}

ws.on('open', () => {
  console.log('[1] 已连接');
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  
  // 记录所有事件
  if (msg.type === 'event') {
    allEvents.push({
      event: msg.event,
      payload: msg.payload
    });
  }
  
  // 打印完整消息（截断太长的）
  const msgStr = JSON.stringify(msg, null, 2);
  if (msgStr.length > 2000) {
    console.log(`[RECV] ${msg.type} (truncated):`, msgStr.substring(0, 2000), '...');
  } else {
    console.log(`[RECV] ${msg.type}:`, msgStr);
  }

  if (msg.type === 'event' && msg.event === 'connect.challenge') {
    console.log('\n[2] 收到 challenge，发送 connect...');
    sendRequest('connect', {
      minProtocol: 3,
      maxProtocol: 3,
      client: { id: 'cli', displayName: 'Inspect', version: '1.0.0', platform: process.platform, mode: 'cli' },
      auth: { token: GATEWAY_TOKEN },
      role: 'operator'
    });
  }

  if (msg.type === 'res') {
    const pending = pendingRequests.get(msg.id);
    if (pending) {
      pendingRequests.delete(msg.id);
      
      if (msg.payload?.type === 'hello-ok') {
        console.log('\n[3] 认证成功！发送测试消息...\n');
        isAuthenticated = true;
        
        // 发送一条测试消息
        const agentId = sendRequest('agent', {
          message: '你好，用一句话介绍你自己',
          sessionKey: 'agent:main:main',
          idempotencyKey: `inspect-${Date.now()}`
        });
        
        pendingRequests.set(agentId, { type: 'agent' });
      } else if (pending.type === 'agent' && msg.ok) {
        currentRunId = msg.payload.runId;
        console.log('\n[4] Agent 已接受，Run ID:', currentRunId);
        console.log('[4] 等待 agent 完成...\n');
        
        // 发送 agent.wait
        const waitId = sendRequest('agent.wait', {
          runId: currentRunId,
          timeoutMs: 60000
        });
        
        pendingRequests.set(waitId, { type: 'wait' });
      } else if (pending.type === 'wait' && msg.ok) {
        console.log('\n[5] Agent.wait 返回！');
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('所有收到的事件:');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        allEvents.forEach((evt, i) => {
          console.log(`\n[事件 ${i + 1}] ${evt.event}`);
          console.log(JSON.stringify(evt.payload, null, 2));
        });
        
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('Agent.wait 最终响应:');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(JSON.stringify(msg.payload, null, 2));
        
        setTimeout(() => {
          console.log('\n[6] 完成！关闭连接...');
          ws.close();
        }, 1000);
      }
    }
  }
});

ws.on('close', () => {
  console.log('\n[CLOSE] 连接关闭');
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
