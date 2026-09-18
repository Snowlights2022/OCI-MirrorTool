# OCI Mirror Tool
这是一个由 GitHub Actions 驱动的 OCI/Docker 镜像同步工具。它从 `images.txt` 读取源镜像，使用 `skopeo` 在源 Registry 与阿里云容器镜像服务之间直接复制，不需要把镜像完整下载到 Runner 本地。

工作流支持公开镜像，也支持 Docker Hub、GHCR、GCR、Azure Container Registry 和 Amazon ECR 的私有镜像。对于带 buildx attestation 的 OCI 清单，工作流会先尝试完整复制；如果阿里云拒绝 attestation，则剔除证明清单，按平台复制后重新组装为完整的多架构 manifest list。

## 目录

- [前置条件](#前置条件)
- [快速开始](#快速开始)
- [镜像名称映射](#镜像名称映射)
- [拉取同步镜像](#拉取同步镜像)
- [Secrets 与私有 Registry](#secrets-与私有-registry)
- [阿里云配置](#阿里云配置)
- [Resend 邮件通知](#resend-邮件通知)
- [Attestation 与多架构行为](#attestation-与多架构行为)
- [常见问题](#常见问题)
- [本地验证](#本地验证)
- [支持范围](#支持范围)

## 前置条件

- 一个启用 GitHub Actions 的 GitHub 仓库；
- 一个可推送镜像的阿里云容器镜像服务命名空间；
- `images.txt` 中至少有一个有效的镜像引用；
- 如需同步私有源镜像，再配置对应 Registry 的凭据；
- 如需本地验证，准备 Node.js、Git Bash 或 WSL；本地 fixture 验证另外需要 `jq`。

本项目不需要本地 Docker daemon 才能执行同步。GitHub-hosted Runner 会安装 `skopeo`，并在 Registry 之间直接复制镜像清单和层。

## 快速开始

### 1. 配置必需 Secrets

在 GitHub 仓库中打开 `Settings` → `Secrets and variables` → `Actions`，至少创建以下 Secrets：

| Secret | 用途 |
|---|---|
| `ALIYUN_REGISTRY` | 阿里云 Registry 地址，例如 `registry.cn-hangzhou.aliyuncs.com` |
| `ALIYUN_NAME_SPACE` | 阿里云命名空间 |
| `ALIYUN_REGISTRY_USER` | 阿里云登录用户名 |
| `ALIYUN_REGISTRY_PASSWORD` | 阿里云密码或访问凭证 |
| `RESEND_API_KEY` | Resend API Key |
| `RESEND_SENDER_EMAIL` | 已在 Resend 验证的发件人邮箱 |
| `EMAIL_RECIPIENT` | 接收同步报告的邮箱 |

目标 Registry 登录失败是硬错误，工作流会立即失败并发送失败报告。邮件发送失败不会覆盖镜像同步结果。

### 2. 编辑镜像清单

每行写一个镜像引用，支持 tag、digest 和行尾注释。空行以及以 `#` 开头的行会被忽略。

```text
python:3.13-slim
ghcr.io/example/project:latest
nginx:1.27 # 行尾注释
ubuntu@sha256:<digest>
```

建议生产环境使用固定 digest；使用浮动 tag 时，工作流会通过源端和目标端的 digest 比对跳过未变化的镜像。

### 3. 运行工作流

`.github/workflows/docker.yaml` 支持三种触发方式：

- 在 `main` 分支修改 `images.txt` 后自动运行；
- 每 6 小时定时运行一次，时间为 UTC 的 20、02、08、14 点，即北京时间 04、10、16、22 点；
- 在 GitHub 仓库的 `Actions` 页面选择 `Docker Image Sync to Aliyun`，点击 `Run workflow` 手动运行。

同步结果会显示在 Actions 日志中，也会通过 Resend 发送邮件。任何镜像同步失败都会使 Job 标记为失败；邮件主题会区分成功、部分失败、全部失败和无新镜像四种情况。

### 工作流执行顺序

1. 检出仓库并安装 `skopeo`、AWS CLI。
2. 登录阿里云目标 Registry；目标端登录失败会立即终止同步。
3. 按 `images.txt` 逐行检查源镜像，必要时先登录对应的私有 Registry。
4. 比较源端和目标端摘要；一致的镜像跳过，不一致的镜像执行复制和重试。
5. 输出目标端清单形态，写入同步统计，并发送邮件报告。

其中源镜像认证失败只会影响对应镜像；目标 Registry 认证失败会使整个 Job 失败。工作流使用并发组避免两个同步任务同时推送同一批 tag。带 attestation 的镜像会先写入临时 tag，只有完整 manifest list 推送成功后才更新正式 tag。

## 镜像名称映射

阿里云目标镜像引用使用以下规则生成：

- 没有 `/` 的 Docker Hub 镜像会增加 `library_` 前缀；
- 其他镜像引用中的 `/` 会替换为 `_`；
- 原始 tag 会保留；
- 源镜像使用 digest 引用时，digest 只用于源端的精确检查和复制，不会拼接到目标镜像名称中；目标端未显式指定 tag 时使用默认的 `latest` tag。

| `images.txt` 中的源镜像 | 阿里云目标镜像 |
|---|---|
| `nginx:latest` | `registry.example.com/namespace/library_nginx:latest` |
| `bitnami/redis:7` | `registry.example.com/namespace/bitnami_redis:7` |
| `ghcr.io/owner/repo:tag` | `registry.example.com/namespace/ghcr.io_owner_repo:tag` |
| `mcr.microsoft.com/dotnet/aspnet:8.0` | `registry.example.com/namespace/mcr.microsoft.com_dotnet_aspnet:8.0` |
| `ubuntu@sha256:<digest>` | `registry.example.com/namespace/library_ubuntu:latest` |

其中 `registry.example.com` 对应 `ALIYUN_REGISTRY`，`namespace` 对应 `ALIYUN_NAME_SPACE`。

`images.txt` 支持使用源镜像 digest。工作流会使用完整的 `源镜像@digest` 引用执行检查和复制，因此只要 digest 存在、源 Registry 凭据正确且镜像格式受支持，使用 digest 本身不会导致同步失败。需要注意的是，digest 不会成为目标 tag；例如 `ubuntu@sha256:<digest>` 会写入 `library_ubuntu:latest`。因此不要在 `images.txt` 中同时配置同一源仓库的多个 digest，否则它们会竞争写入同一个目标 tag，后执行的同步可能覆盖先执行的结果。

## 拉取同步镜像

```bash
docker login registry.example.com
docker pull registry.example.com/namespace/library_nginx:latest
docker pull registry.example.com/namespace/bitnami_redis:7
```

对于源端本身包含多个平台的镜像，无论是否带 attestation，成功同步后正式 tag 都会发布为 manifest list/index。Docker 会根据当前平台自动选择对应镜像，因此 amd64、arm64 等平台使用完全相同的拉取命令，不需要手动指定平台或 digest。

```bash
docker pull registry.example.com/namespace/bitnami_redis:7
```

如果多平台源镜像无法重建完整的多架构清单，工作流会报告失败并保留原正式 tag，不会发布一个只适用于单个平台的新 tag。源端本身只有一个平台的镜像仍然只能在该平台运行，工具不会替它生成不存在的架构。

在 Docker Compose 中使用目标端地址：

```yaml
services:
  app:
    image: registry.example.com/namespace/bitnami_redis:7
```

### jq 是什么？

`jq` 是 GitHub Actions Runner 上使用的 JSON 处理工具。这个 workflow 用它读取 OCI/Docker manifest，过滤 buildx attestation，提取 `os`、`architecture`、`variant` 和 digest，并比较源端与目标端是否一致。

它是同步实现的内部依赖，不是镜像运行时依赖。普通使用者不需要在 `docker pull` 时安装或执行 `jq`；只有在本地运行 fixture 验证脚本时才需要准备 jq。

## Secrets 与私有 Registry

公开镜像无需额外认证。以下 Secrets 只在 `images.txt` 包含对应 Registry 的私有镜像时配置。

### Docker Hub

| Secret | 说明 |
|---|---|
| `DOCKERHUB_USERNAME` | Docker Hub 用户名 |
| `DOCKERHUB_PASSWORD` | 密码或 Access Token |

### GitHub Container Registry

当前 workflow 中的 `GITHUB_TOKEN` 是 GitHub Actions 自动提供的工作流 Token，不需要也不应手动创建同名 Secret。它可用于读取当前仓库或当前工作流有权限访问的 GHCR 包，另外还需要目标包本身授予该仓库访问权限。

如果要访问其他组织或账号下的私有 GHCR 镜像，当前 workflow 没有独立的 PAT 配置入口。应先将 workflow 改为使用专用的 `GHCR_TOKEN` 和 `GHCR_USERNAME` Secrets，再配置一个具有 `read:packages` 权限且已获目标包授权的 PAT；不要假设创建名为 `GITHUB_TOKEN` 的 Secret 就能覆盖 GitHub 自动注入的 Token。

### Google Container Registry

| Secret | 说明 |
|---|---|
| `GCP_SERVICE_ACCOUNT_KEY` | GCP 服务账号 JSON Key，需具备目标镜像的读取权限 |

### Azure Container Registry

| Secret | 说明 |
|---|---|
| `AZURE_CLIENT_ID` | 服务主体 Client ID |
| `AZURE_CLIENT_SECRET` | 服务主体 Secret |
| `AZURE_TENANT_ID` | Azure 租户 ID |
| `AZURE_REGISTRY_NAME` | ACR 名称，不含 `.azurecr.io` |

`mcr.microsoft.com` 是公开 Registry，不需要 Azure Secret。私有 ACR 登录依赖 GitHub-hosted Ubuntu Runner 中可用的 Azure CLI。

### Amazon ECR

| Secret | 说明 |
|---|---|
| `AWS_ACCESS_KEY_ID` | AWS Access Key ID |
| `AWS_SECRET_ACCESS_KEY` | AWS Secret Access Key |
| `AWS_REGION` | ECR 所在区域，例如 `us-east-1` |

工作流会在第一次读取 ECR 源镜像清单之前执行 `aws ecr get-login-password` 登录。建议使用只读权限最小化的 IAM 用户或角色。

## 阿里云配置

1. 登录[阿里云容器镜像服务控制台](https://cr.console.aliyun.com/)并确认 Registry 地址。
2. 创建命名空间，并将其名称填入 `ALIYUN_NAME_SPACE`。
3. 创建具备目标仓库推送和读取权限的 RAM 凭证。
4. 将 Registry 地址、命名空间、用户名和密码写入 GitHub Secrets。

建议使用 RAM 子账号或专用访问凭证，不要把密码直接写进 `images.txt`、workflow 或邮件内容。

## Resend 邮件通知

1. 在 [Resend](https://resend.com/) 创建 API Key。
2. 验证一个发件人域名或邮箱。
3. 配置 `RESEND_API_KEY`、`RESEND_SENDER_EMAIL` 和 `EMAIL_RECIPIENT`。

邮件报告包含成功、跳过、失败数量、逐镜像结果以及 GitHub Actions 运行链接。邮件发送失败只会在日志中告警，不会改变同步步骤的成功或失败状态。

## Attestation 与多架构行为

### Q1：为什么完整复制会报 `unknown manifest class for application/vnd.oci.empty.v1+json`？

这是上游镜像的 provenance 或 SBOM attestation 清单被阿里云 Registry 拒绝，不是普通的登录失败。buildx 生成的 attestation 常使用 `application/vnd.oci.empty.v1+json` 作为 config，部分阿里云 ACR 实例不接受这类制品。

### Q2：工作流如何处理这类镜像？

`copy_image()` 使用两级策略：

1. 先使用 `skopeo copy --all` 尝试原样复制，以保留普通镜像的完整多架构清单；
2. 失败后过滤 `unknown` 平台和 attestation 子清单，优先尝试精确平台列表重建；
3. 如果 Runner 自带的旧版 skopeo 不支持平台列表，则把每个平台复制到唯一临时 tag，再使用 Docker manifest list 重新组装正式 tag；每个平台最多重试 3 次。

只有正式 manifest list 推送成功后才算同步成功。这样最终正式 tag 仍然可以被所有支持的 Docker 平台用同一条 `docker pull` 命令拉取；如果重建失败，本次同步失败，正式 tag 保持原状态。

### Q3：为什么不直接升级 skopeo？

上游 release 没有适用于此 Runner 的稳定预编译二进制。从官方容器镜像复制二进制时还会遇到 Debian 与 Ubuntu 的运行库差异。为了避免升级步骤本身让整个同步任务失效，工作流目前使用系统版本，并保留临时 tag + manifest list 重建路径。

如果是自己构建的镜像，可以在 buildx 中关闭证明清单：

```yaml
with:
  provenance: false
  sbom: false
```

### Q4：如何确认目标端仍是多架构清单？

```bash
skopeo inspect --raw docker://registry.example.com/namespace/image:tag \
  | jq '.mediaType, (.manifests[]? | "\(.platform.os)/\(.platform.architecture): \(.digest)")'
```

输出中应包含 `manifests` 和多个真实平台记录，并且不应出现 `unknown/unknown` 的 attestation 条目。这个命令用于排障，不是日常拉取镜像的必要步骤。

### Q5：为什么同步失败而不是发布单平台 tag？

项目的目标是让正式 tag 在不同平台上使用同一条拉取命令。逐个平台直接写入同一个 tag 会让后写入的平台覆盖先前平台，因此 workflow 不再接受这种结果。

当某个平台复制失败、manifest list 创建失败、平台标注失败或最终推送失败时，workflow 会返回失败，并尽量保留旧正式 tag。已经上传的临时 tag 由 Registry 生命周期规则清理，不会被当作正式镜像使用。

### Q6：临时 tag 会不会影响正常使用？

不会。临时 tag 只用于重建期间暂存单个平台，正式 tag 只有在完整 manifest list 推送成功后才更新。临时 tag 使用 workflow run 唯一标识生成，建议在阿里云容器镜像服务中配置生命周期规则定期清理。

## 常见问题

### Q7：为什么 GitHub Actions Job 失败但邮件仍然发送？

同步步骤会先把统计结果写入 `$GITHUB_ENV`，再以非零状态结束。状态转储和邮件步骤使用 `if: always()`，因此即使同步失败，也会继续输出目标端状态并发送报告。

### Q8：为什么镜像没有被重新同步？

工作流会比较源端与目标端的内容摘要。多架构镜像比较真实平台的 digest，并忽略 attestation；单架构镜像比较 config digest。摘要一致时日志会显示 `Skip (digest 一致)`。

### Q9：私有镜像出现 `unauthorized` 怎么办？

确认对应 Registry 的 Secret 已配置，Token 或服务账号具有读取权限，并检查日志中的 Registry 地址。ECR 会在源端 `inspect` 之前登录；GHCR 外部私有包需要带 `read:packages` 的 PAT。

### Q10：邮件主题为什么分成四种？

邮件步骤直接读取前一步通过 `$GITHUB_ENV` 写入的 shell 变量：

- 有成功且有失败：部分失败；
- 只有失败：同步失败；
- 有成功且无失败：同步成功；
- 没有成功或失败：无新镜像，通常表示全部跳过。

## 本地验证

本地验证脚本位于 [`tools/validation/README.md`](tools/validation/README.md)，可检查 YAML 结构、jq 清单处理逻辑和提取后的 Shell 脚本。

```bash
npm install --no-save yaml
node tools/validation/check.mjs .github/workflows/docker.yaml
node tools/validation/jqcheck.mjs
node tools/validation/extract.mjs .github/workflows/docker.yaml ./out
bash -n ./out/sync.sh
bash -n ./out/mail.sh
```

`jqcheck.mjs` 需要本机可用的 `jq`。Windows 下载方式和查找顺序请参阅验证工具文档。`out/` 只用于本地检查，不应提交到仓库。

Windows 推荐在 Git Bash 或 PowerShell 中先安装依赖，再执行检查：

```powershell
npm install --no-save yaml
gh release download jq-1.7.1 --repo jqlang/jq --pattern "jq-windows-amd64.exe" --dir tools/validation/bin
node tools/validation/check.mjs .github/workflows/docker.yaml
node tools/validation/jqcheck.mjs
node tools/validation/extract.mjs .github/workflows/docker.yaml ./out
bash -n ./out/sync.sh
bash -n ./out/mail.sh
```

这里的 `gh` 命令来自 GitHub CLI；也可以手动下载 jq，并通过 `JQ` 环境变量指定可执行文件路径。验证脚本只做静态检查和 fixture 测试，不会登录 Registry、拉取镜像或推送镜像。

## 支持范围

| Registry | 公开镜像 | 私有镜像 | 认证方式 |
|---|---:|---:|---|
| Docker Hub | ✅ | ✅ | 用户名 + 密码或 Access Token |
| GitHub Container Registry | ✅ | ✅ | Actions Token 或 `read:packages` PAT |
| Google Container Registry | ✅ | ✅ | 服务账号 JSON Key |
| Microsoft Container Registry | ✅ | ❌ | 无需认证 |
| Azure Container Registry | ✅ | ✅ | Azure 服务主体 |
| Amazon ECR | ✅ | ✅ | AWS 访问密钥 |
| 其他公开 OCI Registry | ✅ | 视 Registry 而定 | 工作流不提供通用私有 Registry 凭据入口 |
