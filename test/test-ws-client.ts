#!/usr/bin/env tsx
/**
 * 测试 OpenClaw WebSocket 客户端
 */

import { OpenClawWsClient } from './src/openclaw-ws-client.js';

async function main() {
  console.log('=== 测试 OpenClaw WebSocket 客户端 ===\n');
  
  const client = new OpenClawWsClient({
    url: 'ws://127.0.0.1:18789',
    token: 'f3a1ed4004b4d584b7577ac4c5744e912fbca7e30c36c82f',
    clientId: 'test-client',
    clientDisplayName: 'Test Client',
    sessionKey: 'agent:main:main'
  });

  try {
    // 连接
    console.log('[1] 正在连接...');
    await client.connect();
    console.log('[1] ✅ 连接成功！\n');

    // 发送测试消息
    console.log('[2] 发送测试消息...');
    const response = await client.sendAgentMessage('你好，用一句话介绍你自己');
    console.log('[2] ✅ 收到回复：');
    console.log('   ', response);
    
    console.log('\n=== 测试完成！===');
  } catch (error: any) {
    console.error('\n❌ 测试失败：', error.message);
  } finally {
    client.disconnect();
  }
}

main().catch(console.error);
