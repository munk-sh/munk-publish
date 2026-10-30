/**
 * Cross-platform smoke test for packaged Munk AI release artifacts.
 *
 * Extracts the platform installer (.zip on macOS, .AppImage on Linux, NSIS .exe on Windows),
 * locates the packaged `resources/` directory, boots `resources/host/run-packaged.js`
 * using the bundled Node binary, waits for the JSON `{"type":"ready"}` event,
 * and probes `apiOrigin` + `uiOrigin` over HTTP.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (arg.startsWith("--platform=")) out.platform = arg.slice("--platform=".length);
    else if (arg.startsWith("--arch=")) out.arch = arg.slice("--arch=".length);
    else if (arg.startsWith("--dir=")) out.dir = arg.slice("--dir=".length);
  }
  return out;
}

function findArtifact(dir, platform, arch) {
  const files = readdirSync(dir).sort().reverse();
  const archPatterns =
    arch === "x64" ? ["-x64.", "-x64-", "-x86_64.", "-x86_64-"] : [`-${arch}.`, `-${arch}-`];
  const match = files.find((name) => {
    if (name.endsWith(".blockmap") || name.endsWith(".yml")) return false;
    const hasArch = archPatterns.some((p) => name.includes(p));
    if (!hasArch) return false;
    if (platform === "darwin") return name.endsWith(".zip");
    if (platform === "linux") return name.endsWith(".AppImage");
    if (platform === "win32") return name.endsWith(".exe");
    return false;
  });
  if (!match) {
    throw new Error(
      `No release artifact found for ${platform}-${arch} in ${dir} (files: ${files.join(", ")})`,
    );
  }
  return join(dir, match);
}

function extractResourcesDir(artifactPath, platform, workDir) {
  const extractDir = join(workDir, "extracted");
  mkdirSync(extractDir, { recursive: true });

  if (platform === "darwin") {
    execFileSync("ditto", ["-x", "-k", artifactPath, extractDir], { stdio: "inherit" });
    const appDir = readdirSync(extractDir).find((n) => n.endsWith(".app"));
    if (!appDir) {
      throw new Error(`No .app bundle found after extracting ${artifactPath}`);
    }
    return join(extractDir, appDir, "Contents", "Resources");
  }

  if (platform === "linux") {
    execFileSync("chmod", ["+x", artifactPath]);
    execFileSync(artifactPath, ["--appimage-extract"], {
      cwd: extractDir,
      stdio: "inherit",
    });
    return join(extractDir, "squashfs-root", "resources");
  }

  if (platform === "win32") {
    execFileSync("7z", ["x", artifactPath, `-o${extractDir}`, "-y"], {
      stdio: "inherit",
    });
    const directResources = join(extractDir, "resources");
    if (existsSync(directResources)) {
      return directResources;
    }
    const plugDir = join(extractDir, "$PLUGINSDIR");
    if (existsSync(plugDir)) {
      const app7z = readdirSync(plugDir).find(
        (n) => n.startsWith("app-") && (n.endsWith(".7z") || n.endsWith(".zip")),
      );
      if (app7z) {
        const innerDir = join(workDir, "app-inner");
        mkdirSync(innerDir, { recursive: true });
        execFileSync("7z", ["x", join(plugDir, app7z), `-o${innerDir}`, "-y"], {
          stdio: "inherit",
        });
        return join(innerDir, "resources");
      }
    }
    throw new Error(`Could not locate resources/ inside Windows installer ${artifactPath}`);
  }

  throw new Error(`Unsupported platform: ${platform}`);
}

function verifyBundledBinaries(resourcesDir, platform) {
  const nodeBin = join(
    resourcesDir,
    "node",
    "bin",
    platform === "win32" ? "node.exe" : "node",
  );
  const opencodeBin = join(
    resourcesDir,
    "opencode",
    "bin",
    platform === "win32" ? "opencode.exe" : "opencode",
  );
  const rgBin = join(
    resourcesDir,
    "ripgrep",
    "bin",
    platform === "win32" ? "rg.exe" : "rg",
  );
  const runPackagedScript = join(resourcesDir, "host", "run-packaged.js");

  for (const [label, p] of [
    ["node", nodeBin],
    ["opencode", opencodeBin],
    ["ripgrep", rgBin],
    ["run-packaged.js", runPackagedScript],
  ]) {
    if (!existsSync(p)) {
      throw new Error(`Missing bundled ${label} at ${p}`);
    }
  }

  const nodeVer = execFileSync(nodeBin, ["--version"], { encoding: "utf8" }).trim();
  const rgVer = execFileSync(rgBin, ["--version"], { encoding: "utf8" }).split("\n")[0];
  const ocVer = execFileSync(opencodeBin, ["--version"], { encoding: "utf8" }).trim();
  console.log(`[smoke] binaries OK: node=${nodeVer}, opencode=${ocVer}, rg=${rgVer}`);

  return { nodeBin, runPackagedScript };
}

async function bootAndProbeHost(resourcesDir, nodeBin, runPackagedScript, homeDir) {
  console.log(`[smoke] starting packaged host session from ${resourcesDir}…`);
  const child = spawn(
    nodeBin,
    [
      runPackagedScript,
      "--resources-root",
      resourcesDir,
      "--home-dir",
      homeDir,
      "--node-binary",
      nodeBin,
    ],
    {
      cwd: join(resourcesDir, "host"),
      env: {
        ...process.env,
        MUNK_AUTO_RUNTIME: "desktop",
        MUNK_AUTO_HOME: homeDir,
        MUNK_RESOURCES_PATH: resourcesDir,
        MUNK_RESOURCES_ROOT: resourcesDir,
        MUNK_NODE_BINARY: nodeBin,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[host:err] ${chunk}`);
  });

  try {
    const ready = await new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => {
        rejectReady(new Error("Timed out waiting for packaged host ready (120s)"));
      }, 120_000);

      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        console.log(`[host:out] ${line}`);
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) return;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && parsed.type === "ready" && parsed.apiOrigin && parsed.uiOrigin) {
            clearTimeout(timer);
            resolveReady(parsed);
          }
        } catch {
          // ignore non-JSON lines
        }
      });

      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        rejectReady(
          new Error(`Host exited before ready (code=${code} signal=${signal})`),
        );
      });
    });

    console.log(
      `[smoke] host ready! apiOrigin=${ready.apiOrigin} uiOrigin=${ready.uiOrigin}`,
    );

    const uiRes = await fetch(`${ready.uiOrigin}/ui/`);
    if (!uiRes.ok) {
      throw new Error(`UI probe failed with status ${uiRes.status}`);
    }
    console.log(`[smoke] UI probe /ui/ -> ${uiRes.status} OK`);

    const doctorRes = await fetch(`${ready.apiOrigin}/dev/doctor`);
    if (!doctorRes.ok) {
      throw new Error(`API /dev/doctor probe failed with status ${doctorRes.status}`);
    }
    const doctorJson = await doctorRes.json();
    console.log(`[smoke] API probe /dev/doctor -> 200 OK`, JSON.stringify(doctorJson));

    if (!doctorJson.ok) {
      throw new Error(`Doctor reported ok=false`);
    }
    if (!doctorJson.opencode?.opencodeReachable) {
      throw new Error(`Doctor reported opencodeReachable=false`);
    }
    if (!doctorJson.git?.embedded?.ok) {
      throw new Error(`Doctor reported embedded git ok=false`);
    }
  } finally {
    child.kill("SIGTERM");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const platform = args.platform || process.platform;
  const arch = args.arch || process.arch;
  const assetsDir = resolve(args.dir || "./release-assets");

  console.log(`[smoke] target=${platform}-${arch} dir=${assetsDir}`);
  const artifactPath = findArtifact(assetsDir, platform, arch);
  console.log(`[smoke] found artifact: ${artifactPath}`);

  const workDir = mkdtempSync(join(tmpdir(), `munk-smoke-${platform}-${arch}-`));
  const homeDir = join(workDir, "munk-home");
  mkdirSync(homeDir, { recursive: true });

  try {
    const resourcesDir = extractResourcesDir(artifactPath, platform, workDir);
    console.log(`[smoke] extracted resourcesDir: ${resourcesDir}`);
    const { nodeBin, runPackagedScript } = verifyBundledBinaries(resourcesDir, platform);
    await bootAndProbeHost(resourcesDir, nodeBin, runPackagedScript, homeDir);
    console.log(`[smoke] PASSED for ${platform}-${arch}`);
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors on Windows file locks
    }
  }
}

main().catch((err) => {
  console.error("[smoke] FAILED:", err);
  process.exit(1);
});
