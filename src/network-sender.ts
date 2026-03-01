/**
 * Network Sender - Consumer
 *
 * Responsible for:
 * 1. Sending audio/text to OpenClaw API via CLI
 * 2. Receiving AI responses
 * 3. Playing TTS responses
 * Supports interruption when user speaks
 */

import { EventEmitter } from "node:events";
import { spawn, ChildProcess, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface NetworkSenderOptions {
  agentId?: string;
  ttsVoice?: string;
}

export class NetworkSender extends EventEmitter {
  private agentId: string;
  private ttsVoice: string;
  private isProcessing: boolean = false;
  private queue: any[] = [];
  private currentTTSProcess: ChildProcess | null = null;
  private isPlaying: boolean = false;
  private isHandlingRequest: boolean = false;

  constructor(options: NetworkSenderOptions = {}) {
    super();
    this.agentId = options.agentId || "main";
    this.ttsVoice = options.ttsVoice || "zh-CN-XiaoxiaoNeural";
  }

  /**
   * Send text to OpenClaw via CLI
   */
  async sendToOpenClaw(text: string): Promise<string> {
    try {
      this.log(`[OpenClaw] Calling with: "${text.substring(0, 50)}..."`);
      
      // Use openclaw CLI instead of WebSocket
      const { stdout } = await execFileAsync("openclaw", ["ask", text], {
        timeout: 60000,
        encoding: "utf-8"
      });
      
      // Parse response (CLI outputs JSON or plain text)
      let response = stdout.trim();
      
      // Try to parse as JSON if it looks like JSON
      if (response.startsWith("{") && response.endsWith("}")) {
        try {
          const json = JSON.parse(response);
          response = json.text || json.message || json.response || response;
        } catch {
          // Not valid JSON, use as-is
        }
      }
      
      this.log(`[OpenClaw] Response: "${response.substring(0, 100)}..."`);
      return response || "抱歉，我没有听明白";
      
    } catch (error: any) {
      this.log("[OpenClaw] Error:", error.message);
      this.emit("error", error);
      return "抱歉，我暂时无法连接到大脑，请稍后再试";
    }
  }

  /**
   * Interrupt current TTS playback
   */
  interrupt(): void {
    if (this.currentTTSProcess) {
      this.log("[TTS] Interrupting current playback...");
      this.currentTTSProcess.kill();
      this.currentTTSProcess = null;
      this.isPlaying = false;
      this.emit("interrupted");
      
      // 打断后立即检查队列，处理积压消息
      if (this.queue.length > 0 && !this.isHandlingRequest) {
        this.processQueue();
      }
    }
  }

  /**
   * Log message
   */
  private log(...args: any[]): void {
    console.log(`[${new Date().toISOString()}]`, ...args);
  }

  /**
   * Play TTS using Edge TTS (流式输出给播放器)
   */
  async playTTS(text: string): Promise<void> {
    try {
      this.isPlaying = true;
      this.emit("ttsStart");
      this.log(`[TTS] Playing: "${text.substring(0, 100)}..."`);

      // 流式：edge-tts stdout -> mpv stdin
      const ttsProcess = spawn("edge-tts", [
        "--voice", this.ttsVoice,
        "--text", text,
        "--write-media", "-"  // 输出到 stdout
      ]);

      // 优化参数，减少延迟
      const playerProcess = spawn("mpv", [
        "-",                     // 从 stdin 读取
        "--no-video",            // 不显示视频
        "--cache=no",            // 禁用缓存，减少延迟
        "--audio-buffer=0.2",    // 音频缓冲区缩小到 0.2 秒
        "--really-quiet",        // 减少不必要的输出
        "--loop=no",             // 不循环
        "--ao=pulse"             // 强制使用 PulseAudio (WSLg)
      ], {
        stdio: ["pipe", "ignore", "ignore"],
        env: { ...process.env, PULSE_SERVER: "/mnt/wslg/PulseServer" }
      });

      this.currentTTSProcess = playerProcess;

      // pipe TTS 输出给播放器
      ttsProcess.stdout.pipe(playerProcess.stdin);

      // 处理错误
      ttsProcess.on("error", (err) => {
        this.log("[TTS] edge-tts error:", err.message);
        playerProcess.kill();
      });

      playerProcess.on("error", (err) => {
        this.log("[TTS] mpv error:", err.message);
      });

      // 等待播放完成
      await new Promise<void>((resolve) => {
        playerProcess.on("close", (code) => {
          ttsProcess.kill();
          this.currentTTSProcess = null;
          this.isPlaying = false;
          this.log(`[TTS] Finished (exit code: ${code})`);
          resolve();
        });
      });

      this.emit("ttsEnd");

    } catch (error: any) {
      this.isPlaying = false;
      this.log("[TTS] Error:", error.message);
      this.emit("error", error);
      throw error;
    }
  }

  /**
   * Queue a request for processing (event-driven, triggers immediately if not busy)
   */
  enqueue(text: string): void {
    this.queue.push({ text, timestamp: Date.now() });
    this.emit("queued", { queueLength: this.queue.length });
    
    // Trigger processing immediately (event-driven, no polling)
    this.processQueue();
  }

  /**
   * Start processing (event-driven, no interval needed)
   */
  start(): void {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;
    this.emit("started");
    // No interval needed - event-driven processing
  }

  /**
   * Stop processing
   */
  stop(): void {
    this.isProcessing = false;
    this.interrupt();
    this.emit("stopped");
  }

  /**
   * Process queued requests (event-driven)
   * Called immediately when new message arrives, and recursively when done
   */
  private async processQueue(): Promise<void> {
    // 如果正在处理上一个请求或播放TTS，跳过（会由递归调用处理）
    if (this.isHandlingRequest || this.isPlaying) {
      return;
    }

    if (this.queue.length === 0) {
      return;
    }

    this.isHandlingRequest = true;

    try {
      // 取出所有排队的消息，合并成一个
      const messages: string[] = [];
      while (this.queue.length > 0) {
        const request = this.queue.shift();
        messages.push(request.text);
      }

      // 合并消息（用换行符分隔）
      const mergedText = messages.join("\n");
      this.log(`[Queue] Merged ${messages.length} messages`);

      // Send to OpenClaw
      this.emit("apiCallStart", { text: mergedText.substring(0, 50) + "..." });
      const response = await this.sendToOpenClaw(mergedText);
      this.emit("apiCallEnd", { response });

      // Play TTS
      await this.playTTS(response);
    } catch (error: any) {
      this.emit("error", error);
    } finally {
      this.isHandlingRequest = false;
      // 递归处理队列中可能新加入的消息（event-driven continuation）
      if (this.queue.length > 0) {
        this.processQueue();
      }
    }
  }
}
