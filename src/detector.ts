/**
 * Simple speech detector
 */

/**
 * Check if audio buffer contains speech (simple amplitude detection)
 */
export function isSpeechActive(audioData: Buffer, threshold: number = 500): boolean {
  // Convert to 16-bit samples
  const samples = new Int16Array(audioData.buffer, audioData.byteOffset, audioData.length / 2);
  
  // Calculate RMS
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  const rms = Math.sqrt(sum / samples.length);
  
  return rms > threshold;
}

/**
 * Detect speech segments in audio buffer
 */
export function detectSpeechSegments(
  audioData: Buffer,
  options: {
    threshold?: number;
    minSpeechDuration?: number;
    minSilenceDuration?: number;
  } = {}
): Array<{ start: number; end: number }> {
  const threshold = options.threshold || 500;
  const minSpeechDuration = options.minSpeechDuration || 100; // ms
  const minSilenceDuration = options.minSilenceDuration || 300; // ms
  
  const samples = new Int16Array(audioData.buffer, audioData.byteOffset, audioData.length / 2);
  const sampleRate = 16000; // Assume 16kHz
  const msPerSample = 1000 / sampleRate
  
  const segments: Array<{ start: number; end: number }> = [];
  let speechStart = -1;
  let silenceStart = -1;
  
  for (let i = 0; i < samples.length; i++) {
    const isSpeech = Math.abs(samples[i]) > threshold;
    const timeMs = i * msPerSample;
    
    if (isSpeech) {
      if (speechStart === -1) {
        speechStart = timeMs;
      }
      silenceStart = -1;
    } else {
      if (speechStart !== -1 && silenceStart === -1) {
        silenceStart = timeMs;
      }
      if (silenceStart !== -1 && timeMs - silenceStart > minSilenceDuration) {
        // End of speech segment
        if (timeMs - speechStart >= minSpeechDuration) {
          segments.push({ start: speechStart, end: silenceStart });
        }
        speechStart = -1;
        silenceStart = -1;
      }
    }
  }
  
  // Handle trailing speech
  if (speechStart !== -1) {
    segments.push({ start: speechStart, end: samples.length * msPerSample });
  }
  
  return segments;
}
