/**
 * OpenClaw WebSocket Client
 * 
 * 使用 WebSocket 连接 OpenClaw Gateway，替代 CLI 方式
 */

import WebSocket from 'ws';
import { randomUUID } from 'crypto';

export interface OpenClawWsConfig {
  url: string;
  token: string;
  clientId?: "cli" | "gateway-client" | "test";
  clientDisplayName?: string;
  sessionKey?: string;
}

export class OpenClawWsClient {
  private config: OpenClawWsConfig;
  private ws: WebSocket | null = null;
  private isConnected: boolean = false;
  private isAuthenticated: boolean = false;
  private pendingRequests = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private currentRunId: string | null = null;
  private connectNonce: string | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private currentAssistantText: string = '';
  private currentThinkingText: string = '';
  private agentResponseResolve: ((text: string) => void) | null = null;
  private onTextChunk?: (text: string, isFinal: boolean) => void;
  private lastSentTextLength: number = 0;
  
  constructor(config: OpenClawWsConfig) {
    this.config = {
      clientId: 'cli',
      clientDisplayName: 'Voice Assistant',
      sessionKey: 'agent:main:main',
      ...config
    };
  }

  /**
   * 连接到 OpenClaw Gateway
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log(`[WS] 连接到 ${this.config.url}...`);
      
      this.ws = new WebSocket(this.config.url, {
        headers: { Authorization: `Bearer ${this.config.token}` }
      });

      const timeout = setTimeout(() => {
        reject(new Error('连接超时'));
      }, 10000);

      this.ws.on('open', () => {
        console.log('[WS] ✅ WebSocket 已连接');
        this.isConnected = true;
        this.reconnectAttempts = 0;
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(msg);
          
          // 如果收到 hello-ok，说明认证成功
          if (msg.type === 'res' && msg.payload?.type === 'hello-ok') {
            clearTimeout(timeout);
            this.isAuthenticated = true;
            console.log('[WS] ✅ 认证成功');
            resolve();
          }
        } catch (e) {
          console.error('[WS] 消息解析错误:', e);
        }
      });

      this.ws.on('error', (err) => {
        console.error('[WS] 错误:', err.message);
        clearTimeout(timeout);
        reject(err);
      });

      this.ws.on('close', (code, reason) => {
        console.log(`[WS] 连接关闭 (code: ${code}, reason: ${reason})`);
        this.isConnected = false;
        this.isAuthenticated = false;
        this.handleReconnect();
      });
    });
  }

  /**
   * 处理收到的消息
   */
  private handleMessage(msg: any) {
    // 处理 challenge
    if (msg.type === 'event' && msg.event === 'connect.challenge') {
      this.connectNonce = msg.payload?.nonce;
      console.log('[WS] 收到 challenge');
      this.sendConnect();
    }

    // 处理 agent 流式事件
    if (msg.type === 'event' && msg.event === 'agent' && msg.payload?.runId === this.currentRunId) {
      const stream = msg.payload.stream;
      const text = msg.payload.data?.text || '';
      
      if (stream === 'thinking') {
        this.currentThinkingText = text;
      } else if (stream === 'assistant') {
        this.currentAssistantText = text;
        
        // 检查是否有新的文本片段可以发送
        if (this.onTextChunk && text.length > this.lastSentTextLength) {
          const newText = text.substring(this.lastSentTextLength);
          this.lastSentTextLength = text.length;
          this.onTextChunk(newText, false);
        }
      }
    }

    // 处理响应
    if (msg.type === 'res' && msg.id) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        if (msg.ok) {
          pending.resolve(msg);
        } else {
          pending.reject(new Error(msg.error?.message || '请求失败'));
        }
      }
    }
  }

  /**
   * 发送 connect 请求
   */
  private sendConnect() {
    if (!this.ws || !this.connectNonce) return;
    
    const id = randomUUID();
    const frame = {
      type: 'req',
      id,
      method: 'connect',
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: this.config.clientId,
          displayName: this.config.clientDisplayName,
          version: '1.0.0',
          platform: process.platform,
          mode: 'cli'
        },
        caps: [],
        auth: {
          token: this.config.token
        },
        role: 'operator'
      }
    };
    
    console.log('[WS] 发送 connect 请求');
    this.ws.send(JSON.stringify(frame));
  }

  /**
   * 发送请求
   */
  private async sendRequest(method: string, params: any): Promise<any> {
    if (!this.ws || !this.isConnected) {
      throw new Error('WebSocket 未连接');
    }

    const id = randomUUID();
    const frame = { type: 'req', id, method, params };
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('请求超时'));
      }, 60000);

      this.pendingRequests.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });

      this.ws!.send(JSON.stringify(frame));
    });
  }

  /**
   * 发送 agent 消息并等待回复（支持流式回调）
   */
  async sendAgentMessage(message: string, onTextChunk?: (text: string, isFinal: boolean) => void): Promise<string> {
    // 重置状态
    this.currentAssistantText = '';
    this.currentThinkingText = '';
    this.currentRunId = null;
    this.onTextChunk = onTextChunk;
    this.lastSentTextLength = 0;
    
    const idempotencyKey = `voice-${Date.now()}`;
    
    // 发送 agent 请求
    const agentResult = await this.sendRequest('agent', {
      message,
      sessionKey: this.config.sessionKey,
      idempotencyKey
    });

    this.currentRunId = agentResult.payload.runId;
    console.log(`[WS] Run ID: ${this.currentRunId}`);

    // 使用 agent.wait 等待完整回复
    await this.sendRequest('agent.wait', {
      runId: this.currentRunId,
      timeoutMs: 60000
    });

    // 等一下让事件推送完成
    await new Promise(r => setTimeout(r, 300));
    
    // 发送最终回调
    if (this.onTextChunk && this.currentAssistantText.length > this.lastSentTextLength) {
      const newText = this.currentAssistantText.substring(this.lastSentTextLength);
      this.onTextChunk(newText, true);
    }
    
    // 清理回调
    this.onTextChunk = undefined;
    
    // 返回最终的 assistant 文本
    return this.currentAssistantText || '(没有收到回复)';
  }

  /**
   * 重连逻辑
   */
  private handleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[WS] 重连次数过多，放弃');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    
    console.log(`[WS] ${delay}ms 后尝试重连 (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
    
    setTimeout(() => {
      this.connect().catch(err => {
        console.error('[WS] 重连失败:', err.message);
      });
    }, delay);
  }

  /**
   * 断开连接
   */
  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.isAuthenticated = false;
    this.pendingRequests.clear();
  }

  /**
   * 检查是否已连接
   */
  get IsConnected(): boolean {
    return this.isConnected && this.isAuthenticated;
  }
}
