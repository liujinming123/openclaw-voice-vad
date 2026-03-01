#!/usr/bin/env node
/**
 * OpenClaw WebSocket 协议研究脚本
 * 
 * 研究 Gateway WebSocket 的认证流程：
 * 1. 连接 WebSocket
 * 2. 收到 challenge 事件
 * 3. 响应 challenge_response
 * 4. 收到 ready 事件，开始通信
 */

import WebSocket from 'ws';
import crypto from 'crypto';

const GATEWAY_URL = 'ws://127.0.0.1:18789';
const TOKEN = 'f3a1ed4004b4d584b7577ac4c5744e912fbca7e30c36c82f';

console.log('=== OpenClaw WebSocket 协议研究 ===\n');

const ws = new WebSocket(GATEWAY_URL, {
  headers: { Authorization: `Bearer ${TOKEN}` }
});

ws.on('open', () => {
  console.log('[1] ✅ WebSocket 已连接');
  console.log('[1] 等待服务器发送 challenge...\n');
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log('[RECV] 收到消息:', JSON.stringify(msg, null, 2));

  // 处理 challenge 事件
  if (msg.type === 'event' && msg.event === 'connect.challenge') {
    console.log('\n[2] 📝 收到 challenge 事件');
    console.log('     nonce:', msg.payload?.nonce);
    console.log('     ts:', msg.payload?.ts);
    
    // 尝试不同的签名方式
    const nonce = msg.payload?.nonce;
    const ts = msg.payload?.ts;
    
    // 方式1: 直接发送 nonce（明文）
    console.log('\n[3] 尝试响应方式1: 直接发送 nonce');
    ws.send(JSON.stringify({
      type: 'event',
      event: 'connect.challenge_response',
      payload: { nonce: nonce }
    }));
    
    // 方式2: 使用 HMAC-SHA256 签名（如果方式1失败）
    // const signature = crypto.createHmac('sha256', TOKEN).update(nonce + ts).digest('hex');
    // console.log('[3] 方式2签名:', signature);
  }

  // 处理 ready 事件
  if (msg.type === 'event' && msg.event === 'connect.ready') {
    console.log('\n[4] ✅ 认证成功！收到 ready 事件');
    console.log('     现在可以发送 RPC 请求了\n');
    
    // 发送一个 agent 请求测试
    console.log('[5] 发送 agent 请求...');
    ws.send(JSON.stringify({
      id: 'test-1',
      method: 'agent',
      params: {
        message: '你好',
        sessionKey: 'agent:main:main'
      }
    }));
  }

  // 处理 RPC 响应
  if (msg.id === 'test-1') {
    console.log('\n[6] ✅ 收到 agent 响应!');
    console.log('     响应内容:', JSON.stringify(msg, null, 2));
    ws.close();
  }
  
  // 处理错误
  if (msg.type === 'event' && msg.event === 'connect.error') {
    console.log('\n[ERR] ❌ 认证失败:', msg.payload?.message || msg.payload);
  }
});

ws.on('error', (err) => {
  console.log('[ERR] WebSocket 错误:', err.message);
});

ws.on('close', (code, reason) => {
  console.log(`\n[CLOSE] WebSocket 关闭 (code: ${code}, reason: ${reason})`);
});

// 超时处理
setTimeout(() => {
  console.log('\n[TIMEOUT] 超时，关闭连接');
  ws.close();
  process.exit(1);
}, 15000);
