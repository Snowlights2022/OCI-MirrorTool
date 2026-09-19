# 镜像同步原理与实现

本文档说明 OCI Mirror Tool 的内部工作方式，适合需要排查同步失败、理解多架构镜像行为或维护 workflow 的开发者。首次部署请先阅读 [README.md](README.md)；本文档不替代部署步骤。

## 1. 整体数据流

一次同步包含以下组件：

```text
images.txt
    |
    v
GitHub Actions Runner
    |-- 读取并解析镜像引用
    |-- 登录源 Registry
    |-- skopeo inspect
    |-- 比较源端和目标端摘要
    |-- skopeo copy / manifest 重建
    v
阿里云 Registry
    |
    v
Resend API -> 同步结果邮件
```

镜像层和 manifest 由 Skopeo 在 Registry 之间直接复制，工作流不会把完整镜像下载到本地再重新上传。Runner 本地的 Docker 主要用于登录、Buildx/manifest 预检，以及多架构 fallback 时创建和推送 manifest list。

## 2. Workflow 生命周期

workflow 文件为 `.github/workflows/docker.yaml`，名称为 `Docker Image Sync to Aliyun`。

### 触发方式

- `push`：只有推送到 `main` 分支且变更包含 `images.txt` 时触发。
- `schedule`：cron 为 `0 20,2,8,14 * * *`，即每 6 小时运行一次。
- `workflow_dispatch`：Actions 页面手动运行，不包含输入参数，只同步当前版本的 `images.txt`。

Job 使用 `ubuntu-latest`，超时时间为 60 分钟，并通过 `concurrency.group: oci-mirror-sync` 保证同一时间只有一个同步任务。等待中的任务不会取消正在运行的任务。

### 执行阶段

1. 检出仓库。
2. 安装 Skopeo、Python pip 和 AWS CLI。
3. 调整 Runner 磁盘空间并重启 Docker。
4. 预检 Docker manifest、Docker Buildx 和 Skopeo。
5. 登录阿里云目标 Registry。
6. 按 `images.txt` 逐行解析、检查和同步源镜像。
7. 转储阿里云目标端的 manifest 状态。
8. 通过 Resend 发送同步报告。

状态转储和邮件步骤使用 `if: always()`，因此同步步骤失败后仍会执行。Resend 是部署所需的功能，三个 Resend Secrets 应始终配置；当前实现中 Resend HTTP 请求失败会输出警告，但不会覆盖镜像同步步骤已经产生的成功或失败状态。

## 3. 输入解析

工作流逐行读取 `images.txt`：

- 空行会跳过；
- 去除前导空白后以 `#` 开头的行会跳过；
- 每行只取第一个空白分隔字段作为镜像引用，因此支持行尾注释；
- 支持 tag 引用，例如 `sengokucola/maibot:main`；
- 支持 digest 引用，例如 `ubuntu@sha256:<digest>`。

代码会同时生成两个源引用：

- `full_image`：去掉 `@digest` 的镜像名称，用于生成目标名称；
- `src_ref`：保留完整 digest 的源引用，用于 `skopeo inspect` 和复制。

因此，使用 digest 作为源引用不会因为格式本身而必然失败。失败仍可能来自 digest 不存在、源 Registry 认证失败、源镜像格式不受支持或目标 Registry 拒绝某些制品。

## 4. 目标名称映射

目标引用由以下格式组成：

```text
${ALIYUN_REGISTRY}/${ALIYUN_NAME_SPACE}/${repo_name}
```

`repo_name` 的生成规则由 workflow 中的镜像名称处理逻辑决定：

1. 如果 `full_image` 不包含 `/`，增加 `library_` 前缀。
2. 如果包含 `/`，将所有 `/` 替换为 `_`。
3. 源 tag 保留在名称末尾。
4. digest 不参与目标名称生成。

示例：

| 源引用 | 目标名称部分 |
|---|---|
| `nginx:latest` | `library_nginx:latest` |
| `bitnami/redis:7` | `bitnami_redis:7` |
| `sengokucola/maibot:main` | `sengokucola_maibot:main` |
| `sengokucola/maibot:dev` | `sengokucola_maibot:dev` |
| `ghcr.io/owner/repo:tag` | `ghcr.io_owner_repo:tag` |
| `ubuntu@sha256:<digest>` | `library_ubuntu:latest` |

这意味着 `sengokucola/maibot:main`、`sengokucola/maibot:dev` 和 `sengokucola/maibot:latest` 会分别写入三个目标 tag，不会互相改名。

同一源仓库的多个不同 digest 会映射到同一个目标 tag。workflow 不会为 digest 自动创建独立的目标 tag，因此不应同时配置同一仓库的多个 digest，否则后处理的条目可能覆盖先处理的条目。

## 5. 认证模型

### 目标 Registry

阿里云目标 Registry 是同步硬依赖。workflow 首先使用以下四个 Secrets 执行 Docker 登录：

- `ALIYUN_REGISTRY`
- `ALIYUN_NAME_SPACE`
- `ALIYUN_REGISTRY_USER`
- `ALIYUN_REGISTRY_PASSWORD`

目标登录失败后，同步步骤会写入失败统计并退出，不再处理镜像。

### 源 Registry

公开源镜像不需要额外认证。workflow 根据镜像地址和 Secrets 尝试登录以下私有源：

| 源 Registry | 登录条件 | 说明 |
|---|---|---|
| Docker Hub | `DOCKERHUB_USERNAME` 和 `DOCKERHUB_PASSWORD` 同时存在 | 登录 `docker.io` |
| GHCR | `GITHUB_TOKEN` 存在 | 使用 GitHub Actions 自动提供的 Token |
| GCR | `GCP_SERVICE_ACCOUNT_KEY` 存在 | 当前只登录 `gcr.io` |
| ACR | 四个 Azure Secret 都存在 | 使用 Azure CLI 登录指定 ACR |
| ECR | 三个 AWS Secret 都存在且主机名匹配 | 在第一次读取 ECR 源镜像前登录对应 Registry |

源 Registry 登录失败通常只影响对应源镜像。workflow 会继续处理后续条目，最终将该镜像计入失败数量。

当前没有通用的私有 Registry 用户名和密码入口。其他公开 OCI Registry 可以尝试直接访问，但其他私有 Registry 需要先扩展 workflow 的认证逻辑。

GHCR 使用的是 workflow 运行上下文中的 `GITHUB_TOKEN`。它能否读取某个私有包取决于当前仓库和目标包的权限关系；不能简单通过创建同名 Secret 替换自动注入的 Token。

## 6. 摘要比较与跳过

同步前，workflow 会使用 `skopeo inspect --raw` 读取源端 manifest，并尝试读取目标端 manifest，然后调用 `is_up_to_date()` 比较摘要。

### 多架构镜像

`platform_fingerprint()` 会提取每个真实平台的：

```text
os/architecture/variant:digest
```

然后排序并拼接为可比较的字符串。以下条目不会参与比较：

- `platform.os == "unknown"` 的条目；
- annotation `vnd.docker.reference.type == "attestation-manifest"` 的条目。

这样，buildx provenance 或 SBOM attestation 的变化不会单独触发普通镜像重新同步。

### 单架构镜像

如果清单中没有可提取的平台列表，workflow 会回退到比较 manifest 的 `config.digest`。

源端和目标端摘要完全一致时，日志会显示：

```text
Skip (digest 一致)
```

跳过不会增加成功数或失败数，只会增加跳过数。

## 7. 镜像复制策略

核心函数是 `copy_image()`，实际顺序如下：

### 第一步：原样复制

先执行一次带 `--all` 的 Skopeo 复制：

```text
skopeo copy ... --all
```

这条路径适用于普通镜像，并尽可能保留源端完整的多架构 manifest list/index。它只尝试一次，因为带有目标 Registry 不接受的 attestation 时，重复相同命令不会解决清单格式问题。

### 第二步：多架构 fallback

如果原样复制失败，workflow 会：

1. 过滤 `unknown` 平台和 attestation 子清单；
2. 提取真实平台的 `os`、`architecture` 和 `variant`；
3. 先尝试使用精确的平台列表执行 Skopeo 多架构复制；
4. 如果当前 Runner 的 Skopeo 不支持该平台列表参数，则进入临时 tag fallback。

精确平台复制成功后，目标正式 tag 直接成为不含 attestation 的完整多架构清单。

### 临时 tag fallback

临时 tag 只在原样复制和平台列表复制都失败后使用。每个平台会被复制到独立的临时 tag，例如：

```text
mirror-tmp-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${target_key}-${platform_index}
```

每个平台最多尝试 3 次，每次失败后等待 10 秒。所有平台临时 tag 都上传成功后，workflow 执行：

1. `docker manifest create` 创建目标 manifest list；
2. `docker manifest annotate` 写入每个平台的 OS、架构和 variant；
3. `docker manifest push --purge` 推送正式目标 tag。

正式 tag 只有在 manifest 创建、平台标注和最终 push 全部成功后才会被更新。

## 8. Attestation 与多架构清单

现代容器构建工具可能为镜像附加 provenance 或 SBOM attestation。它们通常会在 index 中表现为 `unknown/unknown` 平台，并可能使用：

```text
application/vnd.oci.empty.v1+json
```

部分阿里云 Registry 实例不接受这类 manifest class，因此整份复制可能失败。workflow 不会把这些 attestation 当作普通运行平台，而是在 fallback 中将其过滤掉。

过滤后保留的清单只使用以下平台字段：

- `os`
- `architecture`
- `variant`

当前重建逻辑没有完整处理 Windows 的 `os.version`、`os.features` 等额外平台元数据。因此常见 Linux `amd64`、`arm64` 和 variant 场景是主要支持范围。

如果所有 fallback 步骤都失败，workflow 会将该镜像标记为失败，不会故意发布一个只适用于最后一个平台的正式 tag。这样可以避免同一个正式 tag 在不同平台之间被逐次覆盖。

## 9. 失败语义与一致性

### 目标登录失败

目标 Registry 登录是整个同步步骤的硬依赖。登录失败后不会继续处理镜像，失败统计会写入 `$GITHUB_ENV`，以便后续状态和邮件步骤使用。

### 单个源镜像失败

单个源镜像认证、inspect 或复制失败时，workflow 会记录该镜像失败，然后继续处理 `images.txt` 中的其他镜像。

### 多架构 fallback 失败

以下任一环节失败都会使该镜像同步失败：

- 平台提取失败；
- 某个平台复制在 3 次尝试后仍失败；
- manifest list 创建失败；
- 平台标注失败；
- manifest list 最终推送失败。

fallback 失败时不会发布一个新的单平台正式 tag。已经上传的临时 tag 不会被当作正式镜像使用，后续依赖阿里云 Registry 的生命周期规则清理。

### Job 最终状态

所有镜像处理完成后，只要失败计数大于 0，同步步骤就以非零状态退出，Job 标记为失败。状态转储和 Resend 步骤仍会执行。

## 10. 统计与邮件通知

workflow 会通过 `$GITHUB_ENV` 在步骤之间传递以下数据：

- `SUCCESS_COUNT`：成功同步数量；
- `FAILURE_COUNT`：失败数量；
- `SKIPPED_COUNT`：摘要一致而跳过的数量；
- `SYNC_RESULT`：逐镜像结果。

Resend 邮件主题根据统计结果分为四类：

- 有成功且有失败：部分失败；
- 只有失败：同步失败；
- 有成功且无失败：同步成功；
- 没有成功或失败：无新镜像，通常表示全部跳过。

邮件步骤使用 `if: always()`，因此同步步骤失败时仍然会执行。发送内容包括统计、逐镜像结果和 GitHub Actions 运行链接。

Resend 的三个 Secrets 是项目部署要求的一部分：

- `RESEND_API_KEY`
- `RESEND_SENDER_EMAIL`
- `EMAIL_RECIPIENT`

当前 workflow 对 Resend API 使用失败只输出警告，不会重新修改已经确定的同步 Job 状态。

## 11. 高级排障

### 查看目标 manifest

可以使用 Docker Buildx：

```bash
docker buildx imagetools inspect \
  ${ALIYUN_REGISTRY}/${ALIYUN_NAME_SPACE}/sengokucola_maibot:main
```

也可以使用 Docker manifest：

```bash
docker manifest inspect \
  ${ALIYUN_REGISTRY}/${ALIYUN_NAME_SPACE}/sengokucola_maibot:main
```

输出包含多个真实平台时，Docker 会在拉取时根据当前平台选择对应镜像。

### 查看原始 manifest

Skopeo 和 jq 仅用于高级排障，不是普通拉取依赖：

```bash
skopeo inspect --raw \
  docker://${ALIYUN_REGISTRY}/${ALIYUN_NAME_SPACE}/sengokucola_maibot:main \
  | jq '.mediaType, (.manifests[]? | "\(.platform.os)/\(.platform.architecture): \(.digest)")'
```

重点检查：

- 是否存在 `manifests` 数组；
- 是否包含预期的 `linux/amd64`、`linux/arm64` 等平台；
- 是否仍然存在 `unknown/unknown` 条目；
- 目标 Registry 是否返回 manifest unknown、unauthorized 或 blob unknown。

### 根据日志判断阶段

- `阿里云镜像仓库登录失败`：目标凭据或 Registry 地址有问题；
- `Skip (digest 一致)`：目标已经与源端摘要一致；
- `策略 1/2: 整份复制`：正在尝试普通 `--all` 复制；
- `多架构重建`：正在尝试去除 attestation 后的多架构复制；
- `按平台推送到临时 tag`：已经进入最后的逐平台 fallback；
- `manifest list 创建失败`、`平台标注失败` 或 `manifest list 推送失败`：多架构清单重建阶段失败。

## 12. 支持边界

当前实现的主要支持范围：

- GitHub-hosted Ubuntu Runner；
- Docker Hub、当前权限可访问的 GHCR、`gcr.io`、标准 ACR 和标准 ECR 私有源；
- 常见 Linux 多架构镜像；
- 阿里云 Registry 作为目标端；
- Resend 作为同步报告渠道。

以下内容不由当前 workflow 自动处理：

- 任意私有 OCI Registry 的通用登录；
- `us.gcr.io`、`eu.gcr.io`、`asia.gcr.io` 等 GCR 区域地址的自动登录；
- 完整 Windows `os.version` 和 `os.features` 元数据重建；
- 本地 Docker daemon 代替 GitHub Actions Runner 执行同步；
- 本机对真实阿里云 Registry、私有 Registry、Resend API 的集成测试。
