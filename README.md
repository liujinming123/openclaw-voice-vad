# openclaw-voice-vad

Voice Assistant for OpenClaw - 语音唤醒交互服务

## Features

- 🎤 麦克风实时语音监听
- 🔊 唤醒词检测（默认："你好"）
- 🗣️ 百度ASR语音识别
- 🤖 调用OpenClaw获取智能回复
- 📢 Edge TTS语音合成播放
- 🔇 VAD静音检测自动停止录音
- 💬 一次唤醒后持续对话（静默10秒后需重新唤醒）

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

1. 对着麦克风喊 **唤醒词 "你好"**
2. 听到 "我在" 提示音
3. 说出你的问题
4. 等待语音回复
5. **持续对话**，直到静默10秒

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
  silenceTimeout: 1000,   // 静音超时(毫秒)
  maxRecordingTime: 10000, // 最大录音时长(毫秒)
  
  // 唤醒词
  wakeWord: "你好",
};
```

## 语音交互流程

### 唤醒模式
1. 监听麦克风，等待唤醒词
2. 检测到唤醒词后播放 "我在"
3. 进入对话模式

### 对话模式
1. 接收用户语音输入
2. VAD检测静音，自动停止录音（1秒静音）
3. 百度ASR识别文字
4. 发送给OpenClaw获取回复
5. Edge TTS播放语音
6. 继续等待下一轮输入

### 超时退出
- 静默10秒后自动退出对话模式
- 重新需要唤醒词激活

## Development

```bash
# 开发模式（热重载）
npm run dev

# 构建
npm run build

# 测试
npm test
```

## Requirements

- Node.js 18+
- WSL2 (with WSLg for audio)
- 麦克风设备
- 百度 ASR API Key

## License

MIT
