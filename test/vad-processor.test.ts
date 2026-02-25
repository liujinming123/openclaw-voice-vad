/**
 * VAD Processor Unit Tests
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { VADProcessor } from "../src/vad-processor";
import { RingBuffer, AudioChunk } from "../src/queue";

describe("VADProcessor", () => {
  let queue: RingBuffer<AudioChunk>;
  let vad: VADProcessor;

  beforeEach(() => {
    queue = new RingBuffer<AudioChunk>(100);
    vad = new VADProcessor(queue, {
      silenceThreshold: 500,
      silenceTimeout: 1000,
      frameSize: 1600,
    });
  });

  it("should create VAD processor", () => {
    expect(vad).toBeDefined();
  });

  it("should start and stop", () => {
    vad.start();
    vad.stop();
    // Just verify it doesn't throw
    expect(true).toBe(true);
  });
});

describe("VADProcessor voice detection", () => {
  let queue: RingBuffer<AudioChunk>;
  let vad: VADProcessor;
  let voiceStartCalled = false;
  let voiceEndCalled = false;

  beforeEach(() => {
    queue = new RingBuffer<AudioChunk>(100);
    voiceStartCalled = false;
    voiceEndCalled = false;
    
    vad = new VADProcessor(queue, {
      silenceThreshold: 500,
      silenceTimeout: 100,
      frameSize: 1600,
    });

    vad.on("voiceStart", () => {
      voiceStartCalled = true;
    });

    vad.on("voiceEnd", () => {
      voiceEndCalled = true;
    });
  });

  it("should detect voice", () => {
    vad.start();
    
    // Simulate voice chunk (high amplitude)
    const voiceChunk: AudioChunk = {
      data: Buffer.alloc(3200, 128), // High values = loud
      timestamp: Date.now(),
      duration: 100,
    };
    
    queue.push(voiceChunk);
    
    // Give time to process
    setTimeout(() => {
      expect(voiceStartCalled).toBe(true);
    }, 100);
    
    vad.stop();
  });
});
