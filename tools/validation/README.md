# tools/validation

开发期自检脚本，**不参与 CI**，不会影响 `Docker Image Sync to Aliyun` 工作流。

用来在推送前验证 `.github/workflows/docker.yaml`，避免"改完直接推、等 6 小时才知道跑没跑通"。

## 脚本

| 脚本 | 作用 |
|---|---|
| `check.mjs` | 解析 workflow YAML，检查步骤结构、邮件主题判定矩阵、关键语句是否还在位 |
| `jqcheck.mjs` | 用**真实 jq** 执行 workflow 里的每一段 jq 程序，覆盖多架构 / attestation / 单架构 / inspect 失败等输入 |
| `extract.mjs` | 把 workflow 的 `run:` 脚本抽成 `.sh`，便于在本地做 `bash -n` 语法检查或人工审阅 |

## 运行

```bash
npm install yaml            # 仅 check.mjs / extract.mjs 需要
node tools/validation/check.mjs .github/workflows/docker.yaml
node tools/validation/jqcheck.mjs
node tools/validation/extract.mjs .github/workflows/docker.yaml ./out
```

`jqcheck.mjs` 需要一个 jq 可执行文件，按以下顺序查找：

1. 环境变量 `JQ`
2. `tools/validation/bin/jq-windows-amd64.exe` / `jq.exe` / `jq`
3. `/usr/bin/jq`、`/usr/local/bin/jq`、`/opt/homebrew/bin/jq`
4. PATH 上的 `jq`

在 Windows 上取一份静态 jq：

```powershell
gh release download jq-1.7.1 --repo jqlang/jq --pattern "jq-windows-amd64.exe" --dir tools/validation/bin
```

## 背景

这些脚本是在排查「阿里云 ACR 拒绝 `application/vnd.oci.empty.v1+json`」时建立的：

- `platform_fingerprint` / `strip_attestations` 依赖 jq 的 `select()` 对 **缺失键** 的宽容语义
  （`.annotations["vnd.docker.reference.type"]` 在普通 manifest 上不存在，必须得到 `null` 而不是报错）；
- 真实 jq 的退出码和空输入行为（空输入文件 → 退出 0、无输出）直接决定 `set -e` 下会不会误判失败。

这两点靠读代码容易想当然，用真 jq 跑一遍才可靠。
