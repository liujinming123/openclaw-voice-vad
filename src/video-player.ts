import { EventEmitter } from "node:events";
import { spawn, ChildProcess } from "node:child_process";

export interface VideoPlayerOptions {
  idleVideo?: string;
  speakingVideo?: string;
  enabled?: boolean;
}

export class VideoPlayer extends EventEmitter {
  private idleVideo: string;
  private speakingVideo: string;
  private enabled: boolean;
  private currentProcess: ChildProcess | null = null;
  private currentVideo: "idle" | "speaking" | null = null;

  constructor(options: VideoPlayerOptions = {}) {
    super();
    this.idleVideo = options.idleVideo || "/path/to/idle.mp4";
    this.speakingVideo = options.speakingVideo || "/path/to/speaking.mp4";
    this.enabled = options.enabled !== undefined ? options.enabled : true;
  }

  private log(...args: any[]): void {
    console.log(`[${new Date().toISOString()}] [VideoPlayer]`, ...args);
  }

  private stopCurrentVideo(): void {
    if (this.currentProcess) {
      this.log("Stopping current video");
      this.currentProcess.kill();
      this.currentProcess = null;
      this.currentVideo = null;
    }
  }

  private playVideo(videoPath: string, type: "idle" | "speaking"): void {
    if (!this.enabled) {
      this.log("Video player is disabled, skipping video playback");
      return;
    }

    if (this.currentVideo === type) {
      this.log(`Already playing ${type} video`);
      return;
    }

    this.stopCurrentVideo();

    try {
      this.log(`Playing ${type} video: ${videoPath}`);
      
      const playerProcess = spawn("mpv", [
        videoPath,
        "--loop=inf",
        "--no-audio",
        "--really-quiet",
        "--no-osc",
        "--no-border"
      ], {
        stdio: ["ignore", "ignore", "ignore"]
      });

      this.currentProcess = playerProcess;
      this.currentVideo = type;

      playerProcess.on("error", (err) => {
        this.log(`Error playing ${type} video:`, err.message);
        this.emit("error", err);
      });

      playerProcess.on("close", (code) => {
        if (this.currentProcess === playerProcess) {
          this.log(`${type} video process closed with code: ${code}`);
          this.currentProcess = null;
          this.currentVideo = null;
        }
      });

      this.emit("videoChanged", type);
    } catch (error: any) {
      this.log(`Failed to play ${type} video:`, error.message);
      this.emit("error", error);
    }
  }

  playIdle(): void {
    this.playVideo(this.idleVideo, "idle");
  }

  playSpeaking(): void {
    this.playVideo(this.speakingVideo, "speaking");
  }

  stop(): void {
    this.stopCurrentVideo();
    this.emit("stopped");
  }

  enable(): void {
    if (!this.enabled) {
      this.enabled = true;
      this.log("Video player enabled");
      this.emit("enabled");
    }
  }

  disable(): void {
    if (this.enabled) {
      this.enabled = false;
      this.stopCurrentVideo();
      this.log("Video player disabled");
      this.emit("disabled");
    }
  }

  toggle(): boolean {
    if (this.enabled) {
      this.disable();
      return false;
    } else {
      this.enable();
      return true;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setIdleVideo(path: string): void {
    this.idleVideo = path;
    if (this.currentVideo === "idle" && this.enabled) {
      this.playIdle();
    }
  }

  setSpeakingVideo(path: string): void {
    this.speakingVideo = path;
    if (this.currentVideo === "speaking" && this.enabled) {
      this.playSpeaking();
    }
  }

  getCurrentVideo(): "idle" | "speaking" | null {
    return this.currentVideo;
  }
}
