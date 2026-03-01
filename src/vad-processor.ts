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
  private isProcessing: boolean = false;
  private isVoiceDetected: boolean = false;
  private silenceDuration: number = 0;
  private silenceThreshold: number;
  private silenceTimeout: number;
  private frameSize: number;

  constructor(options: VADOptions = {}) {
    super();
    this.silenceThreshold = options.silenceThreshold || 100;
    this.silenceTimeout = options.silenceTimeout || 1000;
    this.frameSize = options.frameSize || 1600; // 100ms at 16kHz
  }

  /**
   * Process a single audio chunk (event-driven, no polling)
   */
  processChunk(chunk: AudioChunk): void {
    if (!this.isProcessing) {
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
   * Start VAD processing (event-driven, no polling)
   */
  start(): void {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;
    this.isVoiceDetected = false;
    this.silenceDuration = 0;
    this.emit("started");
  }

  /**
   * Stop VAD processing
   */
  stop(): void {
    this.isProcessing = false;
    this.isVoiceDetected = false;
    this.silenceDuration = 0;
    this.emit("stopped");
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
