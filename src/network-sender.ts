/**
 * Network Sender - Consumer
 * 
 * Responsible for:
 * 1. Sending audio/text to OpenClaw API
 * 2. Receiving AI responses
 * 3. Playing TTS responses
 * Uses async I/O to avoid blocking
 * Supports interruption when user speaks
 */

import { EventEmitter } from "node:events";
import axios from "axios";
import { spawn, ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";

const execAsync = promisify((await import("node:child_process")).exec);

export interface OpenClawConfig {
  url: string;
  token: string;
}

export interface NetworkSenderOptions {
  openclawUrl?: string;
  openclawToken?: string;
  ttsVoice?: string;
}

export class NetworkSender extends EventEmitter {
  private config: OpenClawConfig;
  private ttsVoice: string;
  private isProcessing: boolean = false;
  private queue: any[] = [];
  private processingInterval: NodeJS.Timeout | null = null;
  private currentTTSProcess: ChildProcess | null = null;
  private isPlaying: boolean = false;

  constructor(options: NetworkSenderOptions = {}) {
    super();
    this.config = {
      url: options.openclawUrl || "http://127.0.0.1:18789",
      token: options.openclawToken || process.env.OPENCLAW_TOKEN || "",
    };
    this.ttsVoice = options.ttsVoice || "zh-CN-XiaoxiaoNeural";
  }

  /**
   * Send text to OpenClaw API (async, non-blocking)
   */
  async sendToOpenClaw(text: string): Promise<string> {
    try {
      const response = await axios.post(
        `${this.config.url}/api/agent/run`,
        {
          message: text,
          agentId: "main",
        },
        {
          headers: {
            "Authorization": `Bearer ${this.config.token}`,
            "Content-Type": "application/json",
          },
          timeout: 30000,
        }
      );

      return response.data?.message || response.data?.text || "";
    } catch (error: any) {
      this.emit("error", error);
      throw error;
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
