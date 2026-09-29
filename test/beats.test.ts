// ae beats without AE: onset detection on a generated click track, the frame mapping, CLI errors.
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { decodeMono, onsets, tempo } from "../src/audio.ts";
import { analyse } from "../src/commands/beats.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const ae = (args: string[]) => {
  const r = spawnSync(path.join(ROOT, "ae"), args, { encoding: "utf8", env: { ...process.env, AE_APP: "No Such After Effects 2099" } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const frames = (out: string) => out.trim().split("\n").map((l) => Number(l.trim().split(/\s+/)[0]));
const dir = mkdtempSync(path.join(os.tmpdir(), "aectl-beats-"));
const clicks = path.join(dir, "clicks.wav"); // a click every 0.4 s from 0 to 3.6, over a quiet hum

beforeAll(() => {
  const expr = "0.8*sin(2*PI*1500*t)*exp(-60*mod(t,0.4))*lt(mod(t,0.4),0.1)+0.02*sin(2*PI*220*t)";
  expect(spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `aevalsrc='${expr}':d=4:s=44100`, clicks]).status).toBe(0);
});

describe("onsets", () => {
  it("finds every click within a few ms, including the one at 0", () => {
    const t = onsets(decodeMono(clicks)).map((o) => o.t);
    expect(t).toHaveLength(10);
    t.forEach((v, i) => expect(Math.abs(v - i * 0.4)).toBeLessThan(0.005));
  });

  it("estimates the tempo (a click every 0.4 s = 150 BPM), in comp time for a stretched layer", () => {
    expect(Math.abs(tempo(decodeMono(clicks)) - 150)).toBeLessThan(1.5);
    const res = analyse({ file: clicks, fps: 25, start: 1, stretch: 2, inF: 25, outF: 25 + 200 }, {});
    expect(Math.abs(res.bpm - 75)).toBeLessThan(1);
  });

  it("maps source time to comp frames through start and stretch", () => {
    const res = analyse({ file: clicks, fps: 25, start: 1, stretch: 2, inF: 25, outF: 25 + 200 }, {});
    expect(res.hits.map((h) => h.frame)).toEqual([25, 45, 65, 85, 105, 125, 145, 165, 185, 205]);
  });
});

describe("ae beats file.wav", () => {
  it("prints onsets in comp frames from --offset", () => {
    const r = ae(["beats", clicks, "--fps", "25", "--offset", "5"]);
    expect(r.code).toBe(0);
    expect(frames(r.out)).toEqual([5, 15, 25, 35, 45, 55, 65, 75, 85, 95]);
    expect(r.err).toContain("10 onsets");
    expect(r.err).toMatch(/tempo ~1(49|50|51)(\.\d)? BPM, a beat every 10(\.\d+)? frames/);
  });

  it("--from/--to limit the range, --top keeps the strongest (in frame order)", () => {
    expect(frames(ae(["beats", clicks, "--offset", "5", "--from", "30", "--to", "60"]).out)).toEqual([35, 45, 55]);
    const top = frames(ae(["beats", clicks, "--top", "3"]).out);
    expect(top).toHaveLength(3);
    expect([...top].sort((a, b) => a - b)).toEqual(top);
  });

  it("--env adds loudness per frame", () => {
    const r = ae(["beats", clicks, "--from", "0", "--to", "5", "--env"]);
    expect(r.out).toContain("frame  dBFS  loudness");
  });

  it.each([
    [["beats"], "usage: ae beats"],
    [["beats", "/nope.wav"], "no such file '/nope.wav'"],
    [["beats", "x.wav", "--threshold", "2"], "--threshold must be between 0 and 1"],
    [["beats", "Main", "--layer", "Music", "--fps", "30"], "--fps/--offset are for a file"],
  ])("ae %j -> exit 2", (args, msg) => {
    const r = ae(args);
    expect(r.code).toBe(2);
    expect(r.err).toContain(msg);
  });

  it("a layer needs AE (exit 3 when it is not running)", () => {
    expect(ae(["beats", "Main", "--layer", "Music"]).code).toBe(3);
  });
});
