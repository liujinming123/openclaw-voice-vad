/**
 * Network Sender - Consumer
 *
 * Responsible for:
 * 1. Sending audio/text to OpenClaw API via CLI
 * 2. Receiving AI responses
 * 3. Playing TTS responses
 * Uses async I/O to avoid blocking
 * Supports interruption when user speaks
 */

import { EventEmitter } from "node:events";
import { spawn, ChildProcess, exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface NetworkSenderOptions {
  agentId?: string;
  ttsVoice?: string;
}

export class NetworkSender extends EventEmitter {
  private agentId: string;
  private ttsVoice: string;
  private isProcessing: boolean = false;
  private queue: any[] = [];
  private processingInterval: NodeJS.Timeout | null = null;
  private currentTTSProcess: ChildProcess | null = null;
  private isPlaying: boolean = false;
  private isHandlingRequest: boolean = false;  // 标记是否正在处理请求

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
      // Use openclaw agent CLI command (Gateway mode, faster than --local)
      const { stdout } = await execAsync(
        `openclaw agent --agent "${this.agentId}" --message "${text.replace(/"/g, '\\"')}" --json`,
        { timeout: 60000, encoding: "utf-8" }
      );

      // Parse JSON response
      try {
        // Remove ANSI codes and extract JSON
        const cleanOutput = stdout.replace(/\x1b\[[0-9;]*m/g, "").trim();
        
        // Find JSON object in output
        const jsonMatch = cleanOutput.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const json = JSON.parse(jsonMatch[0]);
          // OpenClaw returns payloads array with text field
          if (json.payloads && json.payloads.length > 0) {
            return json.payloads[0].text || "";
          }
        }
        
        return "抱歉，我没有听明白";
      } catch (parseError) {
        return "抱歉，我没有听明白";
      }
    } catch (error: any) {
      this.emit("error", error);
      // Return a fallback response instead of throwing
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
        "--loop=no"              // 不循环
      ], {
        stdio: ["pipe", "ignore", "ignore"]
      });

      this.currentTTSProcess = playerProcess;

      // pipe TTS 输出给播放器
      ttsProcess.stdout.pipe(playerProcess.stdin);

      // 处理错误
      ttsProcess.on("error", (err) => {
        this.log("[TTS] edge-tts error:", err.message);
        playerProcess.kill();
      });

      // 等待播放完成
      await new Promise<void>((resolve) => {
        playerProcess.on("close", () => {
          ttsProcess.kill();
          this.currentTTSProcess = null;
          this.isPlaying = false;
          resolve();
        });
      });

      this.emit("ttsEnd");

    } catch (error: any) {
      this.isPlaying = false;
      this.emit("error", error);
      throw error;
    }
  }

  /**
   * Queue a request for processing
   */
  enqueue(text: string): void {
    this.queue.push({ text, timestamp: Date.now() });
    this.emit("queued", { queueLength: this.queue.length });
  }

  /**
   * Start processing queue
   */
  start(): void {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;
    this.emit("started");

    // Process queue at regular intervals
    this.processingInterval = setInterval(async () => {
      await this.processQueue();
    }, 100);
  }

  /**
   * Stop processing
   */
  stop(): void {
    this.isProcessing = false;
    this.interrupt();

    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }

    this.emit("stopped");
  }

  /**
   * Process queued requests
   * 如果有多个消息排队，合并成一个发送
   */
  private async processQueue(): Promise<void> {
    // 如果正在处理上一个请求或播放TTS，跳过
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
    }
  }
}
