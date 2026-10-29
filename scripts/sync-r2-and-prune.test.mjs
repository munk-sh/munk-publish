import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildChannelLatestJson,
  extractSemverFromKey,
  isMacArtifact,
  planPruneKeys,
} from "./sync-r2-and-prune.mjs";

describe("sync-r2-and-prune", () => {
  it("identifies macOS artifacts vs Windows/Linux artifacts", () => {
    assert.equal(isMacArtifact("latest-mac.yml"), true);
    assert.equal(isMacArtifact("Munk AI-0.1.6-arm64.dmg"), true);
    assert.equal(isMacArtifact("Munk AI-0.1.6-x64.zip"), true);
    assert.equal(isMacArtifact("Munk AI-0.1.6-x64.exe"), false);
    assert.equal(isMacArtifact("Munk AI-0.1.6-x64.AppImage"), false);
    assert.equal(isMacArtifact("latest.yml"), false);
  });

  it("builds channel latest.json with all 6 platform slots", () => {
    const betaFiles = [
      "Munk AI-0.1.6-arm64.dmg",
      "Munk AI-0.1.6-arm64.zip",
      "Munk AI-0.1.6-x64.dmg",
      "Munk AI-0.1.6-x64.zip",
      "Munk AI-0.1.6-x64.exe",
      "Munk AI-0.1.6-arm64.exe",
      "Munk AI-0.1.6-x64.AppImage",
      "Munk AI-0.1.6-arm64.AppImage",
    ];
    const latest = buildChannelLatestJson({
      version: "0.1.6",
      channel: "beta",
      publicBaseUrl: "https://downloads.munk.sh",
      fileNames: betaFiles,
    });
    assert.equal(latest.version, "0.1.6");
    assert.equal(latest.channel, "beta");
    assert.equal(
      latest.platforms["darwin-arm64"]?.dmg,
      "https://downloads.munk.sh/desktop/beta/Munk AI-0.1.6-arm64.dmg",
    );
    assert.equal(
      latest.platforms["win32-x64"]?.exe,
      "https://downloads.munk.sh/desktop/beta/Munk AI-0.1.6-x64.exe",
    );
    assert.equal(
      latest.platforms["linux-arm64"]?.appImage,
      "https://downloads.munk.sh/desktop/beta/Munk AI-0.1.6-arm64.AppImage",
    );
  });

  it("prunes R2 keys keeping only the latest 2 versions and never deleting latest*.yml/json", () => {
    const keys = [
      "desktop/beta/latest.json",
      "desktop/beta/latest-mac.yml",
      "desktop/beta/latest.yml",
      "desktop/beta/Munk AI-0.1.4-arm64.dmg",
      "desktop/beta/Munk AI-0.1.4-x64.exe",
      "desktop/beta/Munk AI-0.1.5-arm64.dmg",
      "desktop/beta/Munk AI-0.1.6-arm64.dmg",
    ];
    assert.equal(extractSemverFromKey("desktop/beta/Munk AI-0.1.4-arm64.dmg"), "0.1.4");
    const plan = planPruneKeys(keys, 2);
    assert.deepEqual(plan.keptVersions, ["0.1.6", "0.1.5"]);
    assert.deepEqual(plan.prunedVersions, ["0.1.4"]);
    assert.deepEqual(plan.keysToDelete, [
      "desktop/beta/Munk AI-0.1.4-arm64.dmg",
      "desktop/beta/Munk AI-0.1.4-x64.exe",
    ]);
  });
});
