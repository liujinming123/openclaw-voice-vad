/**
 * VAD Processor - Consumer
 * 
 * Responsible for:
 * 1. Detecting voice activity in audio stream
 * 2. Detecting silence (for stopping recording)
 * 3. Passing processed audio to next stage
 */

import { EventEmitter } from "node:events";
import { RingBuffer, AudioChunk } from "./queue.js";

export interface VADOptions {
  silenceThreshold?: number;  // RMS threshold for silence
  silenceTimeout?: number;   // ms of silence before stopping
  frameSize?: number;        // samples per frame
}

export class VADProcessor extends EventEmitter {
  private queue: RingBuffer<AudioChunk>;
  private isProcessing: boolean = false;
  private isVoiceDetected: boolean = false;
  private silenceDuration: number = 0;
  private silenceThreshold: number;
  private silenceTimeout: number;
  private frameSize: number;
  private processorInterval: NodeJS.Timeout | null = null;

  constructor(queue: RingBuffer<AudioChunk>, options: VADOptions = {}) {
    super();
    this.queue = queue;
    this.silenceThreshold = options.silenceThreshold || 500;
    this.silenceTimeout = options.silenceTimeout || 1000;
    this.frameSize = options.frameSize || 1600; // 100ms at 16kHz
  }

  /**
   * Start VAD processing (consumer)
   */
  start(): void {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;
    this.emit("started");

    // Process queue at regular intervals
    this.processorInterval = setInterval(() => {
      this.process();
    }, 50); // 20 times per second
  }

  /**
   * Stop VAD processing
   */
  stop(): void {
    this.isProcessing = false;
    
    if (this.processorInterval) {
      clearInterval(this.processorInterval);
      this.processorInterval = null;
    }

    this.isVoiceDetected = false;
    this.silenceDuration = 0;
    this.emit("stopped");
  }

  /**
   * Process audio from queue
   */
  private process(): void {
    const chunk = this.queue.pop();
    if (!chunk) {
      // Queue empty
      return;
    }

    const rms = this.calculateRMS(chunk.data);

    if (rms > this.silenceThreshold) {
      // Voice detected
      if (!this.isVoiceDetected) {
        this.isVoiceDetected = true;
        this.emit("voiceStart", { timestamp: chunk.timestamp });
      }
      this.silenceDuration = 0;
      
      // Emit voice chunk for recording
      this.emit("voiceChunk", chunk);
    } else {
      // Silence
      if (this.isVoiceDetected) {
        this.silenceDuration += chunk.duration;
        
        if (this.silenceDuration >= this.silenceTimeout) {
          // Silence timeout - stop recording
          this.isVoiceDetected = false;
          this.silenceDuration = 0;
          this.emit("voiceEnd");
        }
        
        // Still emit voice chunks during silence timeout
        this.emit("voiceChunk", chunk);
      }
    }
  }

  /**
   * Calculate RMS (Root Mean Square) for audio amplitude
   */
  private calculateRMS(buffer: Buffer): number {
    if (buffer.length < 2) return 0;

    let sum = 0;
    const numSamples = buffer.length / 2;

    for (let i = 0; i < numSamples; i++) {
      const sample = buffer.readInt16LE(i * 2);
      sum += sample * sample;
    }

    return Math.sqrt(sum / numSamples);
  }
}
