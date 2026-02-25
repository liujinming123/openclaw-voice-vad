/**
 * Audio Collector - Producer
 * 
 * Responsible for:
 * 1. Continuously capturing raw audio from microphone
 * 2. Putting audio data into thread-safe queue
 * 3. Returning immediately to avoid blocking
 */

import { spawn, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { RingBuffer, AudioChunk } from "./queue.js";

export class AudioCollector extends EventEmitter {
  private ffmpeg: ChildProcess | null = null;
  private queue: RingBuffer<AudioChunk>;
  private isRunning: boolean = false;
  private sampleRate: number;
  private channels: number;
  private pulseServer: string;
  private chunkSize: number; // bytes per chunk
  private collectionInterval: NodeJS.Timeout | null = null;

  constructor(options: {
    sampleRate?: number;
    channels?: number;
    pulseServer?: string;
    queueCapacity?: number;
    chunkSize?: number;
  } = {}) {
    super();
    this.sampleRate = options.sampleRate || 16000;
    this.channels = options.channels || 1;
    this.pulseServer = options.pulseServer || "/mnt/wslg/PulseServer";
    this.queue = new RingBuffer<AudioChunk>(options.queueCapacity || 100);
    this.chunkSize = options.chunkSize || 3200; // ~100ms at 16kHz
  }

  /**
   * Start audio collection (producer)
   */
  start(): void {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.emit("started");

    // Start ffmpeg to capture audio
    this.ffmpeg = spawn("ffmpeg", [
      "-f", "pulse",
      "-i", "default",
      "-ar", String(this.sampleRate),
      "-ac", String(this.channels),
      "-acodec", "pcm_s16le",
      "-t", "0", // continuous
      "-", // output to stdout
    ], {
      env: { ...process.env, PULSE_SERVER: this.pulseServer }
    });

    let buffer = Buffer.alloc(0);

    this.ffmpeg.stdout?.on("data", (chunk: Buffer) => {
      if (!this.isRunning) return;

      buffer = Buffer.concat([buffer, chunk]);

      // Emit raw audio data for VAD processing
      this.emit("audio", buffer);
    });

    this.ffmpeg.stderr?.on("data", (data: Buffer) => {
      // FFmpeg logs
    });

    this.ffmpeg.on("error", (err) => {
      this.emit("error", err);
    });

    this.ffmpeg.on("close", (code) => {
      if (this.isRunning) {
        this.emit("error", new Error(`FFmpeg exited with code ${code}`));
      }
    });
  }

  /**
   * Stop audio collection
   */
  stop(): void {
    this.isRunning = false;
    
    if (this.ffmpeg) {
      this.ffmpeg.kill();
      this.ffmpeg = null;
    }

    if (this.collectionInterval) {
      clearInterval(this.collectionInterval);
      this.collectionInterval = null;
    }

    this.emit("stopped");
  }

  /**
   * Get queue for downstream processing
   */
  getQueue(): RingBuffer<AudioChunk> {
    return this.queue;
  }

  /**
   * Check if collector is running
   */
  isActive(): boolean {
    return this.isRunning;
  }
}
