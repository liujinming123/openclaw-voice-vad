/**
 * Voice Assistant Daemon
 * 
 * Independent service that:
 * 1. Continuously monitors microphone
 * 2. Detects voice activity (VAD)
 * 3. Records audio when voice detected
 * 4. Performs ASR when silence detected
 * 5. Sends to OpenClaw via API when wake word detected
 * 6. Plays TTS response (with interrupt support)
 */

import { spawn, exec, execSync, ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import axios from "axios";

const execAsync = promisify(exec);

// ============== Config ==============
const CONFIG = {
  // OpenClaw API
  openclawUrl: "http://127.0.0.1:18789",
  openclawToken: process.env.OPENCLAW_TOKEN || "f3a1ed4004b4d584b7577ac4c5744e912fbca7e30c36c82f",
  
  // Baidu ASR
  baiduAppId: "122104542",
  baiduApiKey: "i7BC3svWTUubMKlBWOlH0QGT",
  baiduSecretKey: "3O5ILiZ6xEjNpL9QWXgdeA6IAjojtcc4",
  
  // Audio
  pulseServer: "/mnt/wslg/PulseServer",
  sampleRate: 16000,
  
  // VAD
  silenceTimeout: 1000,  // ms of silence before stopping
  maxRecordingTime: 10000,  // max recording time
  
  // Wake word
  wakeWord: "你好",
};

// ============== State ==============
type State = "idle" | "listening" | "recording" | "processing" | "speaking";
let state: State = "idle";
let token: string | null = null;
let tokenExpireTime = 0;

// TTS process for interruption
let ttsProcess: ChildProcess | null = null;
let shouldInterrupt = false;

// ============== Utils ==============
function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function logState(from: string, to: string) {
  log(`State: ${from} -> ${to}`);
}

// ============== Audio ==============
async function isAudioAvailable(): Promise<boolean> {
  try {
    await fs.access(CONFIG.pulseServer);
    return true;
  } catch {
    return false;
  }
}

/**
 * Record audio from microphone
 */
async function recordAudio(outputPath: string, maxDuration: number = CONFIG.maxRecordingTime): Promise<void> {
  log(`Starting recording: ${outputPath}, duration: ${maxDuration}ms`);
  
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-f', 'pulse',
      '-i', 'default',
      '-ar', String(CONFIG.sampleRate),
      '-ac', '1',
      '-acodec', 'pcm_s16le',
      '-t', String(maxDuration / 1000),
      outputPath
    ];

    const proc = spawn('ffmpeg', args, {
      env: { ...process.env, PULSE_SERVER: CONFIG.pulseServer }
    });

    proc.stderr.on('data', d => log(`ffmpeg: ${d.toString().substr(0, 100)}`));
    proc.on('error', e => log(`ffmpeg error: ${e.message}`));
    proc.on('close', code => {
      log(`ffmpeg closed: ${code}`);
      resolve();
    });
  });
}

/**
 * Monitor audio level (simple VAD) - yields continuously
 */
async function* monitorAudioLevel(): AsyncGenerator<boolean> {
  // Use ffmpeg to pipe audio to stdout, read levels
  const proc = spawn('ffmpeg', [
    '-f', 'pulse',
    '-i', 'default',
    '-ar', '8000',
    '-ac', '1',
    '-f', 's16le',
    '-'
  ], {
    env: { ...process.env, PULSE_SERVER: CONFIG.pulseServer }
  });

  let buffer = Buffer.alloc(0);
  
  for await (const chunk of proc.stdout) {
    buffer = Buffer.concat([buffer, chunk]);
    
    // Check every 16000 samples (1 second)
    if (buffer.length >= 16000 * 2) {
      const samples = new Int16Array(buffer.buffer, buffer.byteOffset, 8000);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) {
        sum += Math.abs(samples[i]);
      }
      const avg = sum / samples.length;
      const isSpeaking = avg > 100;
      
      log(`Audio raw sum: ${sum}, samples: ${samples.length}, avg: ${avg}, threshold: 100, speaking: ${isSpeaking}`);
      
      yield isSpeaking;
      buffer = Buffer.alloc(0);
    }
  }
}

/**
 * Check audio level once (non-blocking)
 */
async function checkAudioLevel(): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`ffmpeg -f pulse -i default -ar 8000 -ac 1 -f s16le - -t 1 2>/dev/null | head -c 16000`, {
      env: { ...process.env, PULSE_SERVER: CONFIG.pulseServer }
    });
    
    if (!stdout || stdout.length < 16000) {
      return false;
    }
    
    const samples = new Int16Array(Buffer.from(stdout).buffer, 0, 8000);
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += Math.abs(samples[i]);
    }
    const avg = sum / samples.length;
    
    return avg > 100;
  } catch {
    return false;
  }
}

// ============== ASR ==============
async function getBaiduToken(): Promise<string> {
  const now = Date.now();
  if (token && now < tokenExpireTime) {
    return token!;
  }

  const url = 'https://aip.baidubce.com/oauth/2.0/token';
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CONFIG.baiduApiKey,
    client_secret: CONFIG.baiduSecretKey
  });

  const response = await axios.post(url, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });

  token = response.data.access_token;
  tokenExpireTime = now + (response.data.expires_in - 600) * 1000;
  return token!;
}

async function recognizeAudio(audioPath: string): Promise<string> {
  try {
    const accessToken = await getBaiduToken();
    const audioBuffer = await fs.readFile(audioPath);
    const audioBase64 = audioBuffer.toString('base64');

    const response = await axios.post(
      'https://vop.baidu.com/server_api',
      {
        format: 'pcm',
        rate: CONFIG.sampleRate,
        channel: 1,
        cuid: 'voice-assistant',
        speech: audioBase64,
        len: audioBuffer.length,
        dev_pid: 1537,
        token: accessToken
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      }
    );

    const data = response.data;

    if (data.err_no !== 0) {
      log(`ASR error: ${data.err_msg}`);
      return '';
    }

    if (data.result && data.result.length > 0) {
      return data.result[0];
    }

    return '';
  } catch (error: any) {
    log(`ASR error: ${error.message}`);
    return '';
  }
}

// ============== TTS ==============
/**
 * Speak text with interrupt support
 */
async function speak(text: string): Promise<void> {
  const tempFile = `/tmp/voice-assistant-tts-${Date.now()}.mp3`;
  
  // Generate TTS - use shell to properly handle errors
  try {
    await new Promise<void>((resolve, reject) => {
      const cmd = `npx node-edge-tts -t "${text}" -f "${tempFile}" -v "zh-CN-XiaoxiaoNeural"`;
      
      exec(cmd, { timeout: 30000 }, (error, stdout, stderr) => {
        if (error) {
          log(`TTS error: ${error.message}`);
          reject(error);
          return;
        }
        resolve();
      });
    });
  } catch (error: any) {
    log(`TTS failed: ${error.message}`);
    return;
  }
  
  // Check if file exists
  try {
    await fs.access(tempFile);
  } catch {
    log('TTS file not created, skipping');
    return;
  }
  
  // Play with mpv, allow interruption
  return new Promise((resolve) => {
    ttsProcess = spawn('mpv', [
      '--audio-device=pulse',
      '--no-terminal',
      tempFile
    ], {
      env: { ...process.env, PULSE_SERVER: CONFIG.pulseServer }
    });
    
    ttsProcess.on('close', async () => {
      ttsProcess = null;
      try { await fs.unlink(tempFile); } catch {}
      resolve();
    });
  });
}

/**
 * Interrupt current TTS playback
 */
function interruptTTS(): void {
  if (ttsProcess) {
    log("Interrupting TTS...");
    ttsProcess.kill('SIGTERM');
    ttsProcess = null;
    shouldInterrupt = true;
  }
}

// ============== OpenClaw API ==============
async function sendToOpenClaw(text: string): Promise<string> {
  return new Promise((resolve) => {
    // Use longer timeout and better error handling
    const cmd = `openclaw agent --local --agent main --message "${text}" --json`;
    log(`Sending to OpenClaw: ${text.substring(0, 20)}...`);
    
    exec(cmd, { timeout: 60000 }, (error, stdout, stderr) => {
      if (error) {
        log(`OpenClaw agent error: ${error.message}`);
        if (stderr) log(`stderr: ${stderr.substring(0, 200)}`);
        resolve('');
        return;
      }
      
      log(`OpenClaw raw response: ${stdout.substring(0, 200)}`);
      
      try {
        const json = JSON.parse(stdout);
        if (json.payloads && json.payloads.length > 0) {
          const reply = json.payloads[0].text || '';
          log(`OpenClaw response: ${reply.substring(0, 100)}...`);
          resolve(reply);
        } else {
          const reply = json.reply || json.message || json.content || '';
          log(`OpenClaw response (alt): ${reply.substring(0, 100)}...`);
          resolve(reply);
        }
      } catch (e) {
        log(`OpenClaw parse error: ${e}`);
        resolve(stdout);
      }
    });
  });
}

// ============== Main Loop ==============
async function listenForWakeWord(): Promise<void> {
  while (true) {
    try {
      await listenOnce();
    } catch (error: any) {
      log(`Error in listen loop: ${error.message}`);
      await new Promise(r => setTimeout(r, 1000));
    }
    
    if (state === "idle") {
      break;
    }
  }
}

async function listenOnce(): Promise<void> {
  logState("idle", "listening");
  state = "listening";
  
  log("Listening for wake word...");
  
  try {
    for await (const isSpeaking of monitorAudioLevel()) {
      if (state !== "listening") {
        await new Promise(r => setTimeout(r, 100));
        continue;
      }
      
      if (isSpeaking) {
        log("Voice detected, starting recording...");
        state = "recording";
        
        const audioPath = `/tmp/voice-assistant-${Date.now()}.wav`;
        await recordAudio(audioPath);
        
        state = "processing";
        log("Recognizing...");
        const text = await recognizeAudio(audioPath);
        
        try {
          await fs.unlink(audioPath);
        } catch {}
        
        if (text.includes(CONFIG.wakeWord)) {
          log(`Wake word "${CONFIG.wakeWord}" detected!`);
          await speak("我在");
          await startDialogue();
        } else {
          log(`Not wake word: ${text}`);
          state = "listening";
        }
      }
    }
  } catch (error: any) {
    log(`Error in listen loop: ${error.message}`);
    state = "idle";
  }
}

/**
 * Dialogue mode with background processing and interrupt support
 */
async function startDialogue(): Promise<void> {
  logState("listening", "recording");
  
  // Record user input
  const audioPath = `/tmp/voice-assistant-dialog-${Date.now()}.wav`;
  await recordAudio(audioPath, 10000);
  
  // Recognize
  state = "processing";
  const text = await recognizeAudio(audioPath);
  
  try {
    await fs.unlink(audioPath);
  } catch {}
  
  if (!text) {
    await speak("没听清楚，请再说一次");
    state = "listening";
    return;
  }
  
  log(`User said: ${text}`);
  
  // Send to OpenClaw in background and continue monitoring
  log("Sending to OpenClaw (background)...");
  const responsePromise = sendToOpenClaw(text);
  
  // Monitor for interruption while waiting for response
  state = "speaking";
  let responseReceived = false;
  
  // Poll for response OR interruption
  while (!responseReceived) {
    // Check if OpenClaw responded
    const raceResult = await Promise.race([
      responsePromise.then(value => ({ type: 'response' as const, value })),
      new Promise<{ type: 'interrupt' }>(resolve => {
        // Poll audio every 500ms
        const checkInterval = setInterval(() => {
          if (shouldInterrupt) {
            clearInterval(checkInterval);
            resolve({ type: 'interrupt' });
          }
          if (state === 'listening') {
            clearInterval(checkInterval);
            resolve({ type: 'interrupt' });
          }
        }, 500);
      })
    ]);
    
    if (raceResult.type === 'response') {
      responseReceived = true;
      const response = raceResult.value;
      log(`OpenClaw response: ${response}`);
      
      // Reset interrupt flag before playing
      shouldInterrupt = false;
      
      // Play TTS (can be interrupted)
      if (response) {
        await speak(response);
      } else {
        await speak("抱歉，我没有收到回复");
      }
    } else {
      // Interrupted by new speech
      log("Interrupted by new speech!");
      interruptTTS();
      
      // Start new dialogue
      await startDialogue();
      return;
    }
    
    // Check if we should restart listening
    if (state === 'speaking') {
      // Continue loop
    } else if (state === 'listening') {
      return;
    }
  }
  
  // Return to listening
  state = "listening";
}

// ============== Start ==============
async function main() {
  log("Voice Assistant starting...");
  
  const hasAudio = await isAudioAvailable();
  if (!hasAudio) {
    log("ERROR: Audio not available!");
    log("Make sure WSLg is running and PulseAudio is accessible");
    process.exit(1);
  }
  
  log("Audio available!");
  log(`Wake word: ${CONFIG.wakeWord}`);
  
  await listenForWakeWord();
}

main().catch(error => {
  log(`Fatal error: ${error.message}`);
  process.exit(1);
});
