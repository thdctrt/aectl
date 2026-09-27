// ae measure and the crop maths behind ae snap --crop (no AE needed; images made with ffmpeg).
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { cropFilter, measureInk, readRgba } from "../src/media.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const ae = (args: string[]) => {
  const r = spawnSync(path.join(ROOT, "ae"), args, { encoding: "utf8", env: { ...process.env, AE_APP: "No Such After Effects 2099" } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const dir = mkdtempSync(path.join(os.tmpdir(), "aectl-measure-"));
const img = (name: string, src: string) => {
  const f = path.join(dir, name);
  expect(spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", src, "-frames:v", "1", f]).status).toBe(0);
  return f;
};
let white: string, half: string, alpha: string;

beforeAll(() => {
  // a red 40x30 box at (50,20) on white, the same at half size, and on a transparent background
  white = img("white.png", "color=c=white:s=200x100,format=rgba,drawbox=x=50:y=20:w=40:h=30:color=red:t=fill");
  half = img("half.png", "color=c=white:s=100x50,format=rgba,drawbox=x=26:y=10:w=20:h=15:color=red:t=fill");
  alpha = img("alpha.png", "color=c=black:s=200x100,format=rgba,colorchannelmixer=aa=0,drawbox=x=10:y=10:w=20:h=20:color=blue:t=fill:replace=1");
});

describe("measureInk", () => {
  it("finds the box on an opaque background (corner colour)", () => {
    expect(measureInk(readRgba(white))).toMatchObject({ x0: 50, y0: 20, x1: 89, y1: 49, count: 1200, bg: "#FFFFFF" });
  });

  it("uses alpha when the image has transparency", () => {
    expect(measureInk(readRgba(alpha))).toMatchObject({ x0: 10, y0: 10, x1: 29, y1: 29, bg: "transparent" });
  });

  it("limits the search to a box and reports no ink outside", () => {
    expect(measureInk(readRgba(white), { box: [0, 0, 40, 100] })).toBeNull();
    expect(measureInk(readRgba(white), { box: [60, 0, 140, 100] })).toMatchObject({ x0: 60, x1: 89 });
  });
});

describe("ae measure", () => {
  it("prints the box, centre and mean colour", () => {
    const r = ae(["measure", white]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(": ink 50,20..89,49  40x30  centre 70,35  mean #FF0000");
  });

  it("compares two images in the first one's pixels", () => {
    const r = ae(["measure", white, half]);
    expect(r.out).toContain("delta b-a (b scaled x2 to a's pixels): centre +2,+0  size +0x+0");
  });

  it.each([
    [["measure"], "usage: ae measure"],
    [["measure", "/nope.png"], "no such file: /nope.png"],
    [["measure", "x.png", "--box", "1,2,3"], "--box must be x,y,w,h"],
    [["snap", "Main", "1", "--crop", "0,0,0,10"], "--crop must be x,y,w,h"],
  ])("ae %j -> exit 2", (args, msg) => {
    const r = ae(args);
    expect(r.code).toBe(2);
    expect(r.err).toContain(msg);
  });
});

describe("cropFilter", () => {
  it("scales a comp-pixel region to the rendered size and clamps it", () => {
    expect(cropFilter([100, 50, 400, 200], 0.5, 960, 540)).toBe("crop=200:100:50:25");
    expect(cropFilter([1800, 1000, 400, 200], 0.5, 960, 540)).toBe("crop=60:40:900:500");
  });
});
