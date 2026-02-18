/**
 * WebRTC VAD based Voice Activity Detection
 */

export interface VADOptions {
  /** Sampling rate: 8000, 16000, 32000, 48000 */
  sampleRate?: number;
  /** Frame size in ms: 10, 20, 30 */
  frameSize?: number;
  /** Aggressiveness mode: 0-3 (0 = least aggressive, 3 = most) */
  aggressiveness?: 0 | 1 | 2 | 3;
  /** Callback when speech is detected */
  onSpeechStart?: () => void;
  /** Callback when speech ends */
  onSpeechEnd?: (duration: number) => void;
}

/**
 * Create a VAD detector
 */
export function createVAD(options: VADOptions = {}) {
  const sampleRate = options.sampleRate || 16000;
  const frameSize = options.frameSize || 20;
  const aggressiveness = options.aggressiveness || 3;
  
  let isSpeaking = false;
  let speechStartTime = 0;
  
  // Simple VAD using amplitude detection (WebRTC VAD requires native binding)
  // For now, use amplitude-based detection
  const SILENCE_THRESHOLD = 500;
  
  function detect(Buffer: Buffer): boolean {
    // Calculate RMS amplitude
    const data = new Int16Array(Buffer.buffer, Buffer.byteOffset, Buffer.length / 2);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      sum += Math.abs(data[i]);
    }
    const rms = sum / data.length;
    
    const speaking = rms > SILENCE_THRESHOLD;
    
    if (speaking && !isSpeaking) {
      // Speech started
      isSpeaking = true;
      speechStartTime = Date.now();
      options.onSpeechStart?.();
    } else if (!speaking && isSpeaking) {
      // Speech ended
      isSpeaking = false;
      const duration = Date.now() - speechStartTime;
      options.onSpeechEnd?.(duration);
    }
    
    return speaking;
  }
  
  return {
    detect,
    isSpeaking: () => isSpeaking,
    destroy: () => {}
  };
}
