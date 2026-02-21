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
type State = "idle" | "listening" | "recording" | "processing" | "speaking" | "dialogue";
let state: State = "idle";
let token: string | null = null;
let tokenExpireTime = 0;
let inDialogueMode = false;  // After first wake word, stay in dialogue mode
let lastSpeechTime = 0;

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
 * Record audio with VAD-based silence detection
 */
async function recordAudio(outputPath: string, maxDuration: number = CONFIG.maxRecordingTime): Promise<void> {
  log(`Starting recording: ${outputPath}, max: ${maxDuration}ms`);
  
  return new Promise((resolve, reject) => {
    // Start recording
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

    // Start volume monitor in parallel
    const monitorProc = spawn('ffmpeg', [
      '-f', 'pulse',
      '-i', 'default',
      '-af', 'volumedetect',
      '-f', 'null',
      '-'
    ], {
      env: { ...process.env, PULSE_SERVER: CONFIG.pulseServer }
    });

    let silenceStartTime = 0;
    let hasAudioRecently = false;
    
    // Monitor volume
    monitorProc.stderr.on('data', (data: Buffer) => {
      const text = data.toString();
      // Look for mean_volume in output
      const volMatch = text.match(/mean_volume:\s*([-\d.]+)\s*dB/);
      if (volMatch) {
        const volume = parseFloat(volMatch[1]);
        // -50dB is a good threshold for speech
        if (volume > -50) {
          hasAudioRecently = true;
          silenceStartTime = 0;
        } else if (hasAudioRecently) {
          if (silenceStartTime === 0) {
            silenceStartTime = Date.now();
          }
          // Auto-stop after 1 second of silence
          if (silenceStartTime > 0 && Date.now() - silenceStartTime > 1000) {
            log(`Silence detected (${volume}dB), stopping recording...`);
            proc.kill('SIGTERM');
            monitorProc.kill();
          }
        }
      }
    });
    
    proc.on('error', e => {
      log(`ffmpeg error: ${e.message}`);
      monitorProc.kill();
    });
    proc.on('close', () => {
      monitorProc.kill();
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
      // Clean text for TTS: remove newlines and special chars
      const cleanText = text.replace(/[\n\r]/g, ' ').replace(/"/g, '\\"').substring(0, 500);
      const cmd = `npx node-edge-tts -t "${cleanText}" -f "${tempFile}" -v "zh-CN-XiaoxiaoNeural"`;
      
      exec(cmd, { timeout: 30000 }, (error) => {
        if (error) {
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
    const cmd = `openclaw agent --local --agent main --message "${text}" --json`;
    log(`Sending to OpenClaw: ${text.substring(0, 20)}...`);
    
    exec(cmd, { timeout: 60000 }, (error, stdout, stderr) => {
      const output = stdout.trim();
      if (!output) {
        log(`OpenClaw error: ${error?.message || 'no output'}`);
        resolve('');
        return;
      }
      
      // Find JSON in output (skip plugin logs)
      const jsonMatch = output.match(/\{[\s\S]*"payloads"[\s\S]*\}/);
      if (!jsonMatch) {
        log(`No JSON found in response`);
        resolve('');
        return;
      }
      
      try {
        const json = JSON.parse(jsonMatch[0]);
        if (json.payloads && json.payloads.length > 0) {
          const reply = json.payloads[0].text || '';
          log(`OpenClaw response: ${reply.substring(0, 50)}...`);
          resolve(reply);
        } else {
          log(`No payloads in response`);
          resolve('');
        }
      } catch (e) {
        log(`OpenClaw parse error: ${e}`);
        resolve('');
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
  // If in dialogue mode, don't wait for wake word - just listen
  const waitingForWakeWord = !inDialogueMode;
  
  logState("idle", waitingForWakeWord ? "listening" : "dialogue");
  state = waitingForWakeWord ? "listening" : "dialogue";
  
  log(waitingForWakeWord ? "Listening for wake word..." : "Listening in dialogue mode...");
  
  try {
    for await (const isSpeaking of monitorAudioLevel()) {
      // Update last speech time
      if (isSpeaking) {
        lastSpeechTime = Date.now();
      }
      
      // Check for silence timeout - return to wake word listening
      if (inDialogueMode && lastSpeechTime > 0 && Date.now() - lastSpeechTime > 10000) {
        log("Silence timeout, returning to wake word mode");
        inDialogueMode = false;
        state = "listening";
        return;
      }
      
      if (state !== "listening" && state !== "dialogue") {
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
        
        // Check for wake word only if not in dialogue mode
        if (waitingForWakeWord && text.includes(CONFIG.wakeWord)) {
          log(`Wake word "${CONFIG.wakeWord}" detected!`);
          inDialogueMode = true;  // Enter dialogue mode
          await speak("我在");
          await startDialogue();
        } else if (!waitingForWakeWord) {
          // In dialogue mode, just process the input
          log(`Dialogue input: ${text}`);
          await processDialogueInput(text);
        } else {
          log(`Not wake word: ${text}`);
          state = waitingForWakeWord ? "listening" : "dialogue";
        }
      }
    }
  } catch (error: any) {
    log(`Error in listen loop: ${error.message}`);
    state = "idle";
  }
}

/**
 * Process dialogue input without wake word check
 */
async function processDialogueInput(text: string): Promise<void> {
  if (!text) {
    await speak("没听清楚，请再说一次");
    return;
  }
  
  log(`User said: ${text}`);
  lastSpeechTime = Date.now();  // Reset silence timer
  
  // Send to OpenClaw
  log("Sending to OpenClaw...");
  const response = await sendToOpenClaw(text);
  log(`OpenClaw response: ${response}`);
  lastSpeechTime = Date.now();  // Reset after response
  
  // Play TTS
  if (response) {
    await speak(response);
  } else {
    await speak("抱歉，我没有收到回复");
  }
}

/**
 * Dialogue mode - loops until silence timeout
 */
async function startDialogue(): Promise<void> {
  // Stay in dialogue loop until silence timeout
  while (inDialogueMode) {
    // Check silence timeout
    if (lastSpeechTime > 0 && Date.now() - lastSpeechTime > 10000) {
      log("Silence timeout, exiting dialogue mode");
      inDialogueMode = false;
      break;
    }
    
    logState("dialogue", "recording");
    state = "recording";
    
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
      // No speech detected, check if we should continue
      if (Date.now() - lastSpeechTime > 10000) {
        inDialogueMode = false;
      }
      continue;
    }
    
    lastSpeechTime = Date.now();
    log(`User said: ${text}`);
    
    // Send to OpenClaw
    log("Sending to OpenClaw...");
    const response = await sendToOpenClaw(text);
    log(`OpenClaw response: ${response}`);
    lastSpeechTime = Date.now();
    
    // Play TTS
    if (response) {
      await speak(response);
    } else {
      await speak("抱歉，我没有收到回复");
    }
    
    // Check silence after TTS
    if (Date.now() - lastSpeechTime > 10000) {
      inDialogueMode = false;
    }
  }
  
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
