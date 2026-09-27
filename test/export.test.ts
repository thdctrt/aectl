// ae export without AE: presets, ffmpeg arguments, real encodes from a generated master, CLI argument errors.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { describe as describeFile, encode } from "../src/commands/export.ts";
import { probeVideo } from "../src/media.ts";
import { aspectMismatch, ffmpegArgs, findPreset, listPresets, presetNames, PRESETS, videoFilter, type Preset } from "../src/presets.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const preset = (name: string): Preset => findPreset(name)!;
const ae = (args: string[], cwd = ROOT) => {
  const r = spawnSync(path.join(ROOT, "ae"), args, { encoding: "utf8", cwd, env: { ...process.env, AE_APP: "No Such After Effects 2099" } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const ffmpeg = (args: string[]) => spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { encoding: "utf8" });
const hasEncoder = (name: string) => spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout.includes(" " + name + " ");

describe("presets", () => {
  it("finds presets by name and alias, case-insensitively", () => {
    expect(findPreset("youtube-1080")?.width).toBe(1920);
    expect(findPreset("Reels")?.name).toBe("shorts");
    expect(findPreset("tiktok")?.name).toBe("shorts");
    expect(findPreset("nope")).toBeUndefined();
  });

  it("lists every preset once", () => {
    const list = listPresets().split("\n");
    expect(list).toHaveLength(PRESETS.length);
    for (const p of PRESETS) expect(list.some((l) => l.startsWith(p.name + " "))).toBe(true);
  });

  it("scales straight to the preset size when the aspect matches", () => {
    expect(videoFilter(preset("youtube-1080"), 3840, 2160, "pad")).toBe("scale=1920:1080:flags=lanczos,setsar=1");
  });

  it("letterboxes (pad) or fills (crop) when the aspect differs", () => {
    const shorts = preset("shorts");
    expect(aspectMismatch(shorts, 1920, 1080)).toBe(true);
    expect(videoFilter(shorts, 1920, 1080, "pad")).toContain("force_original_aspect_ratio=decrease");
    expect(videoFilter(shorts, 1920, 1080, "pad")).toContain("pad=1080:1920");
    expect(videoFilter(shorts, 1920, 1080, "crop")).toContain("crop=1080:1920");
  });

  it("scales down to maxWidth but never up", () => {
    expect(videoFilter(preset("web"), 1920, 1080, "pad")).toContain("scale=1280:-2");
    expect(videoFilter(preset("web"), 640, 360, "pad")).toContain("scale=trunc(iw/2)*2:trunc(ih/2)*2");
  });

  it("keeps comp size (made even) for masters", () => {
    expect(videoFilter(preset("prores"), 1921, 1081, "pad")).toBe("scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1");
  });

  it("builds a GIF palette in the filter graph", () => {
    expect(videoFilter(preset("gif"), 1920, 1080, "pad")).toMatch(/^fps=15,scale=640:-2.*palettegen.*paletteuse/);
  });

  it("drops audio when the master has none or the format cannot hold it", () => {
    const args = (p: string, hasAudio: boolean) => ffmpegArgs(preset(p), "in.mov", "out", { inW: 1920, inH: 1080, fit: "pad", hasAudio });
    expect(args("youtube-1080", true)).toContain("aac");
    expect(args("youtube-1080", false)).toContain("-an");
    expect(args("gif", true)).toContain("-an");
  });

  it("the zsh completion offers exactly the preset names", () => {
    const m = /--preset\[[^\]]*\]:preset:\(([^)]*)\)/.exec(readFileSync(path.join(ROOT, "completions/_ae"), "utf8"));
    expect(m?.[1].split(" ").sort()).toEqual(presetNames().sort());
  });
});

describe("encode from a master (real ffmpeg)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aectl-export-"));
  const master = path.join(dir, "master.mov"); // 1920x1080 ProRes 422 HQ with audio, like AE's master
  const masterAlpha = path.join(dir, "master_alpha.mov"); // 640x360 ProRes 4444 with alpha

  beforeAll(() => {
    expect(
      ffmpeg([
        "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=25:duration=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
        "-c:v", "prores_ks", "-profile:v", "3", "-c:a", "pcm_s16le", "-shortest", master,
      ]).status,
    ).toBe(0);
    expect(
      ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=1,format=yuva444p10le", "-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le", masterAlpha]).status,
    ).toBe(0);
  });

  const cases: [string, string, number, number, RegExp][] = [
    ["youtube-1080", master, 1920, 1080, /^yuv420p$/],
    ["shorts", master, 1080, 1920, /^yuv420p$/],
    ["square", master, 1080, 1080, /^yuv420p$/],
    ["web", master, 1280, 720, /^yuv420p$/],
    ["prores", master, 1920, 1080, /^yuv422p10/],
    ["prores-alpha", masterAlpha, 640, 360, /^yuva444p/],
    ["webm-alpha", masterAlpha, 640, 360, /^yuv(a)?420p$/], // VP9 keeps alpha in side data, so ffprobe may report plain yuv420p
    ["gif", master, 640, 360, /^(pal8|bgra)$/],
  ];
  it.each(cases)("%s", (name, input, w, h, pix) => {
    const p = preset(name);
    if (p.video.includes("libx264") && !hasEncoder("libx264")) return;
    if (p.video.includes("libvpx-vp9") && !hasEncoder("libvpx-vp9")) return;
    const outFile = path.join(dir, `out_${name}.${p.ext}`);
    expect(encode(p, input, outFile, "pad")).toBe(0);
    const v = probeVideo(outFile);
    expect([Number(v.width), Number(v.height)]).toEqual([w, h]);
    expect(v.pixFmt).toMatch(pix);
    expect(Number(v.duration)).toBeGreaterThan(0.5);
    expect(describeFile(outFile)).toContain(`${w}x${h}`);
  });

  it("keeps the audio for YouTube", () => {
    const outFile = path.join(dir, "audio.mp4");
    if (!hasEncoder("libx264")) return;
    expect(encode(preset("youtube-1080"), master, outFile, "pad")).toBe(0);
    expect(describeFile(outFile)).toContain("audio=yes");
  });
});

describe("ae export arguments", () => {
  it("--list prints the presets", () => {
    const r = ae(["export", "--list"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("youtube-1080");
    expect(r.out).toContain("prores-alpha");
  });

  it.each([
    [["export"], "usage: ae export"],
    [["export", "Main", "--preset", "vhs"], "unknown preset 'vhs'"],
    [["export", "Main", "--fit", "stretch"], "--fit must be pad or crop"],
    [["export", "Main", "--full", "--from", "1"], "--full and --from/--to exclude each other"],
    [["export", "Main", "--from", "x"], "--from must be a comp frame number"],
    [["export", "Main", "--wait"], "--wait only goes with --ame"],
  ])("ae %j -> exit 2", (args, msg) => {
    const r = ae(args);
    expect(r.code).toBe(2);
    expect(r.err).toContain(msg);
  });

  it("refuses to overwrite without --force", () => {
    const d = mkdtempSync(path.join(os.tmpdir(), "aectl-"));
    writeFileSync(path.join(d, "Main_youtube-1080.mp4"), "x");
    const r = ae(["export", "Main"], d);
    expect(r.code).toBe(2);
    expect(r.err).toContain("add --force");
  });

  it("reports a missing AE with exit 3", () => {
    const d = mkdtempSync(path.join(os.tmpdir(), "aectl-"));
    const r = ae(["export", "Main", "--out", path.join(d, "x.mp4")]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("is not running");
  });
});
