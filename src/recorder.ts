/**
 * Audio Recorder with VAD
 */

import { spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createVAD, type VADOptions } from "./vad.js";

const execAsync = promisify(exec);

export interface RecorderOptions {
  /** Output file path */
  outputPath?: string;
  /** Max recording duration in ms */
  maxDuration?: number;
  /** Silence timeout in ms to stop recording */
  silenceTimeout?: number;
  /** VAD options */
  vadOptions?: VADOptions;
  /** Callback when recording starts */
  onStart?: () => void;
  /** Callback when recording stops */
  onStop?: (filePath: string, duration: number) => void;
  /** Callback on error */
  onError?: (err: Error) => void;
}

/**
 * Audio Recorder with VAD
 */
export class AudioRecorder {
  private options: Required<RecorderOptions>;
  private vad: ReturnType<typeof createVAD> | null = null;
  private isRecording = false;
  private startTime = 0;
  private silenceStartTime = 0;
  private outputFile = "";
  private proc: ReturnType<typeof spawn> | null = null;
  
  constructor(options: RecorderOptions = {}) {
    this.options = {
      outputPath: options.outputPath || path.join(os.tmpdir(), "recording.wav"),
      maxDuration: options.maxDuration || 30000,
      silenceTimeout: options.silenceTimeout || 2000,
      vadOptions: options.vadOptions || {},
      onStart: options.onStart || (() => {}),
      onStop: options.onStop || (() => {}),
      onError: options.onError || (() => {}),
    };
    this.outputFile = this.options.outputPath;
  }
  
  /**
   * Start recording
   */
  async start(): Promise<void> {
    if (this.isRecording) {
      return;
    }
    
    this.isRecording = true;
    this.startTime = Date.now();
    this.silenceStartTime = 0;
    
    // Ensure output directory exists
    const dir = path.dirname(this.outputFile);
    await fs.mkdir(dir, { recursive: true });
    
    // Start VAD
    this.vad = createVAD({
      ...this.options.vadOptions,
      onSpeechStart: () => {
        this.silenceStartTime = 0;
      },
      onSpeechEnd: (duration) => {
        if (this.silenceStartTime === 0) {
          this.silenceStartTime = Date.now();
        }
      }
    });
    
    this.options.onStart();
    
    // TODO: Start audio capture from microphone
    // For now, just simulate
  }
  
  /**
   * Stop recording
   */
  async stop(): Promise<string> {
    if (!this.isRecording) {
      return "";
    }
    
    this.isRecording = false;
    
    const duration = Date.now() - this.startTime;
    
    this.vad?.destroy();
    this.vad = null;
    
    this.options.onStop(this.outputFile, duration);
    
    return this.outputFile;
  }
  
  /**
   * Check if currently recording
   */
  isActive(): boolean {
    return this.isRecording;
  }
}

/**
 * Simple function to record audio
 */
export async function recordAudio(options: RecorderOptions = {}): Promise<string> {
  const recorder = new AudioRecorder(options);
  await recorder.start();
  
  // Wait for max duration or manual stop
  return new Promise((resolve) => {
    setTimeout(async () => {
      const file = await recorder.stop();
      resolve(file);
    }, options.maxDuration || 30000);
  });
}
