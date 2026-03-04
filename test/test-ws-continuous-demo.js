#!/usr/bin/env node
/**
 * OpenClaw WebSocket 连续对话演示（非交互式）
 * 
 * 协议流程：
 * 1. 连接 WebSocket (带 Authorization header)
 * 2. 收到 connect.challenge 事件 (包含 nonce)
 * 3. 发送 connect 请求 (包含 auth token 和 nonce)
 * 4. 收到 connect 响应，连接建立成功
 * 5. 发送多轮 agent 请求，使用 agent.wait 接收完整回复
 */

import WebSocket from 'ws';
import { randomUUID } from 'crypto';

const GATEWAY_URL = 'ws://127.0.0.1:18789';
const GATEWAY_TOKEN = 'f3a1ed4004b4d584b7577ac4c5744e912fbca7e30c36c82f';

// 连接和认证都用 gateway token
const TOKEN = GATEWAY_TOKEN;

console.log('=== OpenClaw WebSocket 连续对话演示 ===\n');

const ws = new WebSocket(GATEWAY_URL, {
  headers: { Authorization: `Bearer ${TOKEN}` }
});

// 状态管理
let connectNonce = null;
let isConnected = false;
let pendingRequests = new Map(); // id -> { resolve, reject }
let conversationStep = 0;

// 要发送的多轮对话
const conversation = [
  '你好，我叫柳如烟',
  '我是谁？',
  '记住，我是傲娇白富美，身价过亿的豪门千金',
  '现在告诉我，我是谁？'
];

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

// 发送 agent 消息并等待回复
async function sendAgentMessage(message) {
  const idempotencyKey = `voice-${Date.now()}`;
  
  // 发送 agent 请求
  const agentId = sendRequest('agent', {
    message,
    sessionKey: 'agent:main:main',
    idempotencyKey
  });

  // 等待 agent 响应
  const agentResult = await new Promise((resolve, reject) => {
    pendingRequests.set(agentId, { resolve, reject });
  });

  if (!agentResult.ok) {
    throw new Error(`Agent request failed: ${JSON.stringify(agentResult.error)}`);
  }

  const runId = agentResult.payload.runId;
  console.log(`\n[INFO] Run ID: ${runId}`);

  // 使用 agent.wait 等待完整回复
  console.log('[INFO] 等待回复...');
  const waitId = sendRequest('agent.wait', {
    runId,
    timeoutMs: 60000
  });

  const waitResult = await new Promise((resolve, reject) => {
    pendingRequests.set(waitId, { resolve, reject });
  });

  if (!waitResult.ok) {
    throw new Error(`Agent wait failed: ${JSON.stringify(waitResult.error)}`);
  }

  // agent.wait 返回后，我们需要再次检查 agent 状态来获取完整结果
  // 或者等一下让事件推送完成，然后直接用 agent 请求的响应
  await new Promise(r => setTimeout(r, 500));
  
  // 直接从 agent 请求的最终响应中获取（通过再次发送 agent 或者等事件）
  // 简单起见，我们轮询 agent 状态
  const checkId = sendRequest('agent', {
    message: '',
    sessionKey: 'agent:main:main',
    idempotencyKey: `check-${Date.now()}`,
    resumeRunId: runId
  });

  const checkResult = await new Promise((resolve, reject) => {
    pendingRequests.set(checkId, { resolve, reject });
  });

  if (!checkResult.ok) {
    throw new Error(`Agent check failed: ${JSON.stringify(checkResult.error)}`);
  }

  const text = checkResult.payload?.payloads?.[0]?.text || waitResult.payload?.payloads?.[0]?.text || '（没有收到回复）';
  return text;
}

// 开始多轮对话
async function startConversation() {
  console.log('\n=== 开始多轮对话 ===\n');

  try {
    for (let i = 0; i < conversation.length; i++) {
      const userMessage = conversation[i];
      console.log(`\n─── 第 ${i + 1} 轮对话 ───`);
      console.log('你:', userMessage);
      
      process.stdout.write('助手: ');
      const response = await sendAgentMessage(userMessage);
      console.log(response);
      
      // 每轮之间稍微停顿一下
      if (i < conversation.length - 1) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
    
    console.log('\n=== 对话完成 ===');
  } catch (error) {
    console.log('\n[ERR]', error.message);
  } finally {
    ws.close();
  }
}

ws.on('open', () => {
  console.log('[1] ✅ WebSocket 已连接');
  console.log('[1] 等待 challenge...\n');
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  
  // 只在非 event 消息时打印完整内容（避免刷屏）
  if (msg.type !== 'event') {
    console.log('[RECV]:', JSON.stringify(msg, null, 2).substring(0, 500));
  }

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
      isConnected = true;
      
      // 开始对话
      startConversation().catch(console.error);
    }
    // 处理其他请求的响应
    else {
      const pending = pendingRequests.get(msg.id);
      if (pending) {
        pendingRequests.delete(msg.id);
        if (msg.ok) {
          pending.resolve(msg);
        } else {
          pending.reject(new Error(msg.error?.message || 'Request failed'));
        }
      }
    }
  }
});

ws.on('error', (err) => {
  console.log('[ERR] WebSocket 错误:', err.message);
});

ws.on('close', (code, reason) => {
  console.log(`\n[CLOSE] 连接关闭 (code: ${code}, reason: ${reason})`);
  isConnected = false;
  
  // 拒绝所有 pending 请求
  for (const [id, pending] of pendingRequests) {
    pending.reject(new Error('Connection closed'));
  }
  pendingRequests.clear();
});

// 超时处理
setTimeout(() => {
  if (!isConnected) {
    console.log('\n[TIMEOUT] 连接超时');
    ws.close();
  }
}, 20000);

// 整体超时（防止对话卡住）
setTimeout(() => {
  console.log('\n[TIMEOUT] 整体超时');
  ws.close();
}, 120000);
