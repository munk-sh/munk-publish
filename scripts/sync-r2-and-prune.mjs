/**
 * Sync GitHub Release assets to Cloudflare R2 (release + beta channels)
 * and prune old versions so R2 only retains the latest 2 versions per channel.
 *
 * Channel routing rules:
 * - desktop/release/ (stable): ONLY macOS (darwin-arm64 & darwin-x64: .dmg, .zip, .blockmap, latest-mac.yml) + latest.json
 * - desktop/beta/: ALL 6 platforms (darwin-arm64/x64, win32-x64/arm64, linux-x64/arm64 + all latest*.yml) + latest.json
 */
import { execFileSync } from "node:child_process";
import { createReadStream, createWriteStream, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

export const DESKTOP_LATEST_SCHEMA = "munk.desktop.latest.v1";

export const ALL_PLATFORM_KEYS = [
  "darwin-arm64",
  "darwin-x64",
  "win32-x64",
  "win32-arm64",
  "linux-x64",
  "linux-arm64",
];

const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const NO_CACHE = "no-cache";

export function contentTypeForFileName(fileName) {
  if (fileName.endsWith(".yml") || fileName.endsWith(".yaml")) {
    return "text/yaml; charset=utf-8";
  }
  if (fileName.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  if (fileName.endsWith(".dmg")) {
    return "application/x-apple-diskimage";
  }
  if (fileName.endsWith(".zip")) {
    return "application/zip";
  }
  if (fileName.endsWith(".exe")) {
    return "application/vnd.microsoft.portable-executable";
  }
  return "application/octet-stream";
}

export function cacheControlForFileName(fileName) {
  if (/^latest.*\.yml$/i.test(fileName) || fileName === "latest.json") {
    return NO_CACHE;
  }
  return IMMUTABLE_CACHE;
}

export function isMacArtifact(fileName) {
  if (fileName === "latest-mac.yml") return true;
  if (
    fileName.endsWith(".dmg") ||
    fileName.endsWith(".dmg.blockmap") ||
    fileName.endsWith("-mac.zip") ||
    fileName.endsWith("-mac.zip.blockmap") ||
    (fileName.endsWith(".zip") && !fileName.includes("win") && !fileName.includes("linux")) ||
    (fileName.endsWith(".zip.blockmap") && !fileName.includes("win") && !fileName.includes("linux"))
  ) {
    return true;
  }
  return false;
}

export function isDesktopReleaseAsset(fileName) {
  return (
    /^latest.*\.yml$/i.test(fileName) ||
    fileName.endsWith(".dmg") ||
    fileName.endsWith(".zip") ||
    fileName.endsWith(".exe") ||
    fileName.endsWith(".AppImage") ||
    fileName.endsWith(".blockmap")
  );
}

export function inferPlatformAndKind(fileName) {
  if (fileName.endsWith(".blockmap") || /^latest.*\.yml$/i.test(fileName)) {
    return null;
  }
  const isArm64 = fileName.includes("arm64") || fileName.includes("aarch64");
  const arch = isArm64 ? "arm64" : "x64";

  if (fileName.endsWith(".dmg")) {
    return { platform: `darwin-${arch}`, kind: "dmg" };
  }
  if (fileName.endsWith(".zip")) {
    return { platform: `darwin-${arch}`, kind: "zip" };
  }
  if (fileName.endsWith(".exe")) {
    return { platform: `win32-${arch}`, kind: "exe" };
  }
  if (fileName.endsWith(".AppImage")) {
    return { platform: `linux-${arch}`, kind: "appImage" };
  }
  return null;
}

export function buildChannelLatestJson({
  version,
  channel,
  publicBaseUrl,
  prefix = "",
  fileNames,
  releasedAt = new Date().toISOString(),
}) {
  const baseUrl = publicBaseUrl.replace(/\/+$/, "");
  const keyPrefix = prefix ? `${prefix.replace(/^\/+|\/+$/g, "")}/desktop/${channel}/` : `desktop/${channel}/`;

  const platforms = {
    "darwin-arm64": null,
    "darwin-x64": null,
    "win32-x64": null,
    "win32-arm64": null,
    "linux-x64": null,
    "linux-arm64": null,
  };

  for (const name of fileNames) {
    const info = inferPlatformAndKind(name);
    if (!info) continue;
    const slot = platforms[info.platform] ?? {};
    slot[info.kind] = `${baseUrl}/${keyPrefix}${name}`;
    platforms[info.platform] = slot;
  }

  return {
    schema: DESKTOP_LATEST_SCHEMA,
    version,
    channel,
    releasedAt,
    platforms,
  };
}

export function extractSemverFromKey(key) {
  const name = key.split("/").pop() ?? "";
  if (/^latest.*\.(yml|json)$/i.test(name)) {
    return null;
  }
  const match = /-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-(?:arm64|x64|aarch64|x86_64)\./.exec(name);
  return match?.[1] ?? null;
}

export function compareSemverDesc(a, b) {
  const parse = (v) => {
    const [core, pre = ""] = v.split("-", 2);
    const nums = core.split(".").map((n) => Number(n) || 0);
    return { nums, pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if ((pa.nums[i] ?? 0) !== (pb.nums[i] ?? 0)) {
      return (pb.nums[i] ?? 0) - (pa.nums[i] ?? 0);
    }
  }
  if (!pa.pre && pb.pre) return -1;
  if (pa.pre && !pb.pre) return 1;
  return pb.pre.localeCompare(pa.pre);
}

export function planPruneKeys(objectKeys, keepCount = 2) {
  const versions = new Set();
  for (const key of objectKeys) {
    const v = extractSemverFromKey(key);
    if (v) versions.add(v);
  }
  const sortedVersions = [...versions].sort(compareSemverDesc);
  const keptVersions = new Set(sortedVersions.slice(0, keepCount));
  const prunedVersions = sortedVersions.slice(keepCount);

  const keysToDelete = [];
  for (const key of objectKeys) {
    const v = extractSemverFromKey(key);
    if (v && !keptVersions.has(v)) {
      keysToDelete.push(key);
    }
  }
  return {
    keptVersions: [...keptVersions],
    prunedVersions,
    keysToDelete,
  };
}

async function listAllKeys(s3, ListObjectsV2Command, bucketName, prefix) {
  const existingKeys = [];
  let continuationToken = undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of page.Contents ?? []) {
      if (obj.Key) existingKeys.push(obj.Key);
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return existingKeys;
}

async function pruneR2Channel({
  s3,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  bucketName,
  channel,
  channelPrefix,
  keepCount,
}) {
  const existingKeys = await listAllKeys(s3, ListObjectsV2Command, bucketName, channelPrefix);
  const prunePlan = planPruneKeys(existingKeys, keepCount);
  console.log(
    `  [prune] channel=${channel} keeping versions=[${prunePlan.keptVersions.join(", ")}] pruning=[${prunePlan.prunedVersions.join(", ")}]`,
  );
  if (prunePlan.keysToDelete.length > 0) {
    for (const k of prunePlan.keysToDelete) {
      console.log(`    deleting ${basename(k)}`);
    }
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucketName,
        Delete: {
          Objects: prunePlan.keysToDelete.map((Key) => ({ Key })),
          Quiet: true,
        },
      }),
    );
  }
}

async function publishGithubFromR2AndPrune({
  s3,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  bucketName,
  prefix,
  version,
  tag,
  assetsDir,
  keepCount,
}) {
  const betaPrefix = prefix ? `${prefix}/desktop/beta/` : "desktop/beta/";
  const allBetaKeys = await listAllKeys(s3, ListObjectsV2Command, bucketName, betaPrefix);
  const matchingKeys = allBetaKeys.filter((k) => {
    const name = basename(k);
    if (!isDesktopReleaseAsset(name)) return false;
    if (/^latest.*\.yml$/i.test(name)) return true;
    return extractSemverFromKey(k) === version;
  });

  if (matchingKeys.length === 0) {
    throw new Error(`No assets found on R2 under ${betaPrefix} for version=${version}`);
  }

  mkdirSync(assetsDir, { recursive: true });
  const localFiles = [];
  console.log(`\n=== Downloading ${matchingKeys.length} assets for ${tag} from R2 ===`);
  for (const key of matchingKeys) {
    const name = basename(key);
    const localPath = join(assetsDir, name);
    console.log(`  [download] ${key} -> ${localPath}`);
    const res = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
    await pipeline(res.Body, createWriteStream(localPath));
    localFiles.push(localPath);
  }

  console.log(`\n=== Publishing GitHub Release ${tag} with ${localFiles.length} assets ===`);
  let releaseExists = false;
  try {
    execFileSync("gh", ["release", "view", tag], { stdio: "ignore" });
    releaseExists = true;
  } catch {
    releaseExists = false;
  }

  if (!releaseExists) {
    execFileSync(
      "gh",
      [
        "release",
        "create",
        tag,
        "--title",
        `Munk AI ${tag}`,
        "--notes",
        `Munk AI Desktop ${version} multi-platform release.`,
        ...localFiles,
      ],
      { stdio: "inherit" },
    );
  } else {
    execFileSync("gh", ["release", "upload", tag, "--clobber", ...localFiles], {
      stdio: "inherit",
    });
    execFileSync("gh", ["release", "edit", tag, "--draft=false"], {
      stdio: "inherit",
    });
  }

  console.log(`\n=== Pruning old versions on R2 (keep=${keepCount}) ===`);
  for (const channel of ["release", "beta"]) {
    const channelPrefix = prefix ? `${prefix}/desktop/${channel}/` : `desktop/${channel}/`;
    await pruneR2Channel({
      s3,
      ListObjectsV2Command,
      DeleteObjectsCommand,
      bucketName,
      channel,
      channelPrefix,
      keepCount,
    });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dirArg = args.find((a) => a.startsWith("--dir="))?.slice("--dir=".length) || "./release-assets";
  const tagArg = args.find((a) => a.startsWith("--tag="))?.slice("--tag=".length) || process.env.RELEASE_TAG || "";
  const dryRun = args.includes("--dry-run");
  const fromR2 = args.includes("--from-r2");
  const keepCount = Number(
    args.find((a) => a.startsWith("--keep="))?.slice("--keep=".length) || "2",
  );

  const version = tagArg.replace(/^v/, "").trim();
  if (!version) {
    throw new Error("Missing --tag=<vX.Y.Z> or RELEASE_TAG env");
  }
  const tag = `v${version}`;
  const assetsDir = resolve(process.cwd(), dirArg);

  const accountId = process.env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  const bucketName = process.env.R2_BUCKET_NAME?.trim();
  const publicBaseUrl = (process.env.R2_PUBLIC_BASE_URL?.trim() || "https://downloads.munk.sh").replace(/\/+$/, "");
  const region = process.env.R2_REGION?.trim() || "auto";
  const prefix = (process.env.R2_PREFIX?.trim() || "").replace(/^\/+|\/+$/g, "");

  if (!dryRun && (!accountId || !accessKeyId || !secretAccessKey || !bucketName)) {
    throw new Error("Missing required R2_* environment variables");
  }

  const {
    S3Client,
    GetObjectCommand,
    PutObjectCommand,
    ListObjectsV2Command,
    DeleteObjectsCommand,
  } = await import("@aws-sdk/client-s3");

  const s3 = !dryRun
    ? new S3Client({
        region,
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId, secretAccessKey },
        forcePathStyle: true,
      })
    : null;

  if (fromR2) {
    await publishGithubFromR2AndPrune({
      s3,
      GetObjectCommand,
      ListObjectsV2Command,
      DeleteObjectsCommand,
      bucketName,
      prefix,
      version,
      tag,
      assetsDir,
      keepCount,
    });
    return;
  }

  const allFiles = readdirSync(assetsDir)
    .filter((f) => isDesktopReleaseAsset(f))
    .sort();

  if (allFiles.length === 0) {
    throw new Error(`No desktop release assets found in ${assetsDir}`);
  }

  const releaseChannelFiles = allFiles.filter((f) => isMacArtifact(f));
  const betaChannelFiles = allFiles;

  const channels = [
    { channel: "release", files: releaseChannelFiles },
    { channel: "beta", files: betaChannelFiles },
  ];

  for (const { channel, files } of channels) {
    const channelPrefix = prefix ? `${prefix}/desktop/${channel}/` : `desktop/${channel}/`;
    console.log(`\n=== Syncing channel=${channel} (version=${version}, files=${files.length}) ===`);

    for (const fileName of files) {
      const localPath = join(assetsDir, fileName);
      const key = `${channelPrefix}${fileName}`;
      const contentType = contentTypeForFileName(fileName);
      const cacheControl = cacheControlForFileName(fileName);
      console.log(`  [upload] ${key} (${cacheControl})`);

      if (!dryRun && s3) {
        const size = statSync(localPath).size;
        await s3.send(
          new PutObjectCommand({
            Bucket: bucketName,
            Key: key,
            Body: createReadStream(localPath),
            ContentType: contentType,
            CacheControl: cacheControl,
            ContentLength: size,
          }),
        );
      }
    }

    const latestJson = buildChannelLatestJson({
      version,
      channel,
      publicBaseUrl,
      prefix,
      fileNames: files,
    });
    const latestKey = `${channelPrefix}latest.json`;
    const latestBody = `${JSON.stringify(latestJson, null, 2)}\n`;
    console.log(`  [upload] ${latestKey} (no-cache)`);

    if (!dryRun && s3) {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: latestKey,
          Body: Buffer.from(latestBody, "utf8"),
          ContentType: "application/json; charset=utf-8",
          CacheControl: NO_CACHE,
        }),
      );
      await pruneR2Channel({
        s3,
        ListObjectsV2Command,
        DeleteObjectsCommand,
        bucketName,
        channel,
        channelPrefix,
        keepCount,
      });
    }
  }
}

const isDirectRun =
  process.argv[1] && process.argv[1].endsWith("sync-r2-and-prune.mjs");

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
