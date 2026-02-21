# openclaw-voice-vad

Voice Assistant for OpenClaw - 语音唤醒交互服务

## Features

- 🎤 麦克风实时语音监听
- 🔊 唤醒词检测（默认："柳如烟"）
- 🗣️ 百度ASR语音识别
- 🤖 调用OpenClaw获取智能回复
- 📢 Edge TTS语音合成播放

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   麦克风     │ ──> │   VAD检测   │ ──> │  百度ASR    │
└─────────────┘     └─────────────┘     └─────────────┘
                                               │
                                               ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   扬声器     │ <── │  Edge TTS   │ <── │  OpenClaw  │
└─────────────┘     └─────────────┘     └─────────────┘
```

## Quick Start

### 1. 安装依赖

```bash
cd ~/.openclaw/workspace/openclaw-voice-vad
npm install
npm run build
```

### 2. 启动服务

```bash
node dist/daemon.js
```

### 3. 使用方法

1. 对着麦克风喊 **唤醒词 "柳如烟"**
2. 听到 "请说" 提示音
3. 说出你的问题
4. 等待语音回复

### 4. 停止服务

```bash
pkill -f "node dist/daemon.js"
```

## Configuration

配置文件在 `src/daemon.ts` 中的 `CONFIG` 对象：

```typescript
const CONFIG = {
  // OpenClaw API
  openclawUrl: "http://127.0.0.1:18789",
  openclawToken: "your-token",
  
  // 百度ASR
  baiduAppId: "122104542",
  baiduApiKey: "your-api-key",
  baiduSecretKey: "your-secret-key",
  
  // 音频
  pulseServer: "/mnt/wslg/PulseServer",
  sampleRate: 16000,
  
  // VAD参数
  silenceTimeout: 2000,   // 静音超时(毫秒)
  maxRecordingTime: 10000, // 最大录音时长(毫秒)
  
  // 唤醒词
  wakeWord: "柳如烟",
};
```

## Requirements

- Node.js 18+
- WSL2 (with WSLg for audio)
- 麦克风设备
- 百度 ASR API Key

## License

MIT
