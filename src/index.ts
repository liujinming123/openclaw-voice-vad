/**
 * Voice VAD Plugin for OpenClaw
 * 
 * Features:
 * - Voice Activity Detection using WebRTC VAD
 * - Audio recording with silence detection
 * - Automatic speech capture
 */

export { createVAD, type VADOptions } from "./vad.js";
export { AudioRecorder, type RecorderOptions } from "./recorder.js";
export { isSpeechActive } from "./detector.js";
