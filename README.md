# OCI Mirror Tool

OCI Mirror Tool 使用 GitHub Actions 和 Skopeo，将 `images.txt` 中的镜像同步到阿里云容器镜像服务（ACR）。同步完成后，用户直接从阿里云 Registry 拉取镜像。

项目同时提供 Resend 邮件通知。Resend 是本项目的必需功能，首次部署时必须配置对应的邮件 Secrets。

如果你需要了解 digest 比较、attestation 过滤、多架构清单重建和临时 tag，请阅读[同步原理与实现](IMAGE-SYNC-ARCHITECTURE.md)。

## 工作流程

```text
images.txt
    -> GitHub Actions
    -> 源 Registry
    -> 阿里云 Registry
    -> Resend 同步报告
```

同步任务运行在 GitHub-hosted Ubuntu Runner 上，不需要在本地安装 Docker、Skopeo 或 jq 才能完成部署和拉取。

## 快速部署

### 1. Fork 仓库

点击本项目 GitHub 页面右上角的 `Fork`，将仓库复制到你自己的 GitHub 账号或组织下。后续的 workflow 会运行在你的 Fork 仓库中，不会使用上游仓库的 Actions 运行配额、Secrets 或镜像配置。

Fork 完成后，在你的 Fork 仓库中确认以下文件存在：

```text
images.txt
.github/workflows/docker.yaml
```

如果 Fork 后 `Actions` 页面提示工作流被禁用，请先点击启用 GitHub Actions。GitHub 不会把上游仓库的 Secrets 自动复制到 Fork，因此下一步需要在你的 Fork 中重新配置全部必需 Secrets。

公开仓库使用 GitHub-hosted Runner 时，Fork 的 workflow 运行归属于 Fork 所属账号或组织；上游仓库不会承担这些运行。实际可用的免费额度、分钟数和计费规则由 Fork 所属账号或组织的 GitHub 计划决定。

工作流文件已经包含同步逻辑，不需要额外创建构建脚本或本地运行环境。

### 2. 配置必需 Secrets

在 GitHub 仓库中打开 `Settings` -> `Secrets and variables` -> `Actions`，创建下表中的全部 Secrets。

#### 阿里云目标 Registry

| Secret | 用途 |
|---|---|
| `ALIYUN_REGISTRY` | 阿里云 Registry 地址，例如 `registry.cn-hangzhou.aliyuncs.com` |
| `ALIYUN_NAME_SPACE` | 阿里云命名空间 |
| `ALIYUN_REGISTRY_USER` | 阿里云登录用户名 |
| `ALIYUN_REGISTRY_PASSWORD` | 阿里云密码或访问凭证 |

#### Resend 邮件通知

| Secret | 用途 |
|---|---|
| `RESEND_API_KEY` | Resend API Key |
| `RESEND_SENDER_EMAIL` | 已在 Resend 验证的发件人邮箱 |
| `EMAIL_RECIPIENT` | 同步报告接收邮箱 |

Resend 配置是部署必需项。工作流会在同步步骤结束后发送报告，即使某个镜像同步失败也会继续发送。当前实现中，Resend 请求失败会记录警告，但不会覆盖镜像同步步骤本身的成功或失败状态。

### 3. 编辑 `images.txt`

每行写一个源镜像引用。支持 tag、digest 和行尾注释；空行以及以 `#` 开头的行会被忽略。

```text
# Docker Hub 官方镜像
python:3.13-slim

# tag 会原样映射到目标端
sengokucola/maibot:main
sengokucola/maibot:dev
sengokucola/maibot:latest

# 行尾注释
nginx:1.27 # production image

# 也支持 digest
ubuntu@sha256:<digest>
```

当前仓库中未被注释的镜像会参与同步，以 `#` 开头的 Registry 示例只是注释，不会参与同步。

### 4. 触发同步

工作流名称为 `Docker Image Sync to Aliyun`，支持以下触发方式：

- 推送到 `main` 分支，且本次变更包含 `images.txt`；
- 定时运行，每 6 小时一次：UTC 时间 02:00、08:00、14:00、20:00；
- 在仓库的 `Actions` 页面手动运行 `Docker Image Sync to Aliyun`。

手动运行没有输入参数，只会按照当前版本的 `images.txt` 同步。修改 README 或 workflow 文件本身不会触发 `push` 条件下的自动同步，可以使用手动运行验证。

### 5. 查看结果

同步结果可以在 GitHub Actions 日志中查看，Resend 会发送包含统计信息和运行链接的报告。

统计结果包括：

- 成功同步的镜像数量；
- 因摘要一致而跳过的镜像数量；
- 同步失败的镜像数量。

任意镜像同步失败都会使同步步骤和 Job 标记为失败，但后续状态转储和邮件步骤仍会执行。

## 镜像名称映射

目标镜像完整地址为：

```text
${ALIYUN_REGISTRY}/${ALIYUN_NAME_SPACE}/${映射后的镜像名}
```

映射规则如下：

- 源引用不包含 `/` 时，增加 `library_` 前缀；
- 源引用包含 `/` 时，将所有 `/` 替换为 `_`；
- 源 tag 原样保留；
- 源引用中的 digest 用于精确读取和复制，不会拼接到目标镜像名；
- 源引用没有显式 tag 时，目标端使用 `latest`。

例如：

| 源镜像 | 目标镜像 |
|---|---|
| `sengokucola/maibot:main` | `${ALIYUN_REGISTRY}/${ALIYUN_NAME_SPACE}/sengokucola_maibot:main` |
| `sengokucola/maibot:dev` | `${ALIYUN_REGISTRY}/${ALIYUN_NAME_SPACE}/sengokucola_maibot:dev` |
| `sengokucola/maibot:latest` | `${ALIYUN_REGISTRY}/${ALIYUN_NAME_SPACE}/sengokucola_maibot:latest` |
| `nginx:latest` | `${ALIYUN_REGISTRY}/${ALIYUN_NAME_SPACE}/library_nginx:latest` |
| `bitnami/redis:7` | `${ALIYUN_REGISTRY}/${ALIYUN_NAME_SPACE}/bitnami_redis:7` |
| `ghcr.io/owner/repo:tag` | `${ALIYUN_REGISTRY}/${ALIYUN_NAME_SPACE}/ghcr.io_owner_repo:tag` |
| `ubuntu@sha256:<digest>` | `${ALIYUN_REGISTRY}/${ALIYUN_NAME_SPACE}/library_ubuntu:latest` |

因此，`main` 就是 `main`，`dev` 就是 `dev`，不会自动改成其他 tag。

同一源仓库不应在 `images.txt` 中配置多个不同 digest，因为这些 digest 会映射到同一个目标 tag，后处理的条目可能覆盖先处理的条目。

## 拉取同步镜像

在本地 Shell 中先设置目标 Registry 和命名空间，再登录阿里云 Registry。下面的变量需要替换为你自己的值：

```bash
export ALIYUN_REGISTRY=registry.cn-hangzhou.aliyuncs.com
export ALIYUN_NAME_SPACE=your-namespace

docker login ${ALIYUN_REGISTRY}
docker pull ${ALIYUN_REGISTRY}/${ALIYUN_NAME_SPACE}/sengokucola_maibot:main
docker pull ${ALIYUN_REGISTRY}/${ALIYUN_NAME_SPACE}/sengokucola_maibot:dev
docker pull ${ALIYUN_REGISTRY}/${ALIYUN_NAME_SPACE}/sengokucola_maibot:latest
```

对于源端包含多个平台的镜像，成功同步后正式 tag 会发布为 manifest list/index。Docker 会根据当前平台自动选择对应镜像，因此 amd64、arm64 等平台可以使用同一条 `docker pull` 命令。

在 Docker Compose 中使用目标地址：

```yaml
services:
  app:
    image: registry.cn-hangzhou.aliyuncs.com/your-namespace/sengokucola_maibot:main
```

将示例中的 Registry 地址和命名空间替换为实际值。

普通使用者不需要安装或执行 Skopeo、jq，也不需要手动指定平台或 digest。

## 私有源镜像配置

公开源镜像不需要额外的源 Registry 凭据。只有 `images.txt` 中包含私有源镜像时，才需要配置对应的 Secrets。

| 源 Registry | Secrets | 适用范围 |
|---|---|---|
| Docker Hub | `DOCKERHUB_USERNAME`、`DOCKERHUB_PASSWORD` | Docker Hub 私有镜像 |
| GitHub Container Registry | 工作流自动提供的 `GITHUB_TOKEN` | 当前仓库有权限读取的 GHCR 包 |
| Google Container Registry | `GCP_SERVICE_ACCOUNT_KEY` | `gcr.io` 私有镜像 |
| Azure Container Registry | `AZURE_CLIENT_ID`、`AZURE_CLIENT_SECRET`、`AZURE_TENANT_ID`、`AZURE_REGISTRY_NAME` | 标准 `*.azurecr.io` 私有镜像 |
| Amazon ECR | `AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`、`AWS_REGION` | 标准 `*.dkr.ecr.*.amazonaws.com` 镜像 |

补充说明：

- 其他组织或账号下的私有 GHCR 包需要 workflow 具备相应的包访问权限；当前 workflow 没有独立的 GHCR PAT 配置入口。
- 当前 GCR 登录逻辑只匹配 `gcr.io`，不会自动覆盖 `us.gcr.io`、`eu.gcr.io` 或 `asia.gcr.io`。
- `mcr.microsoft.com` 是公开 Registry，不需要 Azure Secrets。
- 其他公开 OCI Registry 通常可以尝试同步，但 workflow 没有通用的私有 Registry 用户名和密码配置入口。

## 常见问题

### 修改 `images.txt` 后没有运行

确认修改已经推送到 `main` 分支，并且变更确实包含 `images.txt`。修改 README、workflow 或其他文件不会触发 `push` 条件下的同步。也可以从 Actions 页面手动运行。

### 目标 Registry 登录失败

检查以下四个 Secrets 的名称和值：

```text
ALIYUN_REGISTRY
ALIYUN_NAME_SPACE
ALIYUN_REGISTRY_USER
ALIYUN_REGISTRY_PASSWORD
```

目标端登录失败会立即终止同步循环，但状态和邮件步骤仍会执行。

### 源镜像出现 `unauthorized`

确认源 Registry 的 Secrets 已配置，并且该凭据可以读取对应镜像。公开镜像不需要配置源凭据；私有 Docker Hub、GHCR、GCR、ACR 和 ECR 需要按上表配置。

### 镜像显示为 `Skip (digest 一致)`

这表示源端和目标端的内容摘要一致，工作流没有重复复制。tag 没有变化并不代表内容一定变化，工作流会比较实际摘要。

### 多架构镜像同步失败

工作流不会发布一个只适用于单个平台的新正式 tag。请先查看 Actions 日志；需要进一步理解 attestation、manifest list 或 fallback 时，阅读[同步原理与实现](IMAGE-SYNC-ARCHITECTURE.md)。

## 深入阅读

- [同步原理与实现](IMAGE-SYNC-ARCHITECTURE.md)：详细说明输入解析、目标命名、认证、摘要比较、attestation、多架构重建、临时 tag 和失败语义。
- [镜像清单](images.txt)：当前实际使用的镜像和可参考的 Registry 写法。
- [同步工作流](.github/workflows/docker.yaml)：GitHub Actions 的实际执行逻辑。

## 支持范围

| Registry | 公开镜像 | 私有镜像 | 认证方式 |
|---|---:|---:|---|
| Docker Hub | 是 | 是 | 用户名和密码或 Access Token |
| GitHub Container Registry | 是 | 受当前仓库权限限制 | Actions Token |
| Google Container Registry | 是 | 是 | 服务账号 JSON Key |
| Microsoft Container Registry | 是 | 否 | 无需认证 |
| Azure Container Registry | 是 | 是 | Azure 服务主体 |
| Amazon ECR | 是 | 是 | AWS 访问密钥 |
| 其他公开 OCI Registry | 是 | 视 Registry 而定 | 无通用私有 Registry 凭据入口 |
