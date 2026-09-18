import { readFileSync } from "node:fs";
import { parse } from "yaml";

const text = readFileSync(process.argv[2], "utf8");
let doc;
try {
  doc = parse(text);
} catch (e) {
  console.log("YAML PARSE FAILED:\n" + e.message);
  process.exit(1);
}
console.log("== YAML PARSE OK ==");
console.log("top-level keys:", Object.keys(doc).join(", "));
console.log("jobs:", Object.keys(doc.jobs).join(", "));
console.log("'on' triggers:", JSON.stringify(doc.on));

const steps = doc.jobs.build.steps;
console.log("\n== STEPS ==");
steps.forEach((s, i) => {
  const kind = s.uses ? `uses=${s.uses}` : `run(${s.run.split("\n").length} lines)`;
  console.log(`  [${i}] ${s.name}  ->  ${kind}`);
});

const mail = steps.find((s) => (s.name ?? "").includes("Email"));
const toolingCheck = steps.find((s) => (s.name ?? "").includes("Check container tooling"));

console.log("\n== EMAIL STEP ==");
console.log("env:", JSON.stringify(mail.env, null, 2));

// --- simulate the shell-side subject logic with the values from the real run ---
function subject(success, skipped, failure) {
  success = String(success ?? 0);
  skipped = String(skipped ?? 0);
  failure = String(failure ?? 0);
  if (+failure > 0 && +success > 0)
    return `⚠️ AliCR镜像同步部分失败 (成功 ${success} / 失败 ${failure})`;
  if (+failure > 0) return `❌ AliCR镜像同步失败 (失败 ${failure})`;
  if (+success > 0) return `✅ AliCR镜像同步成功 (${success} 个)`;
  return "☕ 同步任务完成 (无新镜像)";
}
console.log("\n== SUBJECT MATRIX (成功/跳过/失败) ==");
for (const c of [
  [0, 6, 0],
  [4, 2, 0],
  [3, 1, 1],
  [0, 2, 4],
  [undefined, 2, 0],
]) {
  console.log(`  ${JSON.stringify(c)} -> ${subject(...c)}`);
}

// --- reproduce the NEW jq filters in JS and run them over representative manifests ---
const isAttestation = (m) =>
  (m.platform?.os ?? "") === "unknown" ||
  m.annotations?.["vnd.docker.reference.type"] === "attestation-manifest";

function fingerprint(manifest) {
  const fps = (manifest.manifests ?? [])
    .filter((m) => (m.platform?.os ?? "") !== "unknown")
    .filter((m) => m.annotations?.["vnd.docker.reference.type"] !== "attestation-manifest")
    .map((m) => `${m.platform.os}/${m.platform.architecture}/${m.platform.variant ?? ""}:${m.digest}`);
  if (fps.length) return fps.sort().join("|");
  return manifest.config?.digest ?? "";
}

function strip(manifest) {
  return {
    ...manifest,
    manifests: (manifest.manifests ?? []).filter((m) => !isAttestation(m)),
  };
}

// realistic buildkit output: 2 platforms + 2 attestation manifests
const buildkitIndex = {
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.index.v1+json",
  manifests: [
    { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: "sha256:aaaa", size: 1, platform: { architecture: "amd64", os: "linux" } },
    { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: "sha256:bbbb", size: 1, platform: { architecture: "arm64", os: "linux", variant: "v8" } },
    {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: "sha256:3c9d6d26bc78a88d9ec7b099476bfd248a1f8c16a820bf0c0e456de9fb4ee1a4",
      size: 566,
      platform: { architecture: "unknown", os: "unknown" },
      annotations: { "vnd.docker.reference.type": "attestation-manifest", "vnd.docker.reference.digest": "sha256:aaaa" },
    },
    {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: "sha256:cccc",
      size: 566,
      platform: { architecture: "unknown", os: "unknown" },
      annotations: { "vnd.docker.reference.type": "attestation-manifest", "vnd.docker.reference.digest": "sha256:bbbb" },
    },
  ],
};

const aliyunIndex = { ...buildkitIndex, manifests: [buildkitIndex.manifests[0], buildkitIndex.manifests[1]] };

const singleManifest = {
  schemaVersion: 2,
  mediaType: "application/vnd.docker.distribution.manifest.v2+json",
  config: { mediaType: "application/vnd.docker.container.image.v1+json", digest: "sha256:config1", size: 100 },
  layers: [],
};

const emptyConfigManifest = {
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.manifest.v1+json",
  config: { mediaType: "application/vnd.oci.empty.v1+json", digest: "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a", size: 2 },
  layers: [],
};

console.log("\n== FINGERPRINT BEHAVIOUR ==");
console.log("  src(buildkit index, 2 real + 2 attestation) =", fingerprint(buildkitIndex));
console.log("  dst(aliyun, 2 real platforms)               =", fingerprint(aliyunIndex));
console.log("  => 一致，跳过重推:", fingerprint(buildkitIndex) === fingerprint(aliyunIndex));
console.log("  src(单架构 manifest)                         =", fingerprint(singleManifest));
console.log("  src(只有空描述符的 attestation manifest)      =", JSON.stringify(fingerprint(emptyConfigManifest)));

const stripped = strip(buildkitIndex);
console.log("\n== STRIP ATTESTATIONS ==");
console.log("  before:", buildkitIndex.manifests.length, "manifests");
console.log(
  "  after :",
  stripped.manifests.length,
  "manifests ->",
  stripped.manifests.map((m) => `${m.platform.os}/${m.platform.architecture}${m.platform.variant ? "/" + m.platform.variant : ""}`).join(", ")
);
console.log("  残留 unknown 平台:", stripped.manifests.filter((m) => m.platform.os === "unknown").length);
console.log("  index mediaType 保留:", stripped.mediaType);
console.log("\n  逐平台推送计划:");
for (const m of stripped.manifests) {
  const p = m.platform;
  console.log(`    --override-os ${p.os} --override-arch ${p.architecture}${p.variant ? ` --override-variant ${p.variant}` : ""}`);
}

const allAttestation = { ...buildkitIndex, manifests: [buildkitIndex.manifests[2], buildkitIndex.manifests[3]] };
console.log("\n  病态输入（全部为 attestation）→ strip 后条目数:", strip(allAttestation).manifests.length, "（脚本据此跳过降级策略）");

// --- structural checks on the workflow file itself ---
console.log("\n== STRUCTURAL CHECKS ==");
const syncRun = steps.find((s) => s.id === "sync_step").run;
// 代码行（剔除注释与 workflow 表达式行），用于断言真实语句而不是注释文字
const codeLines = syncRun
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));

// skopeo copy 的源必须带传输前缀 docker://
// （曾因重构时丢掉前缀，导致每张镜像都报 `unknown transport`，全线失败）
// 先把续行（以 \ 结尾）拼成逻辑语句，再逐条检查。
const logicalLines = [];
for (const line of codeLines) {
  if (logicalLines.length && logicalLines[logicalLines.length - 1].endsWith("\\")) {
    logicalLines[logicalLines.length - 1] = logicalLines[logicalLines.length - 1].slice(0, -1).trim() + " " + line;
  } else {
    logicalLines.push(line);
  }
}
const skopeoCopies = logicalLines.filter((l) => /\bskopeo copy\b/.test(l));
const badTransports = skopeoCopies.filter((l) => !l.includes("docker://$"));

// --all 与 --override-os/--override-arch 互斥（skopeo-copy(1)：--all 会忽略平台选择、
// 复制整个列表）。逐平台复制若带 --all，就会把 attestation 子清单一起推上去，
// 重新触发阿里云拒绝，白跑一轮。
const retryCopyBody = codeLines.slice(
  codeLines.findIndex((l) => l === "retry_copy() {"),
  codeLines.findIndex((l) => l === "retry_copy() {") + 20
).join("\n");
const perPlatformCall = logicalLines.find((l) => l.includes("--override-os")) ?? "";
const strategy1Call = logicalLines.find((l) => l.includes('"$dest_creds" 1')) ?? "";
const copyPerPlatformStart = syncRun.indexOf("copy_per_platform() {");
const copyPerPlatformEnd = syncRun.indexOf("\n          }\n\n          # -------------------------------------------------------------------\n          # 复制策略", copyPerPlatformStart);
const copyPerPlatformBody = syncRun.slice(copyPerPlatformStart, copyPerPlatformEnd);
const tempCopyIndex = copyPerPlatformBody.indexOf('retry_copy "$src_ref" "docker://${temp_ref}"');
const manifestCreateIndex = copyPerPlatformBody.indexOf('docker manifest create "$target_ref"');
const manifestAnnotateIndex = copyPerPlatformBody.indexOf('docker manifest annotate "$target_ref"');
const manifestPushIndex = copyPerPlatformBody.indexOf('docker manifest push --purge "$target_ref"');
const manifestFailureIndex = copyPerPlatformBody.indexOf('manifest list 推送失败');
const ecrLoginIndex = syncRun.indexOf("aws ecr get-login-password");
const sourceInspectIndex = syncRun.indexOf('skopeo inspect --raw "docker://$src_ref"');
const syncResultWriteIndex = syncRun.indexOf("write_result");
const syncFailureExitIndex = syncRun.indexOf('if [ "$FAILURE_COUNT" -gt 0 ]; then');

const checks = [
  ["sync 步骤包含 platform_fingerprint", syncRun.includes("platform_fingerprint()")],
  ["sync 步骤包含 strip_attestations", syncRun.includes("strip_attestations()")],
  ["sync 步骤包含 copy_per_platform", syncRun.includes("copy_per_platform()")],
  ["sync 步骤包含 retry_copy", syncRun.includes("retry_copy()")],
  ["sync 步骤调用 copy_image", syncRun.includes("copy_image \"$src_ref\"")],
  ["sync 步骤不再直接 skopeo copy --all 源镜像", !syncRun.includes("skopeo copy --all \"docker://$full_image\"")],
  ["源 inspect 使用 src_ref", syncRun.includes('skopeo inspect --raw "docker://$src_ref"')],
  [`每处 skopeo copy 的源都带 docker:// 前缀（共 ${skopeoCopies.length} 处）`, badTransports.length === 0 && skopeoCopies.length >= 2],
  ["retry_copy 不再写死 --all（改由调用方传入）", !/skopeo copy --all "docker:\/\/\$src"/.test(retryCopyBody)],
  ["逐平台复制不带 --all（否则 override 被忽略）", perPlatformCall.includes("--override-os") && !perPlatformCall.includes("--all")],
  ["策略 1 的整份复制仍带 --all", strategy1Call.includes("--all")],
  ["逐平台复制使用临时 tag", tempCopyIndex >= 0 && copyPerPlatformBody.includes("temp_ref=\"${target_repo}:mirror-tmp-")],
  ["临时 tag 包含 run、attempt 和平台序号", /mirror-tmp-\$\{GITHUB_RUN_ID:-local\}-\$\{GITHUB_RUN_ATTEMPT:-1\}-\$\{target_key\}-\$\{platform_index\}/.test(copyPerPlatformBody)],
  ["先完成平台复制再创建 manifest list", tempCopyIndex >= 0 && manifestCreateIndex > tempCopyIndex],
  ["manifest list 依次执行 create、annotate、push", manifestCreateIndex >= 0 && manifestAnnotateIndex > manifestCreateIndex && manifestPushIndex > manifestAnnotateIndex],
  ["manifest push 使用 --purge", manifestPushIndex >= 0],
  ["manifest push 失败会返回非零", manifestFailureIndex >= 0 && copyPerPlatformBody.includes("return 1", manifestFailureIndex)],
  ["没有使用危险的通用 skopeo delete", !copyPerPlatformBody.includes("skopeo delete")],
  ["workflow 预检 Docker manifest、buildx 和 skopeo", !!toolingCheck?.run && toolingCheck.run.includes("docker manifest --help") && toolingCheck.run.includes("docker buildx version") && toolingCheck.run.includes("skopeo --version")],
  ["index-only 重建不带 --all", syncRun.includes("--multi-arch index-only") && !syncRun.includes("--all --multi-arch index-only")],
  ["阿里云登录失败即退出", /if ! echo "\$ALIYUN_REGISTRY_PASSWORD"[\s\S]*?FAILURE_COUNT=1[\s\S]*?write_result[\s\S]*?exit 1/.test(syncRun)],
  ["ECR 登录发生在源 inspect 之前", ecrLoginIndex >= 0 && sourceInspectIndex > ecrLoginIndex],
  ["同步失败会在写入结果后退出", syncFailureExitIndex > syncResultWriteIndex && /exit 1/.test(syncRun.slice(syncFailureExitIndex, syncFailureExitIndex + 180))],
  ["workflow 声明只读权限", doc.permissions?.contents === "read" && doc.permissions?.packages === "read"],
  ["job 有 timeout-minutes", typeof doc.jobs.build["timeout-minutes"] === "number"],
  ["job 有 concurrency", !!doc.jobs.build.concurrency?.group],
  ["GITHUB_ENV heredoc 使用唯一分隔符", syncRun.includes("SYNC_RESULT<<SYNC_RESULT_EOF")],
  ["邮件步骤已移除 printf -v SUBJECT 表达式", !/printf -v SUBJECT '%s' "\$\{\{/.test(mail.run)],
  ["邮件步骤注释里说明了旧写法（仅注释，非代码）", mail.run.split("\n").filter((l) => l.includes("env.FAILURE_COUNT")).every((l) => l.trim().startsWith("#"))],
  ["SYNC_RESULT 改为专用 env 变量而非 shell 展开", mail.run.includes('"详细结果: ${SYNC_RESULT:-无}"')],
  ["邮件步骤使用 shell 计数变量", mail.run.includes('FAILURE_COUNT="${FAILURE_COUNT:-0}"')],
  ["curl 使用 --fail-with-body", mail.run.includes("--fail-with-body")],
];
if (badTransports.length) {
  console.log("  缺失 docker:// 前缀的 skopeo copy：");
  badTransports.forEach((l) => console.log(`    ${l}`));
}
let bad = 0;
for (const [name, ok] of checks) {
  if (!ok) bad++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
}

// heredoc / quote balance sanity for each run block
console.log("\n== RUN BLOCK SANITY ==");
for (const s of steps.filter((x) => x.run)) {
  const lines = s.run.split("\n");
  const heredocs = lines.filter((l) => /<<-?'?[A-Z_]+'?$/.test(l.trim()));
  console.log(`  ${s.name}: ${lines.length} 行, heredoc 起始 ${heredocs.length} 个`);
}
console.log(bad === 0 ? "\n全部结构与逻辑检查通过" : `\n有 ${bad} 项检查未通过`);
process.exit(bad === 0 ? 0 : 1);
