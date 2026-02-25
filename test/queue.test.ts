/**
 * Queue Unit Tests
 */

import { describe, it, expect, beforeEach } from "vitest";
import { RingBuffer, AudioChunk } from "../src/queue";

describe("RingBuffer", () => {
  let buffer: RingBuffer<number>;

  beforeEach(() => {
    buffer = new RingBuffer<number>(5);
  });

  it("should start empty", () => {
    expect(buffer.isEmpty()).toBe(true);
    expect(buffer.getCount()).toBe(0);
  });

  it("should push and pop items", () => {
    buffer.push(1);
    buffer.push(2);
    expect(buffer.getCount()).toBe(2);
    
    expect(buffer.pop()).toBe(1);
    expect(buffer.pop()).toBe(2);
    expect(buffer.isEmpty()).toBe(true);
  });

  it("should not push when full", () => {
    for (let i = 0; i < 5; i++) {
      buffer.push(i);
    }
    expect(buffer.isFull()).toBe(true);
    expect(buffer.push(99)).toBe(false);
  });

  it("should not pop when empty", () => {
    expect(buffer.pop()).toBe(null);
  });

  it("should handle wrap around", () => {
    buffer.push(1);
    buffer.push(2);
    buffer.push(3);
    buffer.pop();
    buffer.pop();
    buffer.push(4);
    buffer.push(5);
    buffer.push(6);
    
    expect(buffer.getCount()).toBe(4);
    expect(buffer.pop()).toBe(3);
    expect(buffer.pop()).toBe(4);
  });

  it("should clear", () => {
    buffer.push(1);
    buffer.push(2);
    buffer.clear();
    expect(buffer.isEmpty()).toBe(true);
  });
});

describe("AudioChunk", () => {
  it("should create audio chunk", () => {
    const chunk: AudioChunk = {
      data: Buffer.from([1, 2, 3]),
      timestamp: Date.now(),
      duration: 100,
    };
    
    expect(chunk.data.length).toBe(3);
    expect(chunk.duration).toBe(100);
  });
});
