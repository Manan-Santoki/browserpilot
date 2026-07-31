"use client";

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const MIC_PROCESSOR = `
class BrowserPilotMicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.frameSamples = 320;
    this.ratio = sampleRate / this.targetRate;
    this.position = 0;
    this.pending = [];
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;

    while (this.position < input.length) {
      const left = Math.floor(this.position);
      const right = Math.min(input.length - 1, left + 1);
      const fraction = this.position - left;
      const sample = input[left] + (input[right] - input[left]) * fraction;
      const clipped = Math.max(-1, Math.min(1, sample));
      this.pending.push(clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff);
      this.position += this.ratio;

      if (this.pending.length === this.frameSamples) {
        const frame = new Int16Array(this.pending);
        this.port.postMessage(frame.buffer, [frame.buffer]);
        this.pending = [];
      }
    }
    this.position -= input.length;
    return true;
  }
}
registerProcessor("browserpilot-mic", BrowserPilotMicProcessor);
`;

/** Browser microphone capture plus interruptible 24 kHz PCM playback. */
export class WebLiveAudio {
  private stream: MediaStream | undefined;
  private captureContext: AudioContext | undefined;
  private playbackContext: AudioContext | undefined;
  private captureNode: AudioWorkletNode | undefined;
  private playing = new Set<AudioBufferSourceNode>();
  private nextPlaybackAt = 0;
  private workletUrl: string | undefined;

  async start(onPcmFrame: (base64: string) => void): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.captureContext = new AudioContext({ latencyHint: "interactive" });
    this.playbackContext = new AudioContext({
      latencyHint: "interactive",
      sampleRate: 24_000,
    });
    this.workletUrl = URL.createObjectURL(
      new Blob([MIC_PROCESSOR], { type: "text/javascript" }),
    );
    await this.captureContext.audioWorklet.addModule(this.workletUrl);

    const source = this.captureContext.createMediaStreamSource(this.stream);
    const captureNode = new AudioWorkletNode(this.captureContext, "browserpilot-mic");
    // A zero-gain branch keeps the processor in the rendering graph without
    // feeding microphone audio back through the speakers.
    const silent = this.captureContext.createGain();
    silent.gain.value = 0;
    source.connect(captureNode).connect(silent).connect(this.captureContext.destination);
    captureNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      onPcmFrame(arrayBufferToBase64(event.data));
    };
    this.captureNode = captureNode;
    await Promise.all([this.captureContext.resume(), this.playbackContext.resume()]);
  }

  enqueue(base64Pcm: string): void {
    const context = this.playbackContext;
    if (!context) return;
    const bytes = base64ToBytes(base64Pcm);
    const sampleCount = Math.floor(bytes.byteLength / 2);
    const samples = new Float32Array(sampleCount);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < sampleCount; i += 1) {
      const value = view.getInt16(i * 2, true);
      samples[i] = value < 0 ? value / 0x8000 : value / 0x7fff;
    }

    const buffer = context.createBuffer(1, sampleCount, 24_000);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.onended = () => this.playing.delete(source);
    this.playing.add(source);

    const now = context.currentTime;
    this.nextPlaybackAt = Math.max(this.nextPlaybackAt, now + 0.06);
    source.start(this.nextPlaybackAt);
    this.nextPlaybackAt += buffer.duration;
  }

  clearPlayback(): void {
    for (const source of this.playing) {
      try {
        source.stop();
      } catch {
        // It may have ended between iteration and stop().
      }
    }
    this.playing.clear();
    this.nextPlaybackAt = this.playbackContext?.currentTime ?? 0;
  }

  async stop(): Promise<void> {
    this.clearPlayback();
    this.captureNode?.disconnect();
    this.captureNode = undefined;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    await Promise.all([
      this.captureContext?.close().catch(() => {}),
      this.playbackContext?.close().catch(() => {}),
    ]);
    this.captureContext = undefined;
    this.playbackContext = undefined;
    if (this.workletUrl) URL.revokeObjectURL(this.workletUrl);
    this.workletUrl = undefined;
  }
}
