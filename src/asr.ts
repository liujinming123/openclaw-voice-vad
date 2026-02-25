/**
 * Baidu ASR Integration for Pipeline
 * 
 * Handles:
 * 1. Wake word detection
 * 2. Speech recognition
 */

import axios from "axios";
import fs from "node:fs/promises";

export interface BaiduASRConfig {
  appId: string;
  apiKey: string;
  secretKey: string;
}

export class BaiduASR {
  private config: BaiduASRConfig;
  private token: string = "";
  private tokenExpireTime: number = 0;

  constructor(config: BaiduASRConfig) {
    this.config = config;
  }

  /**
   * Get access token (with caching)
   */
  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && now < this.tokenExpireTime) {
      return this.token;
    }

    const url = "https://aip.baidubce.com/oauth/2.0/token";
    const params = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.config.apiKey,
      client_secret: this.config.secretKey,
    });

    const response = await axios.post(url, params.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    this.token = response.data.access_token;
    this.tokenExpireTime = now + (response.data.expires_in - 600) * 1000;
    return this.token;
  }

  /**
   * Recognize audio file
   */
  async recognize(audioPath: string): Promise<string> {
    const accessToken = await this.getAccessToken();
    const audioBuffer = await fs.readFile(audioPath);
    const audioBase64 = audioBuffer.toString("base64");

    const response = await axios.post(
      "https://vop.baidu.com/server_api",
      {
        format: "pcm",
        rate: 16000,
        channel: 1,
        cuid: "openclaw_pipeline",
        speech: audioBase64,
        len: audioBuffer.length,
        dev_pid: 1537, // Mandarin Chinese
        token: accessToken,
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    const data = response.data;

    if (data.err_no !== 0) {
      throw new Error(`ASR error: ${data.err_msg}`);
    }

    if (data.result && data.result.length > 0) {
      return data.result[0];
    }

    return "";
  }

  /**
   * Check if text contains wake word
   */
  containsWakeWord(text: string, wakeWord: string = "你好"): boolean {
    return text.includes(wakeWord);
  }

  /**
   * Extract command after wake word
   */
  extractCommand(text: string, wakeWord: string = "你好"): string {
    const index = text.indexOf(wakeWord);
    if (index >= 0) {
      return text.substring(index + wakeWord.length).trim();
    }
    return text.trim();
  }
}
