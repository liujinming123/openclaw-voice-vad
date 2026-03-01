#!/usr/bin/env node
/**
 * OpenClaw WebSocket Challenge 测试
 */

import WebSocket from 'ws';

const TOKEN = 'f3a1ed4004b4d584b7577ac4c5744e912fbca7e30c36c82f';

function testChallengeResponse(format) {
  return new Promise((resolve, reject) => {
    console.log(`\n=== 测试格式 ${format.name} ===`);
    
    const ws = new WebSocket('ws://127.0.0.1:18789', {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    
    let timer = setTimeout(() => {
      console.log('  ⏱️ 超时');
      ws.close();
      reject('timeout');
    }, 5000);
    
    ws.on('open', () => {
      console.log('  Connected');
    });
    
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      console.log('  Recv:', JSON.stringify(msg).substring(0, 100));
      
      if (msg.event === 'connect.challenge') {
        const payload = format.builder(msg.payload);
        console.log('  Send:', JSON.stringify(payload));
        ws.send(JSON.stringify(payload));
      }
      
      if (msg.event === 'connect.ready') {
        clearTimeout(timer);
        console.log('  ✅ 成功！');
        ws.close();
        resolve(format.name);
      }
      
      if (msg.event === 'connect.error') {
        clearTimeout(timer);
        console.log('  ❌ 失败:', msg.payload);
        ws.close();
        reject(msg.payload);
      }
    });
    
    ws.on('close', (code) => {
      if (code === 1008) {
        console.log('  ❌ 被拒绝 (code 1008)');
        clearTimeout(timer);
        reject('invalid frame');
      }
    });
    
    ws.on('error', (err) => {
      console.log('  Error:', err.message);
    });
  });
}

// 测试不同的格式
const formats = [
  {
    name: 'A: type/event/payload (原始)',
    builder: (p) => ({
      type: 'event',
      event: 'connect.challenge_response',
      payload: { nonce: p.nonce }
    })
  },
  {
    name: 'B: 只有 nonce 字段',
    builder: (p) => ({
      nonce: p.nonce
    })
  },
  {
    name: 'C: method 方式',
    builder: (p) => ({
      method: 'connect.challenge_response',
      params: { nonce: p.nonce }
    })
  },
  {
    name: 'D: id + method',
    builder: (p) => ({
      id: 'challenge-1',
      method: 'connect.challenge_response',
      params: { nonce: p.nonce }
    })
  },
  {
    name: 'E: 字符串方式',
    builder: (p) => `{"event":"connect.challenge_response","nonce":"${p.nonce}"}`
  },
  {
    name: 'F: type/method/params',
    builder: (p) => ({
      type: 'method',
      method: 'connect.challenge_response',
      params: { nonce: p.nonce }
    })
  }
];

async function main() {
  for (const fmt of formats) {
    try {
      await testChallengeResponse(fmt);
      console.log(`\n✅ 找到正确格式: ${fmt.name}`);
      break;
    } catch (e) {
      // 继续下一个
    }
  }
}

main();
