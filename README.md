# Docker 镜像同步到阿里云 - 使用指南

本文档详细说明如何配置 GitHub Actions 工作流，以及如何在 Docker 中拉取不同注册表的镜像。

---

## 📋 目录

- [一、GitHub Secrets 配置](#一github-secrets-配置)
- [二、阿里云容器镜像服务配置](#二阿里云容器镜像服务配置)
- [三、使用ReSend配置邮件通知](#三使用ReSend配置邮件通知)
- [四、从阿里云拉取同步镜像](#四从阿里云容器镜像服务拉取同步镜像)
- [五、常见问题](#五常见问题)

---

## 一、GitHub Secrets 配置

在 GitHub 仓库中配置以下 Secrets，路径：`Settings` → `Secrets and variables` → `Actions` → `New repository secret`

### 1.1 阿里云相关配置

| Secret 名称 | 说明 | 样例值 | 必填 |
|---|---|---|---|
| `ALIYUN_REGISTRY` | 阿里云容器镜像服务地址 | `your-registry.example.com` | ✅ |
| `ALIYUN_NAME_SPACE` | 阿里容器的命名空间（仓库组） | `my-namespace` | ✅ |
| `ALIYUN_REGISTRY_USER` | 阿里云账号用户名 | `your-username` | ✅ |
| `ALIYUN_REGISTRY_PASSWORD` | 阿里云账号密码或访问凭证 | `your-password` | ✅ |

### 1.2 邮件通知相关配置

| Secret 名称 | 说明 | 样例值 | 必填 |
|---|---|---|---|
| `RESEND_API_KEY` | Resend API Key（推荐） | `re_xxxxxxxxxxxxxxxxxxxxxxxxxx` | ✅ |
| `RESEND_SENDER_EMAIL` | 发件人邮箱（需在 Resend 中验证） | `noreply@yourdomain.com` | ✅ |
| `EMAIL_RECIPIENT` | 收件人邮箱地址 | `admin@company.com` | ✅ |

### 1.3 各注册表认证配置（按需配置）

以下 Secrets 仅在需要同步对应注册表的**私有镜像**时才需配置。公开镜像无需配置。

#### Docker Hub

| Secret 名称 | 说明 | 样例值 | 必填 |
|---|---|---|---|
| `DOCKERHUB_USERNAME` | Docker Hub 用户名 | `your-username` | 按需 |
| `DOCKERHUB_PASSWORD` | Docker Hub 密码或 Access Token | `your-password` | 按需 |

#### GitHub Container Registry (ghcr.io)

| Secret 名称 | 说明 | 样例值 | 必填 |
|---|---|---|---|
| `GITHUB_TOKEN` | GitHub Personal Access Token（需 `read:packages` 权限） | `ghp_xxxxxxxxxxxx` | 按需 |

#### Google Container Registry (gcr.io)

| Secret 名称 | 说明 | 样例值 | 必填 |
|---|---|---|---|
| `GCP_SERVICE_ACCOUNT_KEY` | GCP 服务账号 JSON Key（需 Artifact Registry Reader 权限，项目 ID 已包含在 Key 中） | `{"type":"service_account",...}` | 按需 |

#### Microsoft Container Registry (MCR / mcr.microsoft.com)

> **公开注册表，无需配置任何 Secrets**。
> 例如 `mcr.microsoft.com/dotnet/aspnet:8.0` 可直接在 `images.txt` 中列出，无需认证。

#### Azure Container Registry (ACR / *.azurecr.io)

> **私有注册表**，需要 Azure 服务主体认证。

| Secret 名称 | 说明 | 样例值 | 必填 |
|---|---|---|---|
| `AZURE_CLIENT_ID` | Azure 服务主体 Client ID | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` | 按需 |
| `AZURE_CLIENT_SECRET` | Azure 服务主体 Client Secret | `xxxxxxxxxxxxxxxxxxxxxxxx` | 按需 |
| `AZURE_TENANT_ID` | Azure 租户 ID | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` | 按需 |
| `AZURE_REGISTRY_NAME` | Azure 容器注册表名称（不含 `.azurecr.io`） | `myacr` | 按需 |

#### Amazon ECR

| Secret 名称 | 说明 | 样例值 | 必填 |
|---|---|---|---|
| `AWS_ACCESS_KEY_ID` | AWS Access Key ID | `AKIAXXXXXXXXXXXX` | 按需 |
| `AWS_SECRET_ACCESS_KEY` | AWS Secret Access Key | `xxxxxxxxxxxxxxxxxxxxxxxx` | 按需 |
| `AWS_REGION` | AWS 区域 | `us-east-1` | 按需 |

---

## 二、阿里云容器镜像服务配置

### 2.1 获取阿里云 Registry 地址

阿里云提供多个地域的镜像服务，根据你的个人版地域情况和页面显示选择即可。

### 2.2 创建命名空间

1. 登录 [阿里云容器镜像服务控制台](https://cr.console.aliyun.com/)
2. 选择左侧菜单 `命名空间`
3. 点击 `创建命名空间`
4. 输入命名空间名称（如 `my-namespace`）
5. 选择 `公开` 或 `私有`
6. `确定` 创建

### 2.3 获取访问凭证

**方式一：使用阿里云账号密码**

直接使用阿里云账号的 `AccessKey ID` 和 `AccessKey Secret`。

**方式二：使用 RAM 子账号（推荐）**

1. 登录 [阿里云 RAM 控制台](https://ram.console.aliyun.com/)
2. 创建用户，勾选 `OpenAPI 访问`
3. 创建后，获取 `AccessKey ID` 和 `AccessKey Secret`
4. 为用户添加权限策略：
   - 推荐策略：`AliyunContainerRegistryFullAccess`（容器镜像服务完整权限）
   - 或自定义策略，仅授予 `push` 和 `pull` 权限

---

## 三、使用ReSend配置邮件通知

1. **注册 Resend 账户**
   - 访问 [Resend 官网](https://resend.com/)
   - 注册免费账户（无需信用卡）

2. **获取 API Key**
   - 登录 Resend 控制台
   - 进入 `API Keys` 页面
   - 点击 `Create API Key`
   - 生成并复制 API Key（格式：`re_xxxxxxxxxxxxxxxxxxxxxxxxxx`）

3. **验证发件人邮箱**
   - 进入 `Emails` → `Add Sender`
   - 输入发件人邮箱（如 `noreply@yourdomain.com`）
   - 按照提示完成邮箱验证（通常需要点击确认链接）
   - 验证完成后，使用该邮箱作为发件人

4. **配置 GitHub Secrets**
   - `RESEND_API_KEY`：填入获取的 API Key
   - `RESEND_SENDER_EMAIL`：填入已验证的发件人邮箱
   - `EMAIL_RECIPIENT`：填入接收通知的邮箱

## 四、从阿里云容器镜像服务拉取同步镜像

### 4.1 镜像命名规则

> **重要**：阿里云 ACR 仓库名不支持多级路径（`/`），因此源镜像路径中的 `/` 会被替换为 `_`。

| `images.txt` 中的写法 | 阿里云上的完整 URL |
|---|---|
| `nginx:latest` | `your-registry.example.com/my-namespace/library_nginx:latest` |
| `bitnami/redis:7` | `your-registry.example.com/my-namespace/bitnami_redis:7` |
| `ghcr.io/owner/repo:tag` | `your-registry.example.com/my-namespace/ghcr.io_owner_repo:tag` |
| `gcr.io/project/image:tag` | `your-registry.example.com/my-namespace/gcr.io_project_image:tag` |
| `mcr.microsoft.com/dotnet/aspnet:8.0` | `your-registry.example.com/my-namespace/mcr.microsoft.com_dotnet_aspnet:8.0` |

> `your-registry.example.com` 对应 `ALIYUN_REGISTRY`，`my-namespace` 对应 `ALIYUN_NAME_SPACE`。

### 4.2 在 Docker Compose 中使用

由于阿里云仓库名经过 `/`→`_` 映射，compose 中需将原镜像名替换为阿里云路径：

```yaml
# 原 compose
services:
  app:
    image: bitnami/redis:7

# 改为（/ 替换为 _）
services:
  app:
    image: your-registry.example.com/my-namespace/bitnami_redis:7
```

**映射对照速查：**

| 原 compose 中的 image | 阿里云上的 image |
|---|---|
| `python:3.13-slim` | `your-registry.example.com/my-namespace/library_python:3.13-slim` |
| `bitnami/redis:7` | `your-registry.example.com/my-namespace/bitnami_redis:7` |
| `sengokucola/maibot:latest` | `your-registry.example.com/my-namespace/sengokucola_maibot:latest` |
| `ghcr.io/owner/repo:tag` | `your-registry.example.com/my-namespace/ghcr.io_owner_repo:tag` |

### 4.3 直接拉取阿里云镜像

#### 方法一：使用 Docker CLI

```bash
# 1. 登录阿里云容器镜像服务
docker login your-registry.example.com

# 2. 输入阿里云用户名和密码
# 用户名：你的阿里云账号用户名
# 密码：你的阿里云密码或 AccessKey Secret

# 3. 拉取同步的镜像（把 images.txt 中的路径中的 / 替换为 _）
docker pull your-registry.example.com/my-namespace/library_nginx:latest        # nginx:latest
docker pull your-registry.example.com/my-namespace/bitnami_redis:7              # bitnami/redis:7
docker pull your-registry.example.com/my-namespace/ghcr.io_owner_repo:tag       # ghcr.io/owner/repo:tag
```

#### 方法二：使用 skopeo 检查和拉取

```bash
# 检查镜像是否存在
skopeo inspect docker://your-registry.example.com/my-namespace/bitnami_redis:7

# 拉取镜像
skopeo copy docker://your-registry.example.com/my-namespace/bitnami_redis:7 docker-daemon:bitnami/redis:7
```

#### 方法三：在 Kubernetes 中使用

```yaml
# 在 Kubernetes YAML 文件中引用同步的镜像
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  template:
    spec:
      containers:
      - name: my-app
        image: your-registry.example.com/my-namespace/bitnami_redis:7
        ports:
        - containerPort: 80
```

### 4.4 常见问题

**Q1: 为什么拉取同步的镜像需要登录阿里云？**

**A:** 因为阿里云容器镜像服务需要认证才能访问。你需要使用阿里云的账号信息进行登录。

**Q2: 如何获取阿里云的登录凭证？**

**A:** 可以使用以下方式：
- 阿里云账号的用户名和密码
- RAM 子账号的 AccessKey ID 和 AccessKey Secret
- 临时访问凭证

**Q3: 拉取镜像时出现 "unauthorized" 错误怎么办？**

**A:** 检查以下几点：
1. 确认阿里云 Registry 地址是否正确
2. 确认用户名和密码是否正确
3. 确认命名空间是否正确
4. 确认镜像名称是否正确（注意 `/` 需替换为 `_`）

**Q4: 如何验证镜像是否已成功同步？**

**A:** 使用以下命令检查：
```bash
# 检查镜像标签
docker images | grep my-namespace

# 或使用 skopeo
skopeo inspect docker://your-registry.example.com/my-namespace/bitnami_redis:7
```

**Q5: 如何同步和拉取私有镜像？**

**A:** 私有镜像需要额外的认证信息：

1. **Docker Hub 私有镜像**：
   - 在 GitHub Secrets 中配置 `DOCKERHUB_USERNAME` 和 `DOCKERHUB_PASSWORD`
   - 在 `images.txt` 中添加私有镜像，如 `your-username/private-image:tag`

2. **GitHub Container Registry (ghcr.io) 私有镜像**：
   - 在 GitHub Secrets 中配置 `GITHUB_TOKEN`（Personal Access Token）
   - 在 `images.txt` 中添加私有镜像，如 `ghcr.io/your-org/private-repo:tag`

3. **Google Container Registry (gcr.io) 私有镜像**：
   - 在 GitHub Secrets 中配置 `GCP_SERVICE_ACCOUNT_KEY`（项目 ID 已包含在 Key 中）
   - 在 `images.txt` 中添加私有镜像，如 `gcr.io/your-project/private-image:tag`

4. **Azure Container Registry (ACR / *.azurecr.io) 私有镜像**：
   - 在 GitHub Secrets 中配置 `AZURE_CLIENT_ID`、`AZURE_CLIENT_SECRET`、`AZURE_TENANT_ID`、`AZURE_REGISTRY_NAME`
   - 在 `images.txt` 中添加镜像，如 `myacr.azurecr.io/your-app:tag`
   - 注意: `mcr.microsoft.com` 是微软公开注册表，拉取无需认证，放公开区即可

5. **Amazon ECR 私有镜像**：
   - 在 GitHub Secrets 中配置 `AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`、`AWS_REGION`
   - 在 `images.txt` 中添加私有镜像，如 `123456789.dkr.ecr.us-east-1.amazonaws.com/your-app:latest`

**Q6: 工作流如何处理私有镜像的认证？**

**A:** GitHub Actions 工作流会在拉取私有镜像前自动使用相应的认证信息：

- Docker Hub：使用 `DOCKERHUB_USERNAME` 和 `DOCKERHUB_PASSWORD`
- GitHub Container Registry：使用 `GITHUB_TOKEN`
- Google Container Registry：使用 `GCP_SERVICE_ACCOUNT_KEY`
- Azure Container Registry (ACR)：使用 Azure 服务主体
- Amazon ECR：使用 AWS 凭证

**Q7: 私有镜像同步失败怎么办？**

**A:** 检查以下几点：
1. 确认私有镜像的认证信息是否正确配置在 GitHub Secrets 中
2. 确认私有镜像的访问权限是否正确（如 GitHub Token 是否有足够的权限）
3. 检查 GitHub Actions 日志中的具体错误信息
4. 确认私有镜像是否存在且可访问

---

## 安全注意事项

- **敏感信息**：所有敏感信息（如密码、API Key）都应通过 GitHub Secrets 管理
- **权限控制**：确保只有授权用户可以访问阿里云容器镜像服务
- **镜像安全**：定期扫描镜像漏洞，确保使用安全的镜像版本

## 支持的镜像注册表

| 注册表 | 支持的私有镜像 | 认证方式 |
|--------|--------------|----------|
| Docker Hub | ✅ | 用户名/密码 |
| GitHub Container Registry (ghcr.io) | ✅ | Personal Access Token |
| Google Container Registry (gcr.io) | ✅ | 服务账号密钥 |
| Microsoft Container Registry (mcr.microsoft.com) | ❌ 仅公开 | 无需认证 |
| Azure Container Registry (*.azurecr.io) | ✅ | Azure 服务主体 |
| Quay.io | ❌ 仅公开 | 无需认证 |
| Amazon ECR | ✅ | AWS 访问密钥 |

---

## 五、常见问题

### Q1: 为什么拉取某些镜像需要认证？

**A:** 公开镜像可以直接拉取，但私有镜像需要提供认证信息。GitHub Actions 工作流在拉取镜像时，如果遇到私有镜像，需要确保：
- Docker Hub 私有镜像：在 GitHub Secrets 中配置 Docker Hub 凭证
- ghcr.io 私有镜像：配置 GitHub Token
- gcr.io 私有镜像：配置 Google Cloud 凭证
- ACR (*.azurecr.io) 私有镜像：配置 Azure 服务主体

### Q2: 如何验证镜像是否已同步到阿里云？

**A:** 使用 `skopeo` 或 `docker` 命令检查：

```bash
# 使用 skopeo 检查
skopeo inspect docker://your-registry.example.com/my-namespace/bitnami_redis:7

# 或登录阿里云后拉取
docker login your-registry.example.com
docker pull your-registry.example.com/my-namespace/bitnami_redis:7
```

### Q3: 邮件通知发送失败怎么办？

**A:** 检查以下几点：
1. Resend API Key 是否正确
2. 发件人邮箱是否已在 Resend 中验证
3. 检查 GitHub Actions 日志中的错误信息
4. 确认 Resend 账户有足够的发送额度

### Q4: 如何测试工作流配置是否正确？

**A:** 
1. 在 GitHub 仓库页面，进入 `Actions` 标签
2. 选择 `Docker Image Sync to Aliyun` 工作流

3. 点击 `Run workflow` 手动触发
4. 查看运行日志，检查是否有错误

### Q5: 镜像名称映射规则是什么？

**A:** 阿里云 ACR 仓库名不支持多级路径（`/`），因此工作流会将源镜像路径中的 `/` 替换为 `_`：

| 源镜像 | 阿里云目标仓库名 |
|---|---|
| `nginx:latest` | `library_nginx:latest` |
| `bitnami/redis:7` | `bitnami_redis:7` |
| `ghcr.io/owner/repo:tag` | `ghcr.io_owner_repo:tag` |
| `gcr.io/project/image:tag` | `gcr.io_project_image:tag` |
| `mcr.microsoft.com/dotnet/aspnet:8.0` | `mcr.microsoft.com_dotnet_aspnet:8.0` |

