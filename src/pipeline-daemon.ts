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
  // OpenClaw API
  openclawUrl: process.env.OPENCLAW_URL || "http://127.0.0.1:18789",
  openclawToken: process.env.OPENCLAW_TOKEN || "f3a1ed4004b4d584b7577ac4c5744e912fbca7e30c36c82f",
  
  // Audio
  pulseServer: "/mnt/wslg/PulseServer",
  sampleRate: 16000,
  channels: 1,
  
  // VAD
  silenceThreshold: 500,
  silenceTimeout: 1000,
  
  // Queue
  queueCapacity: 100,
  
  // TTS
  ttsVoice: "zh-CN-XiaoxiaoNeural",

  // Wake word
  wakeWord: "你好",
  dialogueTimeout: 10000, // 10 seconds of silence to exit dialogue mode
  
  // Baidu ASR
  baiduAppId: "122104542",
  baiduApiKey: "i7BC3svWTUubMKlBWOlH0QGT",
  baiduSecretKey: "3O5ILiZ6xEjNpL9QWXgdeA6IAjojtcc4",
};

export class PipelineDaemon extends EventEmitter {
  private collector: AudioCollector;
  private vadProcessor: VADProcessor;
  private networkSender: NetworkSender;
  private asr: BaiduASR;
  private audioBuffer: RingBuffer<AudioChunk>;
  private isRunning: boolean = false;
  private state: "idle" | "listening" | "recording" | "speaking" | "processing" | "dialogue" = "idle";
  private isRecording: boolean = false;
  private recordedChunks: Buffer[] = [];
  private inDialogueMode: boolean = false;
  private lastSpeechTime: number = 0;
  private dialogueTimeout: NodeJS.Timeout | null = null;

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

    this.vadProcessor = new VADProcessor(this.audioBuffer, {
      silenceThreshold: CONFIG.silenceThreshold,
      silenceTimeout: CONFIG.silenceTimeout,
    });

    this.networkSender = new NetworkSender({
      openclawUrl: CONFIG.openclawUrl,
      openclawToken: CONFIG.openclawToken,
      ttsVoice: CONFIG.ttsVoice,
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

    // VAD events
    this.vadProcessor.on("voiceStart", () => {
      this.log("[VAD] Voice detected - starting recording");
      this.isRecording = true;
      this.recordedChunks = [];
      this.setState("recording");
    });

    this.vadProcessor.on("voiceChunk", (chunk: AudioChunk) => {
      if (this.isRecording) {
        this.recordedChunks.push(chunk.data);
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
      
      // Check if we should exit dialogue mode
      if (this.inDialogueMode) {
        const now = Date.now();
        if (now - this.lastSpeechTime > CONFIG.dialogueTimeout) {
          this.log("[Dialogue] Timeout - exiting dialogue mode");
          this.inDialogueMode = false;
          this.networkSender.playTTS("好的对话结束，有需要再叫我～");
        }
      }
      
      this.setState("listening");
    });

    this.networkSender.on("error", (err) => {
      this.log("[Network] Error:", err.message);
    });
  }

  /**
   * Process recorded audio
   */
  private async processRecording(): Promise<void> {
    try {
      // Save audio to temp file
      const audioData = Buffer.concat(this.recordedChunks);
      const audioPath = `/tmp/pipeline-audio-${Date.now()}.wav`;
      await fs.writeFile(audioPath, audioData);
      this.log(`[Processing] Audio saved: ${audioPath} (${audioData.length} bytes)`);

      // Recognize with Baidu ASR
      const text = await this.asr.recognize(audioPath);
      this.log(`[ASR] Recognized: "${text}"`);

      // Clean up
      await fs.unlink(audioPath).catch(() => {});

      if (!text) {
        this.log("[ASR] No speech recognized");
        return;
      }

      // Update last speech time for dialogue timeout
      this.lastSpeechTime = Date.now();

      // Check for wake word
      if (this.asr.containsWakeWord(text, CONFIG.wakeWord)) {
        // Wake word detected!
        this.log("[Wake] Wake word detected!");
        this.inDialogueMode = true;
        
        // Play response
        this.networkSender.playTTS("我在");
        
        // Extract command after wake word
        const command = this.asr.extractCommand(text, CONFIG.wakeWord);
        if (command) {
          this.networkSender.enqueue(command);
        }
      } else if (this.inDialogueMode) {
        // In dialogue mode - send to OpenClaw
        this.networkSender.enqueue(text);
      } else {
        this.log("[Dialogue] Not in dialogue mode, ignoring");
      }

    } catch (error: any) {
      this.log("[Processing] Error:", error.message);
    }
  }

  /**
   * Set pipeline state
   */
  private setState(state: "idle" | "listening" | "recording" | "speaking" | "processing" | "dialogue"): void {
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

    // Start all components
    this.collector.start();
    this.vadProcessor.start();
    this.networkSender.start();

    this.setState("listening");
    this.log("[Pipeline] Started successfully - say '你好' to wake me up!");
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

    // Clear dialogue timeout
    if (this.dialogueTimeout) {
      clearTimeout(this.dialogueTimeout);
    }

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
      inDialogueMode: this.inDialogueMode,
      bufferCount: this.audioBuffer.getCount(),
    };
  }
}
