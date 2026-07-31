import type {
  AudioBufferQueueSourceNode,
  AudioContext,
  AudioRecorder,
} from "react-native-audio-api";

function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const packed = (a << 16) | (b << 8) | c;
    result += alphabet[(packed >> 18) & 63];
    result += alphabet[(packed >> 12) & 63];
    result += i + 1 < bytes.length ? alphabet[(packed >> 6) & 63] : "=";
    result += i + 2 < bytes.length ? alphabet[packed & 63] : "=";
  }
  return result;
}

function pcm16Base64(samples: Float32Array, inputRate: number): string {
  const outputLength = Math.max(1, Math.round((samples.length * 16_000) / inputRate));
  const bytes = new Uint8Array(outputLength * 2);
  const view = new DataView(bytes.buffer);
  const ratio = inputRate / 16_000;
  for (let i = 0; i < outputLength; i += 1) {
    const position = i * ratio;
    const left = Math.min(samples.length - 1, Math.floor(position));
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = position - left;
    const value = samples[left]! + (samples[right]! - samples[left]!) * fraction;
    const clipped = Math.max(-1, Math.min(1, value));
    const integer = Math.round(clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff);
    view.setInt16(i * 2, integer, true);
  }
  return bytesToBase64(bytes);
}

/**
 * Native foreground-only duplex audio.
 *
 * Imported dynamically so Expo Go can show an actionable error instead of
 * crashing when its binary does not contain the custom native module.
 */
export class MobileLiveAudio {
  private recorder: AudioRecorder | null = null;
  private context: AudioContext | null = null;
  private queue: AudioBufferQueueSourceNode | null = null;
  private playbackChain = Promise.resolve();
  private audioManager:
    | (typeof import("react-native-audio-api"))["AudioManager"]
    | null = null;

  async start(onPcmFrame: (base64: string) => void): Promise<void> {
    let audio: typeof import("react-native-audio-api");
    try {
      audio = await import("react-native-audio-api");
    } catch {
      throw new Error("Live Voice requires the installed BrowserPilot APK, not Expo Go.");
    }

    const permission = await audio.AudioManager.requestRecordingPermissions();
    if (permission !== "Granted") throw new Error("Microphone permission is required.");

    audio.AudioManager.setAudioSessionOptions({
      iosCategory: "playAndRecord",
      iosMode: "voiceChat",
      iosOptions: ["defaultToSpeaker", "allowBluetoothHFP"],
      iosNotifyOthersOnDeactivation: true,
    });
    await audio.AudioManager.setAudioSessionActivity(true);
    this.audioManager = audio.AudioManager;

    try {
      const context = new audio.AudioContext({ sampleRate: 24_000 });
      await context.resume();
      this.context = context;
      this.createQueue();

      const recorder = new audio.AudioRecorder();
      recorder.onAudioReady(
        { sampleRate: 16_000, bufferLength: 320, channelCount: 1 },
        ({ buffer }) => {
          onPcmFrame(pcm16Base64(buffer.getChannelData(0), buffer.sampleRate));
        },
      );
      recorder.onError((event) => {
        console.warn("Live Voice recorder error", event.message);
      });
      const result = await recorder.start();
      if (result.status === "error") throw new Error(result.message);
      this.recorder = recorder;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  private createQueue(): void {
    const context = this.context;
    if (!context) return;
    const queue = context.createBufferQueueSource({ pitchCorrection: false });
    queue.connect(context.destination);
    queue.start();
    this.queue = queue;
  }

  enqueue(base64Pcm: string): void {
    this.playbackChain = this.playbackChain.then(async () => {
      const context = this.context;
      const queue = this.queue;
      if (!context || !queue) return;
      const buffer = await context.decodePCMInBase64(base64Pcm, 24_000, 1, true);
      if (queue === this.queue) queue.enqueueBuffer(buffer);
    });
  }

  clearPlayback(): void {
    try {
      this.queue?.stop();
    } catch {
      // Already stopped by the native audio engine.
    }
    this.queue = null;
    this.playbackChain = Promise.resolve();
    this.createQueue();
  }

  async stop(): Promise<void> {
    const recorder = this.recorder;
    this.recorder = null;
    if (recorder) {
      recorder.clearOnAudioReady();
      recorder.clearOnError();
      if (recorder.isRecording()) await recorder.stop().catch(() => {});
    }
    try {
      this.queue?.stop();
    } catch {
      // Already stopped.
    }
    this.queue = null;
    await this.context?.close().catch(() => {});
    this.context = null;
    await this.audioManager?.setAudioSessionActivity(false).catch(() => {});
    this.audioManager = null;
  }
}
