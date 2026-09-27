// Export presets for `ae export`: what the final file should be, and the ffmpeg arguments that make it from the
// master AE renders (ProRes 422 HQ / Lossless, or with alpha for the alpha presets).

export interface Preset {
  name: string;
  aliases?: string[];
  use: string; // what it is for, shown by `ae export --list`
  ext: string;
  width?: number; // fixed output size (letterboxed or cropped to fit)
  height?: number;
  maxWidth?: number; // scale down to this width, never up
  alpha?: boolean; // keeps transparency: AE renders a master with alpha
  fps?: number;
  gif?: boolean;
  video: string[];
  audio: string[] | null; // null: the format has no audio
  container?: string[];
}

const H264 = ["-c:v", "libx264", "-preset", "slow", "-crf", "18", "-profile:v", "high", "-pix_fmt", "yuv420p"];
const AAC = ["-c:a", "aac", "-b:a", "320k", "-ar", "48000"];
const FASTSTART = ["-movflags", "+faststart"];

export const PRESETS: Preset[] = [
  { name: "youtube-1080", use: "YouTube / Vimeo, Full HD", ext: "mp4", width: 1920, height: 1080, video: H264, audio: AAC, container: FASTSTART },
  { name: "youtube-4k", use: "YouTube / Vimeo, 4K UHD", ext: "mp4", width: 3840, height: 2160, video: H264, audio: AAC, container: FASTSTART },
  { name: "shorts", aliases: ["reels", "tiktok"], use: "YouTube Shorts, Instagram Reels, TikTok (vertical 9:16)", ext: "mp4", width: 1080, height: 1920, video: H264, audio: AAC, container: FASTSTART },
  { name: "square", use: "Instagram / social feed, 1:1", ext: "mp4", width: 1080, height: 1080, video: H264, audio: AAC, container: FASTSTART },
  {
    name: "web",
    use: "small H.264 for sites, docs, chats (at most 1280 wide)",
    ext: "mp4",
    maxWidth: 1280,
    video: ["-c:v", "libx264", "-preset", "slow", "-crf", "23", "-profile:v", "high", "-pix_fmt", "yuv420p"],
    audio: ["-c:a", "aac", "-b:a", "192k", "-ar", "48000"],
    container: FASTSTART,
  },
  {
    name: "prores",
    use: "master for editing / delivery: ProRes 422 HQ at comp size",
    ext: "mov",
    video: ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le", "-vendor", "apl0"],
    audio: ["-c:a", "pcm_s16le"],
  },
  {
    name: "prores-alpha",
    use: "master with transparency: ProRes 4444 + alpha at comp size",
    ext: "mov",
    alpha: true,
    video: ["-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le", "-alpha_bits", "16", "-vendor", "apl0"],
    audio: ["-c:a", "pcm_s16le"],
  },
  {
    name: "webm-alpha",
    use: "transparent video for web / UI: VP9 + alpha",
    ext: "webm",
    alpha: true,
    video: ["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-crf", "30", "-b:v", "0", "-row-mt", "1"],
    audio: ["-c:a", "libopus", "-b:a", "128k"],
  },
  { name: "gif", use: "animated GIF, 15 fps, at most 640 wide", ext: "gif", maxWidth: 640, fps: 15, gif: true, video: [], audio: null },
];

export function findPreset(name: string): Preset | undefined {
  const n = name.toLowerCase();
  return PRESETS.find((p) => p.name === n || p.aliases?.includes(n));
}

/** Every name the CLI accepts for --preset, aliases included. */
export function presetNames(): string[] {
  return PRESETS.flatMap((p) => [p.name, ...(p.aliases ?? [])]);
}

export function listPresets(): string {
  const w = Math.max(...PRESETS.map((p) => p.name.length));
  return PRESETS.map((p) => {
    const size = p.width ? `${p.width}x${p.height}` : p.maxWidth ? `<=${p.maxWidth}w` : "comp size";
    const also = p.aliases ? `  (also: ${p.aliases.join(", ")})` : "";
    return `${p.name.padEnd(w)}  ${size.padEnd(9)}  .${p.ext.padEnd(4)}  ${p.use}${also}`;
  }).join("\n");
}

export type Fit = "pad" | "crop";

/** The input and the preset's fixed size have different aspect ratios (pad letterboxes, crop cuts). */
export function aspectMismatch(p: Preset, inW: number, inH: number): boolean {
  if (!p.width || !p.height) return false;
  return Math.abs(inW / inH - p.width / p.height) > 0.005;
}

/** The -vf filter graph that turns an inW x inH master into the preset's frame. */
export function videoFilter(p: Preset, inW: number, inH: number, fit: Fit): string {
  const f: string[] = [];
  if (p.fps) f.push(`fps=${p.fps}`);
  if (p.width && p.height) {
    const W = p.width;
    const H = p.height;
    if (!aspectMismatch(p, inW, inH)) f.push(`scale=${W}:${H}:flags=lanczos`);
    else if (fit === "crop") f.push(`scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos`, `crop=${W}:${H}`);
    else f.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos`, `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`);
  } else if (p.maxWidth && inW > p.maxWidth) {
    f.push(`scale=${p.maxWidth}:-2:flags=lanczos`);
  } else {
    f.push("scale=trunc(iw/2)*2:trunc(ih/2)*2"); // 4:2:0 and ProRes 422 need even sizes
  }
  f.push("setsar=1");
  if (p.gif) return f.join(",") + ",split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5";
  return f.join(",");
}

export interface EncodeInput {
  inW: number;
  inH: number;
  fit: Fit;
  hasAudio: boolean;
  stats?: boolean; // ffmpeg progress on stderr
}

/** Full ffmpeg argument list: master `input` -> preset file `output`. */
export function ffmpegArgs(p: Preset, input: string, output: string, o: EncodeInput): string[] {
  const audio = o.hasAudio && p.audio ? p.audio : ["-an"];
  return [
    "-v", "error", ...(o.stats ? ["-stats"] : []), "-y",
    "-i", input,
    "-vf", videoFilter(p, o.inW, o.inH, o.fit),
    ...p.video,
    ...audio,
    ...(p.container ?? []),
    output,
  ];
}
