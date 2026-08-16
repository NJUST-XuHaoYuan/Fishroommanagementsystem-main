import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputDir = resolve(process.argv[2] || join(projectRoot, "release-output"));

const ARCHIVE_PATHS = [
  ".dockerignore",
  ".gitignore",
  "ATTRIBUTIONS.md",
  "DESIGN.md",
  "Dockerfile",
  "PRODUCT.md",
  "README.md",
  "default_shadcn_theme.css",
  "deploy",
  "docker",
  "docker-compose.yml",
  "index.html",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "postcss.config.mjs",
  "public",
  "scripts",
  "server",
  "src",
  "vite.config.ts",
];

const HIGH_CONFIDENCE_SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAKID[A-Za-z0-9]{32}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
];

const SENSITIVE_ASSIGNMENT_NAMES = [
  "AUTH_SESSION_SECRET",
  "SESSION_SECRET",
  "PERSONNEL_DATA_KEYRING_JSON",
  "POSTGRES_PASSWORD",
  "PGPASSWORD",
  "COS_SECRET_ID",
  "COS_SECRET_KEY",
  "AI_API_KEY",
  "FEISHU_WEBHOOK_URL",
  "FEISHU_WEBHOOK_SECRET",
  "FEISHU_APP_SECRET",
  "FEISHU_VERIFICATION_TOKEN",
];

const SENSITIVE_ASSIGNMENT_PATTERN = new RegExp(
  `^\\s*(?:-\\s*)?(?:(?:export|ENV)\\s+)?["']?(${SENSITIVE_ASSIGNMENT_NAMES.join("|")})["']?\\s*[:=]\\s*(.*?)\\s*[,;]?\\s*$`,
  "gmi"
);

function git(...args) {
  return execFileAsync("git", args, { cwd: projectRoot, maxBuffer: 20 * 1024 * 1024 });
}

function releaseEnvironment({ revision, shortRevision, createdAt }) {
  return [
    `RELEASE_VERSION=${shortRevision}`,
    `RELEASE_REVISION=${revision}`,
    `RELEASE_BUILT_AT=${createdAt}`,
    "",
  ].join("\n");
}

function releaseManifest({ revision, shortRevision, createdAt, archiveName, sha256 = "" }) {
  return {
    product: "fishroom-management-system",
    releaseRevision: revision,
    shortRevision,
    createdAt,
    sourceArchive: archiveName,
    sourceArchiveSha256: sha256 || undefined,
    releaseEnvironmentFile: "RELEASE.env",
    deploymentConfigurationChanged: true,
    requiredProductionEnvironment: [
      "AUTH_SESSION_SECRET",
      "PERSONNEL_DATA_KEYRING_JSON",
      "POSTGRES_PASSWORD",
      "UPLOADS_DIR",
    ],
    sensitiveDataProtection: {
      algorithm: "AES-256-GCM",
      keyringEnvironment: "PERSONNEL_DATA_KEYRING_JSON",
      bulkPersonnelResponsesContainSensitiveFields: false,
      perPersonSensitiveReadsAreAudited: true,
    },
    excludedFromRelease: [
      "wechat-miniprogram and other mini-program directories",
      ".env variants, package-manager credentials and secret files",
      ".git metadata",
      "node_modules",
      "dist",
      "uploads",
      "database and historical backups",
      "Docker image archives",
      "agent or Codex workspace files",
    ],
  };
}

function assertSafeArchiveEntries(entries, prefix) {
  const disallowed = [
    /(^|\/)(wechat-miniprogram|mini-?program|miniprogram|miniapp|wxapp|wechat-miniapp|weixin-miniapp)(\/|$)/i,
    /(^|\/)\.git(\/|$)/,
    /(^|\/)\.agents(\/|$)/,
    /(^|\/)\.codex(\/|$)/,
    /(^|\/)node_modules(\/|$)/,
    /(^|\/)dist(\/|$)/,
    /(^|\/)uploads(\/|$)/,
    /(^|\/)(backups?|db-backup|server-downloads)(\/|$)/i,
    /(^|\/)deploy\/images(\/|$)/,
    /(^|\/)\.env(?:\.[^/]+)?$/i,
    /(^|\/)\.(npmrc|netrc|pypirc)$/i,
    /(^|\/)(credentials?|secrets?)(?:\.[^/]*)?$/i,
    /(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)$/i,
    /\.(pem|key|p12|pfx)$/i,
  ];
  for (const entry of entries) {
    if (!entry.startsWith(`${prefix}/`)) throw new Error(`发版包出现异常顶层路径：${entry}`);
    const relative = entry.slice(prefix.length + 1);
    if (relative === "deploy/.env.example") continue;
    if (disallowed.some((pattern) => pattern.test(relative))) {
      throw new Error(`发版包包含禁止路径：${relative}`);
    }
  }
}

async function listFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function assertNoHighConfidenceSecrets(directory) {
  for (const path of await listFiles(directory)) {
    const metadata = await stat(path);
    if (metadata.size > 2 * 1024 * 1024) continue;
    const contents = await readFile(path);
    if (contents.includes(0)) continue;
    const text = contents.toString("utf8");
    if (HIGH_CONFIDENCE_SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
      throw new Error(`发版内容疑似包含凭据，请人工复核：${path.slice(directory.length + 1)}`);
    }
    SENSITIVE_ASSIGNMENT_PATTERN.lastIndex = 0;
    for (const match of text.matchAll(SENSITIVE_ASSIGNMENT_PATTERN)) {
      const name = match[1];
      let value = match[2].trim().replace(/[,;]\s*$/, "").trim();
      if (
        (value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1).trim();
      }
      const normalized = value.toLowerCase();
      const isSafeReferenceOrPlaceholder = !value
        || value === "''"
        || value === '""'
        || value.startsWith("${")
        || value.startsWith("process.env")
        || value.startsWith("Deno.env")
        || value.startsWith("secrets.")
        || value.startsWith("<")
        || value.includes("请替换")
        || normalized.includes("replace")
        || normalized.includes("change_this")
        || normalized.includes("changeme")
        || normalized.includes("example")
        || normalized.includes("placeholder")
        || normalized.includes("your_")
        || value === "..."
        || value.endsWith("-...");
      if (!isSafeReferenceOrPlaceholder) {
        throw new Error(`发版内容疑似写入了 ${name} 实值，请人工复核：${path.slice(directory.length + 1)}`);
      }
    }
  }
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function assertPathDoesNotExist(path) {
  try {
    await access(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`发版目录已存在，请勿覆盖：${path}`);
}

async function main() {
  const [{ stdout: status }, { stdout: revisionOutput }] = await Promise.all([
    git("status", "--porcelain"),
    git("rev-parse", "HEAD"),
  ]);
  if (status.trim()) throw new Error("工作区存在未提交改动，不能生成正式发版包");

  const revision = revisionOutput.trim();
  const shortRevision = revision.slice(0, 12);
  const prefix = `fishroom-management-${shortRevision}`;
  const archiveName = `${prefix}.tar.gz`;
  const createdAt = new Date().toISOString();
  const finalReleaseDir = join(outputDir, prefix);
  await mkdir(outputDir, { recursive: true });
  await assertPathDoesNotExist(finalReleaseDir);

  const stagingDir = await mkdtemp(join(outputDir, ".release-staging-"));
  try {
    const workDir = join(stagingDir, ".work");
    await mkdir(workDir);
    const rawTar = join(workDir, "source.tar");
    await git("archive", "--format=tar", `--prefix=${prefix}/`, `--output=${rawTar}`, "HEAD", "--", ...ARCHIVE_PATHS);
    await execFileAsync("tar", ["-xf", rawTar, "-C", workDir]);
    const releaseRoot = join(workDir, prefix);
    const releaseEnv = releaseEnvironment({ revision, shortRevision, createdAt });
    await writeFile(join(releaseRoot, ".release-revision"), `${revision}\n`, { mode: 0o644 });
    await writeFile(join(releaseRoot, "RELEASE.env"), releaseEnv, { mode: 0o644 });
    await writeFile(
      join(releaseRoot, "RELEASE_MANIFEST.json"),
      `${JSON.stringify(releaseManifest({ revision, shortRevision, createdAt, archiveName }), null, 2)}\n`,
      { mode: 0o644 }
    );
    await assertNoHighConfidenceSecrets(releaseRoot);

    const stagedArchivePath = join(stagingDir, archiveName);
    await execFileAsync("tar", ["-czf", stagedArchivePath, "-C", workDir, prefix]);
    const { stdout: listingOutput } = await execFileAsync("tar", ["-tzf", stagedArchivePath], {
      maxBuffer: 20 * 1024 * 1024,
    });
    const entries = listingOutput.split(/\r?\n/).filter(Boolean);
    assertSafeArchiveEntries(entries, prefix);

    const sha256 = await sha256File(stagedArchivePath);
    const manifest = releaseManifest({ revision, shortRevision, createdAt, archiveName, sha256 });
    const manifestName = `${prefix}.RELEASE_MANIFEST.json`;
    await writeFile(join(stagingDir, manifestName), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
    await writeFile(join(stagingDir, "RELEASE.env"), releaseEnv, { mode: 0o644 });
    await writeFile(join(stagingDir, "SHA256SUMS"), `${sha256}  ${basename(stagedArchivePath)}\n`, { mode: 0o644 });
    await rm(workDir, { recursive: true, force: true });

    await rename(stagingDir, finalReleaseDir);
    process.stdout.write(`${JSON.stringify({
      releaseDir: finalReleaseDir,
      archivePath: join(finalReleaseDir, archiveName),
      manifestPath: join(finalReleaseDir, manifestName),
      releaseEnvironmentPath: join(finalReleaseDir, "RELEASE.env"),
      sumsPath: join(finalReleaseDir, "SHA256SUMS"),
      revision,
      sha256,
      entries: entries.length,
    }, null, 2)}\n`);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message || error}\n`);
  process.exitCode = 1;
});
