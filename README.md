# openclaw-voice-vad

Voice Assistant for OpenClaw - 语音交互服务

## Features

- 🎤 麦克风实时语音监听
- 🔇 VAD 静音检测自动停止录音
- 🗣️ 百度 ASR 语音识别
- 🤖 调用 OpenClaw 获取智能回复
- 📢 Edge TTS 流式语音合成（低延迟，句子级分段播放）
- 💬 消息队列合并（连续说话自动合并）
- 🚫 无需唤醒词（免唤醒模式）
- 🎬 视频播放器（支持空闲/说话双模式切换）

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ AudioCollector│     │  VAD检测    │     │   百度ASR   │
│  (Producer)  │ --> │ (Processor) │ --> │  (识别)     │
└─────────────┘     └─────────────┘     └──────┬──────┘
                                               │
                                               ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   扬声器     │ <── │  Edge TTS   │ <── │  OpenClaw  │
│  (流式播放)  │     │  (管道输出)  │     │  (API调用)  │
└─────────────┘     └─────────────┘     └─────────────┘
       ▲                                       │
       └────────────── 消息队列 ←──────────────┘
```

### Pipeline 架构

- **AudioCollector**: FFmpeg 采集麦克风音频，切分成 100ms 音频块
- **RingBuffer**: 环形缓冲区，解耦采集和处理
- **VADProcessor**: 语音活动检测，判断开始/结束录音
- **NetworkSender**: 消息队列，合并连续消息，调用 OpenClaw API，流式 TTS 播放

## Quick Start

### 1. 安装依赖

```bash
cd ~/.openclaw/workspace/openclaw-voice-vad
npm install
npm run build
```

### 2. 启动服务

```bash
# Pipeline 架构（新版）
npm run start:pipeline

# 旧版 daemon
npm start
```

### 3. 使用方法

1. 直接对着麦克风说话（无需唤醒词）
2. 说话后等待 0.8 秒静音自动停止录音
3. 等待 OpenClaw 回复（约 4 秒）
4. 听到 TTS 语音播放

### 4. 停止服务

```bash
pkill -f "node dist/pipeline-daemon.js"
```

## Configuration

配置文件在 `src/pipeline-daemon.ts` 中的 `CONFIG` 对象：

```typescript
const CONFIG = {
  // 音频
  pulseServer: "/mnt/wslg/PulseServer",
  sampleRate: 16000,
  channels: 1,

  // VAD 参数
  silenceThreshold: 30,    // RMS 阈值
  silenceTimeout: 800,    // 静音超时(毫秒)

  // 队列
  queueCapacity: 100,    // 环形缓冲区容量

  // TTS
  ttsVoice: "zh-CN-XiaoxiaoNeural",

  // 百度 ASR
  baiduAppId: "122104542",
  baiduApiKey: "your-api-key",
  baiduSecretKey: "your-secret-key",

  // OpenClaw
  agentId: "main",

  // Video
  videoEnabled: true,
  idleVideo: "/path/to/idle.mp4",
  speakingVideo: "/path/to/speaking.mp4",
};
```

## 语音交互流程

```
1. 麦克风采集音频（FFmpeg）
        │
        ▼
2. VAD 检测声音（RMS > 30）
        │
        ▼
3. 开始录音 → 静音 0.8 秒后停止
        │
        ▼
4. 百度 ASR 识别文字
        │
        ▼
5. 消息入队（合并连续消息）
        │
        ▼
6. 调用 OpenClaw API（Gateway 模式）
        │
        ▼
7. Edge TTS 流式播放（管道输出，低延迟）
```

## 消息队列机制

- 连续多条消息会自动合并成一条发送
- 处理中时新消息会排队等待
- 避免消息堆积

```typescript
// 取出所有排队消息，合并发送
while (queue.length > 0) {
  messages.push(queue.shift().text);
}
const mergedText = messages.join("\n");
```

## TTS 优化

流式输出 + 低延迟参数：

```bash
mpv - \
  --cache=no \
  --audio-buffer=0.2 \
  --really-quiet \
  --no-video
```

## Development

```bash
# 开发模式（热重载）
npm run dev:pipeline

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
