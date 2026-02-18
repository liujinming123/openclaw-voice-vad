# voice-vad

Voice Activity Detection plugin for OpenClaw

## Features

- WebRTC VAD based voice detection
- Audio recording with silence detection
- Automatic speech capture

## Installation

```bash
cd ~/.openclaw/plugins/voice-vad
npm install
```

## Usage

```typescript
import { createVAD, AudioRecorder } from "./src/index.js";

// Create VAD detector
const vad = createVAD({
  sampleRate: 16000,
  aggressiveness: 3,
  onSpeechStart: () => console.log("Speech started"),
  onSpeechEnd: (duration) => console.log(`Speech ended after ${duration}ms`)
});

// Or use recorder
const recorder = new AudioRecorder({
  outputPath: "/tmp/recording.wav",
  maxDuration: 30000,
  silenceTimeout: 2000
});

await recorder.start();
// Recording...
await recorder.stop();
```

## Requirements

- Node.js 18+
- Audio input device (microphone)
