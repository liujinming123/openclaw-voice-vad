/**
 * Thread-safe queue for pipeline architecture
 * Uses a ring buffer for efficient memory management
 */

export class RingBuffer<T> {
  private buffer: T[];
  private head: number = 0;
  private tail: number = 0;
  private size: number;
  private count: number = 0;

  constructor(capacity: number) {
    this.size = capacity;
    this.buffer = new Array(capacity);
  }

  push(item: T): boolean {
    if (this.count >= this.size) {
      return false; // Buffer full
    }
    this.buffer[this.tail] = item;
    this.tail = (this.tail + 1) % this.size;
    this.count++;
    return true;
  }

  pop(): T | null {
    if (this.count === 0) {
      return null; // Buffer empty
    }
    const item = this.buffer[this.head];
    this.head = (this.head + 1) % this.size;
    this.count--;
    return item;
  }

  isEmpty(): boolean {
    return this.count === 0;
  }

  isFull(): boolean {
    return this.count >= this.size;
  }

  getCount(): number {
    return this.count;
  }

  clear(): void {
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }
}

/**
 * Audio chunk for pipeline
 */
export interface AudioChunk {
  data: Buffer;
  timestamp: number;
  duration: number;
}

/**
 * Pipeline stages
 */
export type PipelineStage = "idle" | "recording" | "vad" | "asr" | "api" | "tts" | "speaking";

/**
 * Pipeline event
 */
export interface PipelineEvent {
  stage: PipelineStage;
  data?: any;
  error?: Error;
}
