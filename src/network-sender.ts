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
import fs from "node:fs/promises";

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
      // Use openclaw agent CLI command with --local to get direct response
      const { stdout } = await execAsync(
        `openclaw agent --agent "${this.agentId}" --message "${text.replace(/"/g, '\\"')}" --local`,
        { timeout: 60000, encoding: "utf-8" }
      );

      // Extract response from stdout
      // OpenClaw output format may have ANSI codes, strip them
      const cleanOutput = stdout
        .replace(/\x1b\[[0-9;]*m/g, "") // Remove ANSI codes
        .trim();

      return cleanOutput || "抱歉，我没有听明白";
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
   * Play TTS using Edge TTS (async, non-blocking)
   */
  async playTTS(text: string): Promise<void> {
    // Interrupt any current playback
    this.interrupt();

    try {
      this.isPlaying = true;
      this.emit("ttsStart");

      // Generate TTS audio
      const audioPath = `/tmp/pipeline-tts-${Date.now()}.mp3`;

      await execAsync(
        `edge-tts --voice "${this.ttsVoice}" --text "${text.replace(/"/g, '\\"')}" --write-media "${audioPath}"`,
        { timeout: 30000 }
      );

      // Play using mpv (non-blocking)
      this.currentTTSProcess = spawn("mpv", [audioPath, "--no-video", "--loop=no"], {
        stdio: "ignore",
      });

      // Wait for playback to complete
      await new Promise<void>((resolve) => {
        this.currentTTSProcess!.on("close", () => {
          this.currentTTSProcess = null;
          this.isPlaying = false;
          resolve();
        });
      });

      this.emit("ttsEnd");

      // Clean up
      try {
        await fs.unlink(audioPath);
      } catch {}

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
   */
  private async processQueue(): Promise<void> {
    if (this.queue.length === 0) {
      return;
    }

    const request = this.queue.shift();

    try {
      // Send to OpenClaw
      this.emit("apiCallStart", { text: request.text });
      const response = await this.sendToOpenClaw(request.text);
      this.emit("apiCallEnd", { response });

      // Play TTS (will interrupt if already playing)
      await this.playTTS(response);
    } catch (error: any) {
      this.emit("error", error);
    }
  }
}
