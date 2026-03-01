#!/usr/bin/env node
/**
 * OpenClaw WebSocket 正确实现
 * 
 * 协议流程：
 * 1. 连接 WebSocket (带 Authorization header)
 * 2. 收到 connect.challenge 事件 (包含 nonce)
 * 3. 发送 connect 请求 (包含 auth token 和 nonce)
 * 4. 收到 connect 响应，连接建立成功
 */

import WebSocket from 'ws';
import { randomUUID } from 'crypto';

const GATEWAY_URL = 'ws://127.0.0.1:18789';
const GATEWAY_TOKEN = 'f3a1ed4004b4d584b7577ac4c5744e912fbca7e30c36c82f';
const DEVICE_TOKEN = 'LFL5zE6fMldPUXcxc5F2V_Foqk4T4k31_EXwDIZAlOw';

// 连接和认证都用 gateway token
const TOKEN = GATEWAY_TOKEN;

console.log('=== OpenClaw WebSocket 连接测试 ===\n');

const ws = new WebSocket(GATEWAY_URL, {
  headers: { Authorization: `Bearer ${TOKEN}` }
});

let connectNonce = null;
let messageId = 0;

function sendRequest(method, params) {
  const id = randomUUID();
  const frame = {
    type: 'req',
    id,
    method,
    params
  };
  console.log(`[SEND] ${method}:`, JSON.stringify(frame, null, 2).substring(0, 300));
  ws.send(JSON.stringify(frame));
  return id;
}

ws.on('open', () => {
  console.log('[1] ✅ WebSocket 已连接');
  console.log('[1] 等待 challenge...\n');
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log('[RECV]:', JSON.stringify(msg, null, 2).substring(0, 400));

  // 处理 challenge
  if (msg.type === 'event' && msg.event === 'connect.challenge') {
    console.log('\n[2] 📝 收到 challenge');
    connectNonce = msg.payload?.nonce;
    console.log('     nonce:', connectNonce);

    // 发送 connect 请求
    console.log('\n[3] 发送 connect 请求...');
    sendRequest('connect', {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: 'cli',
        displayName: 'Voice Assistant',
        version: '1.0.0',
        platform: process.platform,
        mode: 'cli'
      },
      caps: [],
      auth: {
        token: GATEWAY_TOKEN
      },
      role: 'operator'
    });
  }

  // 处理 connect 响应
  if (msg.type === 'res' && msg.id && msg.ok !== undefined) {
    // 检查是不是 connect 请求的响应 (通过检查 payload.type)
    if (msg.payload?.type === 'hello-ok') {
      console.log('\n[4] ✅ 认证成功！');
      console.log('     服务器版本:', msg.payload?.server?.version);
      console.log('     可以开始发送 agent 请求了\n');
      
      // 发送 agent 请求
      console.log('[5] 发送 agent 请求...');
      sendRequest('agent', {
        message: '你好',
        sessionKey: 'agent:main:main',
        idempotencyKey: `voice-${Date.now()}`
      });
    }
    // 处理其他请求的响应 (通过匹配请求ID)
    else if (msg.ok) {
      console.log('\n[6] ✅ 收到响应!');
      const text = msg.payload?.payloads?.[0]?.text || JSON.stringify(msg.payload).substring(0, 200);
      console.log('     回复:', text);
      ws.close();
    } else {
      console.log('\n[ERR] ❌ 请求失败:', msg.error);
      ws.close();
    }
  }
});

ws.on('error', (err) => {
  console.log('[ERR] WebSocket 错误:', err.message);
});

ws.on('close', (code, reason) => {
  console.log(`\n[CLOSE] 连接关闭 (code: ${code}, reason: ${reason})`);
});

// 超时处理
setTimeout(() => {
  console.log('\n[TIMEOUT] 超时');
  ws.close();
}, 20000);
