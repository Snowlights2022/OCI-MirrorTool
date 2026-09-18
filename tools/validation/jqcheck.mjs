// Validates the exact jq programs used in .github/workflows/docker.yaml by shelling out to a real jq.
// Usage:  node tools/validation/jqcheck.mjs
// Needs a jq binary: set JQ=/path/to/jq, or put one in tools/validation/bin/, or have `jq` on PATH.
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function findJq() {
  if (process.env.JQ && existsSync(process.env.JQ)) return process.env.JQ;
  const candidates = [
    join(here, "bin", "jq-windows-amd64.exe"),
    join(here, "bin", "jq.exe"),
    join(here, "bin", "jq"),
    "/usr/bin/jq",
    "/usr/local/bin/jq",
    "/opt/homebrew/bin/jq",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return "jq"; // fall back to PATH
}

const JQ = findJq();
const dir = mkdtempSync(join(tmpdir(), "jqtest-"));
mkdirSync(dir, { recursive: true });
console.log(`using jq: ${JQ}`);

// The jq programs copied verbatim from the workflow
const P = {
  mediaType: `.mediaType // ""`,
  // platform_fingerprint (workflow lines ~98-105)
  platformFingerprint: `
    [ .manifests[]?
      | select((.platform.os // "") != "unknown")
      | select(.annotations["vnd.docker.reference.type"] != "attestation-manifest")
      | "\\(.platform.os)/\\(.platform.architecture)/\\(.platform.variant // ""):\\(.digest)"
    ] | sort | join("|")`,
  // src_fingerprint fallback (workflow line ~112)
  configDigest: `.config.digest // empty`,
  // strip_attestations (workflow lines ~164-169)
  stripAttestations: `
    .manifests |= [ .[]?
        | select((.platform.os // "") != "unknown")
        | select(.annotations["vnd.docker.reference.type"] != "attestation-manifest")
    ]`,
  // copy_per_platform platform list (workflow lines ~189-193)
  platformList: `
    .manifests[]?
    | select((.platform.os // "") != "unknown")
    | select(.annotations["vnd.docker.reference.type"] != "attestation-manifest")
    | "\\(.platform.os) \\(.platform.architecture) \\(.platform.variant // "")"`,
  // manifests length (workflow line ~238)
  listLength: `.manifests | length`,
};

let seq = 0;
// NOTE: runs jq via cmd.exe with stdio ignored, writing results to files.
// Node's default piped stdio is blocked in this sandbox (EPERM on named pipes).
const jq = (program, json, extra = []) => {
  const i = join(dir, `in${seq}.json`);
  const o = join(dir, `out${seq}.txt`);
  const e = join(dir, `err${seq}.txt`);
  seq++;
  writeFileSync(i, json);
  // Run via PowerShell with `>` redirection: jq 1.7.1 on Windows does not implement
  // the `jq PROG INPUT > OUTPUT` output-redirection syntax, and Node's piped stdio is
  // blocked in this sandbox (EPERM), so a shell-level redirect is the workable path.
  const progFile = join(dir, `prog${seq}.jq`);
  writeFileSync(progFile, program);
  const ps =
    `& "${JQ}" -r ${extra.map((x) => `'${x}'`).join(" ")} -f "${progFile}" "${i}" > "${o}" 2> "${e}"`;
  let code = 0;
  try {
    execFileSync("pwsh.exe", ["-NoProfile", "-Command", ps], { stdio: "ignore" });
  } catch (err) {
    code = err.status ?? 1;
  }
  let out = "";
  try {
    out = readFileSync(o, "utf8");
  } catch {
    out = "";
  }
  if (code !== 0) {
    let errText = "";
    try {
      errText = readFileSync(e, "utf8").trim().split("\n")[0];
    } catch {}
    return `__JQ_ERROR__ ${errText}`;
  }
  return out.replace(/\r\n/g, "\n").replace(/\n$/, "");
};

// --- fixtures ---------------------------------------------------------------
const attest = (digest, refType) => ({
  mediaType: "application/vnd.oci.image.manifest.v1+json",
  digest,
  size: 566,
  platform: { architecture: "unknown", os: "unknown" },
  annotations: { "vnd.docker.reference.type": "attestation-manifest", "vnd.docker.reference.digest": refType },
});

const buildkitIndex = JSON.stringify({
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.index.v1+json",
  manifests: [
    { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: "sha256:amd64", size: 100, platform: { architecture: "amd64", os: "linux" } },
    { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: "sha256:arm64", size: 100, platform: { architecture: "arm64", os: "linux", variant: "v8" } },
    attest("sha256:3c9d6d26bc78a88d9ec7b099476bfd248a1f8c16a820bf0c0e456de9fb4ee1a4", "sha256:amd64"),
    attest("sha256:ebb9249ee60954df956f087dddd94ec55288ef6f0c20e9df80989fb658bd7d62", "sha256:arm64"),
  ],
});

const dockerListIndex = JSON.stringify({
  schemaVersion: 2,
  mediaType: "application/vnd.docker.distribution.manifest.list.v2+json",
  manifests: [
    { mediaType: "application/vnd.docker.distribution.manifest.v2+json", digest: "sha256:x86", size: 100, platform: { architecture: "amd64", os: "linux" } },
    { mediaType: "application/vnd.docker.distribution.manifest.v2+json", digest: "sha256:arm", size: 100, platform: { architecture: "arm64", os: "linux", variant: "v8" } },
  ],
});

// windows-only index (no linux): must NOT be mangled
const windowsIndex = JSON.stringify({
  schemaVersion: 2,
  mediaType: "application/vnd.docker.distribution.manifest.list.v2+json",
  manifests: [
    { mediaType: "application/vnd.docker.distribution.manifest.v2+json", digest: "sha256:win", size: 100, platform: { architecture: "amd64", os: "windows", "os.version": "10.0.20348.2113" } },
  ],
});

// index carrying a real "unknown/unknown" OCI artifact that is NOT an attestation
const unknownArtifactIndex = JSON.stringify({
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.index.v1+json",
  manifests: [
    { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: "sha256:amd64", size: 100, platform: { architecture: "amd64", os: "linux" } },
    { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: "sha256:oras", size: 100, platform: { architecture: "unknown", os: "unknown" }, annotations: { "org.opencontainers.image.title": "sbom.spdx.json" } },
  ],
});

const singleManifest = JSON.stringify({
  schemaVersion: 2,
  mediaType: "application/vnd.docker.distribution.manifest.v2+json",
  config: { mediaType: "application/vnd.docker.container.image.v1+json", digest: "sha256:config1", size: 100 },
  layers: [{ mediaType: "application/vnd.docker.image.rootfs.diff.tar.gzip", digest: "sha256:layer1", size: 10 }],
});

const emptyConfigManifest = JSON.stringify({
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.manifest.v1+json",
  config: { mediaType: "application/vnd.oci.empty.v1+json", digest: "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a", size: 2 },
  layers: [{ mediaType: "application/vnd.in-toto+json", digest: "sha256:in", size: 20 }],
});

// what skopeo inspect --raw returns on auth/network failure (command substitution captured empty string)
const failedInspect = "";

const cases = [
  ["buildkit index (2 platforms + 2 attestations)", buildkitIndex],
  ["docker manifest.list (2 platforms)", dockerListIndex],
  ["windows-only index", windowsIndex],
  ["index with non-attestation unknown artifact", unknownArtifactIndex],
  ["single-arch docker manifest", singleManifest],
  ["attestation manifest (empty config)", emptyConfigManifest],
  ["failed/empty inspect output", failedInspect],
];

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected: ${JSON.stringify(expected)}\n        actual  : ${JSON.stringify(actual)}`);
};

console.log("=== mediaType extraction (used for is_list / routing) ===");
for (const [name, json] of cases) {
  console.log(`  ${name.padEnd(45)} -> ${JSON.stringify(jq(P.mediaType, json))}`);
}

console.log("\n=== platform_fingerprint ===");
check(
  "buildkit index -> only 2 real platforms, sorted",
  jq(P.platformFingerprint, buildkitIndex),
  "linux/amd64/:sha256:amd64|linux/arm64/v8:sha256:arm64"
);
check("docker manifest.list -> both platforms", jq(P.platformFingerprint, dockerListIndex), "linux/amd64/:sha256:x86|linux/arm64/v8:sha256:arm");
check("windows-only index -> preserved", jq(P.platformFingerprint, windowsIndex), "windows/amd64/:sha256:win");
check(
  "non-attestation unknown artifact -> filtered out",
  jq(P.platformFingerprint, unknownArtifactIndex),
  "linux/amd64/:sha256:amd64"
);
check("single manifest -> empty (falls back to config digest)", jq(P.platformFingerprint, singleManifest), "");
check("attestation manifest -> empty", jq(P.platformFingerprint, emptyConfigManifest), "");
check("empty input -> empty (no crash)", jq(P.platformFingerprint, failedInspect), "");

console.log("\n=== src_fingerprint fallback (config.digest) ===");
check("single manifest config digest", jq(P.configDigest, singleManifest), "sha256:config1");
check("empty-config manifest config digest", jq(P.configDigest, emptyConfigManifest), "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
check("index -> empty (no .config)", jq(P.configDigest, buildkitIndex), "");

console.log("\n=== is_up_to_date equivalence ===");
// src = buildkit build; dst = what aliyun holds after a successful per-platform push (single manifest)
const fpSrc = jq(P.platformFingerprint, buildkitIndex);
const fpDstSame = jq(P.platformFingerprint, buildkitIndex); // re-sync later, source unchanged
const fpDstOld = jq(P.platformFingerprint, JSON.stringify({ ...JSON.parse(buildkitIndex), manifests: [JSON.parse(buildkitIndex).manifests[0]] }));
check("same source twice -> equal (would skip)", fpSrc === fpDstSame ? "equal" : "differ", "equal");
check("source advanced (one platform changed) -> differ (would copy)", fpSrc === fpDstOld ? "equal" : "differ", "differ");
// attestation-only change must NOT trigger a re-copy
const attOnlyChanged = JSON.parse(buildkitIndex);
attOnlyChanged.manifests[2] = attest("sha256:brandnewattestationdigest", "sha256:amd64");
check(
  "attestation digest changed but platforms identical -> equal (skip, no futile re-copy)",
  jq(P.platformFingerprint, JSON.stringify(attOnlyChanged)) === fpSrc ? "equal" : "differ",
  "equal"
);

console.log("\n=== strip_attestations ===");
check("buildkit index -> 2 manifests left", jq(P.listLength, jq(P.stripAttestations, buildkitIndex, ["-c"]), ["-c"]).trim(), "2");
check("attestations gone", jq(P.platformFingerprint, jq(P.stripAttestations, buildkitIndex, ["-c"])), "linux/amd64/:sha256:amd64|linux/arm64/v8:sha256:arm64");
check("docker manifest.list untouched (2)", jq(P.listLength, jq(P.stripAttestations, dockerListIndex, ["-c"]), ["-c"]).trim(), "2");
check("single manifest -> .manifests null -> length 0", jq(P.listLength, jq(P.stripAttestations, singleManifest, ["-c"]), ["-c"]).trim(), "0");
// jq 1.7.1 exits 0 on an empty input file and prints nothing, so an empty `skopeo inspect --raw`
// result flows through as "" (not an error) -- which is exactly what the shell functions expect.
check("empty input -> jq exits 0 with no output -> \"\"", jq(P.stripAttestations, failedInspect, ["-c"]), "");

console.log("\n=== copy_per_platform iteration list ===");
for (const [name, json] of cases) {
  const out = jq(P.platformList, json);
  console.log(`  ${name.padEnd(45)} -> ${JSON.stringify(out.split("\n").filter(Boolean))}`);
}
check(
  "buildkit index yields amd64 + arm64/v8 (no unknown)",
  jq(P.platformList, jq(P.stripAttestations, buildkitIndex, ["-c"])).split("\n").filter(Boolean).join(" ; "),
  "linux amd64  ; linux arm64 v8"
);

console.log("\n=== copy_per_platform line parsing (simulated) ===");
const lines = jq(P.platformList, jq(P.stripAttestations, buildkitIndex, ["-c"])).split("\n").filter(Boolean);
const plan = lines.map((l) => {
  const [os, arch, variant = ""] = l.split(" ");
  return `--override-os ${os} --override-arch ${arch}${variant ? ` --override-variant ${variant}` : ""}`;
});
plan.forEach((p, i) => console.log(`  ${lines[i].padEnd(16)} -> ${p}`));
check("two skopeo invocations, arm64 gets --override-variant v8", plan.length === 2 && plan[1].includes("--override-variant v8") ? "ok" : plan.join(" | "), "ok");

console.log(failures === 0 ? "\n=== ALL jq FILTER CHECKS PASSED ===" : `\n=== ${failures} jq CHECK(S) FAILED ===`);
process.exit(failures === 0 ? 0 : 1);
