import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const DIST = join(import.meta.dir, "..", "dist");

describe("PWA build output", () => {
  it("includes manifest.json in dist", () => {
    expect(existsSync(join(DIST, "manifest.json"))).toBe(true);
  });

  it("includes sw.js in dist", () => {
    expect(existsSync(join(DIST, "sw.js"))).toBe(true);
  });

  it("includes icon SVGs in dist", () => {
    expect(existsSync(join(DIST, "icon-192.svg"))).toBe(true);
    expect(existsSync(join(DIST, "icon-512.svg"))).toBe(true);
  });

  it("manifest has valid JSON and required fields", () => {
    const manifest = JSON.parse(readFileSync(join(DIST, "manifest.json"), "utf-8"));
    expect(manifest.name).toBeString();
    expect(manifest.short_name).toBeString();
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.theme_color).toBeString();
    expect(manifest.background_color).toBeString();
    expect(manifest.icons).toBeArray();
  });

  it("index.html links manifest.json", () => {
    const html = readFileSync(join(DIST, "index.html"), "utf-8");
    expect(html).toInclude('rel="manifest"');
    expect(html).toInclude('href="/manifest.json"');
  });

  it("index.html includes robots meta / sitemap reference", () => {
    const html = readFileSync(join(DIST, "index.html"), "utf-8");
    expect(html).toInclude('name="description"');
    expect(html).toInclude('property="og:image"');
    expect(html).toInclude('name="twitter:card"');
    expect(html).toInclude('rel="canonical"');
  });
});