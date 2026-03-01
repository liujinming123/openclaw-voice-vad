/**
 * Pipeline Daemon - New Architecture
 * 
 * Pipeline architecture with producer-consumer model:
 * - Audio Collector (Producer): Captures audio from microphone
 * - VAD Processor (Consumer 1): Detects voice activity
 * - Network Sender (Consumer 2): Sends to OpenClaw and plays TTS
 * 
 * Each stage runs independently, allowing parallel processing.
 */

import { EventEmitter } from "node:events";
import { AudioCollector } from "./collector.js";
import { VADProcessor } from "./vad-processor.js";
import { NetworkSender } from "./network-sender.js";
import { BaiduASR } from "./asr.js";
import { RingBuffer, AudioChunk } from "./queue.js";
import fs from "node:fs/promises";
import path from "node:path";

// Configuration
const CONFIG = {
  // Audio
  pulseServer: "/mnt/wslg/PulseServer",
  sampleRate: 16000,
  channels: 1,

  // VAD
  silenceThreshold: 100,
  silenceTimeout: 800,

  // Queue
  queueCapacity: 100,

  // TTS
  ttsVoice: "zh-CN-XiaoxiaoNeural",

  // Wake word - empty = no wake word required
  wakeWord: "",

  // Baidu ASR
  baiduAppId: "122104542",
  baiduApiKey: "i7BC3svWTUubMKlBWOlH0QGT",
  baiduSecretKey: "3O5ILiZ6xEjNpL9QWXgdeA6IAjojtcc4",

  // OpenClaw Agent
  agentId: "main",

  // Temp directory for audio files
  tempDir: "/tmp/openclaw-vad",

  // Gateway WebSocket (for lower latency than CLI)
  gatewayUrl: "ws://127.0.0.1:18789",
  gatewayToken: "f3a1ed4004b4d584b7577ac4c5744e912fbca7e30c36c82f",
};

export class PipelineDaemon extends EventEmitter {
  private collector: AudioCollector;
  private vadProcessor: VADProcessor;
  private networkSender: NetworkSender;
  private asr: BaiduASR;
  private audioBuffer: RingBuffer<AudioChunk>;
  private isRunning: boolean = false;
  private state: "idle" | "listening" | "recording" | "speaking" | "processing" = "idle";
  private isRecording: boolean = false;
  private recordedChunks: Buffer[] = [];

  constructor() {
    super();

    // Initialize audio buffer (thread-safe queue)
    this.audioBuffer = new RingBuffer<AudioChunk>(CONFIG.queueCapacity);

    // Initialize components
    this.collector = new AudioCollector({
      sampleRate: CONFIG.sampleRate,
      channels: CONFIG.channels,
      pulseServer: CONFIG.pulseServer,
      queueCapacity: CONFIG.queueCapacity,
    });

    this.vadProcessor = new VADProcessor({
      silenceThreshold: CONFIG.silenceThreshold,
      silenceTimeout: CONFIG.silenceTimeout,
    });

    this.networkSender = new NetworkSender({
      agentId: CONFIG.agentId,
      ttsVoice: CONFIG.ttsVoice,
      gatewayUrl: CONFIG.gatewayUrl,
      gatewayToken: CONFIG.gatewayToken,
    });

    this.asr = new BaiduASR({
      appId: CONFIG.baiduAppId,
      apiKey: CONFIG.baiduApiKey,
      secretKey: CONFIG.baiduSecretKey,
    });

    this.setupEventHandlers();
  }

  /**
   * Setup event handlers for pipeline
   */
  private setupEventHandlers(): void {
    // Collector events
    this.collector.on("started", () => {
      this.log("[Collector] Started");
    });

    this.collector.on("stopped", () => {
      this.log("[Collector] Stopped");
    });

    this.collector.on("error", (err) => {
      this.log("[Collector] Error:", err.message);
    });

    // Connect collector to VAD - push audio chunks via event (no polling)
    this.collector.on("audio", (chunk: AudioChunk) => {
      // Push to buffer for other consumers
      this.audioBuffer.push(chunk);
      // Directly process in VAD (event-driven)
      this.vadProcessor.processChunk(chunk);
    });

    // VAD events
    let recordChunkCount = 0;
    this.vadProcessor.on("voiceStart", () => {
      this.log("[VAD] Voice detected - starting recording");
      
      // Interrupt current TTS if playing
      this.networkSender.interrupt();
      
      this.isRecording = true;
      this.recordedChunks = [];
      recordChunkCount = 0;
      this.setState("recording");
    });

    this.vadProcessor.on("voiceChunk", (chunk: AudioChunk) => {
      if (this.isRecording) {
        this.recordedChunks.push(chunk.data);
        recordChunkCount++;
        // Log every 10 chunks (~1 second) during recording
        if (recordChunkCount % 10 === 0) {
          // Calculate RMS for logging
          let sum = 0;
          const numSamples = chunk.data.length / 2;
          for (let i = 0; i < numSamples; i++) {
            const sample = chunk.data.readInt16LE(i * 2);
            sum += sample * sample;
          }
          const rms = Math.sqrt(sum / numSamples);
          this.log(`[Recording] Chunk ${recordChunkCount}, RMS: ${rms.toFixed(2)}, bytes: ${chunk.data.length}`);
        }
      }
    });

    this.vadProcessor.on("voiceEnd", async () => {
      this.log("[VAD] Voice ended - processing audio");
      this.isRecording = false;
      this.setState("processing");

      // Process recorded audio
      if (this.recordedChunks.length > 0) {
        await this.processRecording();
      }

      // Return to listening state
      this.setState("listening");
    });

    // Network sender events
    this.networkSender.on("apiCallStart", () => {
      this.log("[Network] Calling OpenClaw API...");
    });

    this.networkSender.on("apiCallEnd", () => {
      this.log("[Network] Received response");
    });

    this.networkSender.on("ttsStart", () => {
      this.log("[Network] Playing TTS...");
      this.setState("speaking");
    });

    this.networkSender.on("ttsEnd", () => {
      this.log("[Network] TTS complete");
      this.setState("listening");
    });

    this.networkSender.on("error", (err) => {
      this.log("[Network] Error:", err.message);
    });
  }

  /**
   * Clean up old temp files on startup
   */
  private async cleanupTempFiles(): Promise<void> {
    try {
      const files = await fs.readdir(CONFIG.tempDir);
      const now = Date.now();
      for (const file of files) {
        if (file.startsWith("pipeline-audio-") && file.endsWith(".wav")) {
          const filePath = path.join(CONFIG.tempDir, file);
          const stats = await fs.stat(filePath);
          // Delete files older than 1 hour
          if (now - stats.mtimeMs > 3600000) {
            await fs.unlink(filePath);
            this.log(`[Cleanup] Removed old temp file: ${file}`);
          }
        }
      }
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        this.log("[Cleanup] Error:", err.message);
      }
    }
  }

  /**
   * Process recorded audio
   */
  private async processRecording(): Promise<void> {
    let audioPath: string | null = null;
    try {
      // Save audio to temp file
      const audioData = Buffer.concat(this.recordedChunks);
      audioPath = path.join(CONFIG.tempDir, `pipeline-audio-${Date.now()}.wav`);
      
      // Ensure temp dir exists
      await fs.mkdir(CONFIG.tempDir, { recursive: true });
      
      await fs.writeFile(audioPath, audioData);
      this.log(`[Processing] Audio saved: ${audioPath} (${audioData.length} bytes)`);

      // Recognize with Baidu ASR
      const text = await this.asr.recognize(audioPath);
      this.log(`[ASR] Recognized: "${text}"`);

      if (!text) {
        this.log("[ASR] No speech recognized");
        return;
      }

      // Send to OpenClaw
      this.log(`[ASR] Sending to OpenClaw: "${text}"`);
      this.networkSender.enqueue(text);

    } catch (error: any) {
      this.log("[Processing] Error:", error.message);
    } finally {
      // Always clean up temp file
      if (audioPath) {
        await fs.unlink(audioPath).catch(() => {});
      }
    }
  }

  /**
   * Set pipeline state
   */
  private setState(state: "idle" | "listening" | "recording" | "speaking" | "processing"): void {
    this.state = state;
    this.log(`[State] ${state}`);
  }

  /**
   * Log message
   */
  private log(...args: any[]): void {
    console.log(`[${new Date().toISOString()}]`, ...args);
    this.emit("log", args.join(" "));
  }

  /**
   * Start the pipeline
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.log("[Pipeline] Starting...");

    // Clean up old temp files on startup
    await this.cleanupTempFiles();

    // Start all components
    this.collector.start();
    this.vadProcessor.start();
    this.networkSender.start();

    this.setState("listening");
    
    // 根据是否有唤醒词显示不同提示
    if (CONFIG.wakeWord) {
      this.log(`[Pipeline] Started successfully - say '${CONFIG.wakeWord}' to wake me up!`);
    } else {
      this.log("[Pipeline] Started successfully - I'm listening! (no wake word required)");
    }
  }

  /**
   * Stop the pipeline
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    this.log("[Pipeline] Stopping...");

    // Stop all components
    this.collector.stop();
    this.vadProcessor.stop();
    this.networkSender.stop();

    this.setState("idle");
    this.log("[Pipeline] Stopped");
  }

  /**
   * Get current state
   */
  getState(): string {
    return this.state;
  }

  /**
   * Get pipeline status
   */
  getStatus(): object {
    return {
      isRunning: this.isRunning,
      state: this.state,
      bufferCount: this.audioBuffer.getCount(),
    };
  }
}

// Start the daemon
const daemon = new PipelineDaemon();

daemon.on("log", (msg: string) => {
  console.log(msg);
});

process.on("SIGINT", async () => {
  console.log("\nReceived SIGINT, stopping...");
  await daemon.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\nReceived SIGTERM, stopping...");
  await daemon.stop();
  process.exit(0);
});

// Start
daemon.start().catch((err) => {
  console.error("Failed to start daemon:", err);
  process.exit(1);
});
