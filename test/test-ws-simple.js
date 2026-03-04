#!/usr/bin/env node
/**
 * OpenClaw WebSocket 简单连续对话示例
 * 
 * 展示如何使用 WebSocket 进行多轮对话
 */

import WebSocket from 'ws';
import { randomUUID } from 'crypto';

const GATEWAY_URL = 'ws://127.0.0.1:18789';
const GATEWAY_TOKEN = 'f3a1ed4004b4d584b7577ac4c5744e912fbca7e30c36c82f';

console.log('=== OpenClaw WebSocket 连续对话 ===\n');

const ws = new WebSocket(GATEWAY_URL, {
  headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` }
});

let isAuthenticated = false;
let pendingRequests = new Map();
let currentRunId = null;
let currentResponse = '';
let responseResolve = null;

// 要发送的多轮对话
const messages = [
  '你好',
  '介绍一下你自己',
  '今天天气怎么样？'
];

function sendRequest(method, params) {
  const id = randomUUID();
  ws.send(JSON.stringify({ type: 'req', id, method, params }));
  return id;
}

// 发送消息并等待回复
async function sendMessage(text) {
  currentResponse = '';
  
  // 发送 agent 请求
  const agentId = sendRequest('agent', {
    message: text,
    sessionKey: 'agent:main:main',
    idempotencyKey: `voice-${Date.now()}`
  });

  // 等待 agent 被接受
  const agentResult = await new Promise((resolve, reject) => {
    pendingRequests.set(agentId, { resolve, reject });
  });

  if (!agentResult.ok) {
    throw new Error(`Agent failed: ${JSON.stringify(agentResult.error)}`);
  }

  currentRunId = agentResult.payload.runId;
  console.log(`\n[RUN] ${currentRunId}`);

  // 等待完整回复（通过 agent.wait）
  return new Promise((resolve) => {
    responseResolve = resolve;
    sendRequest('agent.wait', {
      runId: currentRunId,
      timeoutMs: 60000
    });
  });
}

ws.on('open', () => {
  console.log('[1] 已连接，等待 challenge...');
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());

  if (msg.type === 'event' && msg.event === 'connect.challenge') {
    console.log('[2] 收到 challenge，发送 connect 请求...');
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
        console.log('[3] 认证成功！开始对话...\n');
        isAuthenticated = true;
        startConversation();
      } else if (msg.payload?.status === 'accepted') {
        // agent 请求被接受，继续等
        pending.resolve(msg);
      } else if (responseResolve && msg.payload?.status === 'ok') {
        // agent.wait 完成，用 agent 事件里累积的回复
        responseResolve(currentResponse || '(没有回复)');
        responseResolve = null;
      } else {
        pending.resolve(msg);
      }
    }
  }

  // 监听 agent 流式事件来获取回复
  if (msg.type === 'event' && msg.event === 'agent' && msg.payload?.runId === currentRunId) {
    if (msg.payload.data?.text) {
      currentResponse = msg.payload.data.text;
    }
  }
});

ws.on('close', () => {
  console.log('\n[CLOSE] 连接关闭');
});

ws.on('error', (err) => {
  console.log('[ERR]', err.message);
});

async function startConversation() {
  try {
    for (let i = 0; i < messages.length; i++) {
      console.log(`\n─── 第 ${i + 1} 轮 ───`);
      console.log('你:', messages[i]);
      
      const reply = await sendMessage(messages[i]);
      console.log('助手:', reply);
      
      if (i < messages.length - 1) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
    console.log('\n✅ 对话完成！');
  } catch (e) {
    console.log('\n[ERR]', e.message);
  } finally {
    ws.close();
  }
}

setTimeout(() => {
  if (!isAuthenticated) {
    console.log('[TIMEOUT] 认证超时');
    ws.close();
  }
}, 10000);
