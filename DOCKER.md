# AionUi Docker 部署指南

预装 Claude Code、Opencode、Kimi CLI、Copilot 的 AionUi WebUI Docker 镜像。

## 快速开始

### 使用 Docker Compose（推荐）

```bash
# 1. 克隆或下载此目录

# 2. 构建并启动
docker-compose up -d

# 3. 查看日志
docker-compose logs -f

# 4. 访问 WebUI
# 打开浏览器访问 http://localhost:25808
```

### 使用纯 Docker

```bash
# 构建镜像
docker build -t aionui:webui .

# 运行容器
docker run -d \
  --name aionui-webui \
  -p 25808:25808 \
  -v aionui-config:/config \
  -v $(pwd)/workspace:/workspace \
  --restart unless-stopped \
  aionui:webui

# 查看日志
docker logs -f aionui-webui
```

## 预装 AI Agents

镜像已预装以下 CLI 工具：

| Agent | 命令 | 说明 |
|-------|------|------|
| Claude Code | `claude` | Anthropic 官方 CLI |
| Opencode | `opencode` | OpenCode CLI |
| Kimi CLI | `kimi` | Moonshot Kimi CLI（需配置 API Key）|
| GitHub Copilot | `gh copilot` | GitHub Copilot CLI |

## 配置 API Keys

### 方式 1：环境变量（推荐）

创建 `.env` 文件：

```env
ANTHROPIC_API_KEY=your-claude-api-key
OPENAI_API_KEY=your-openai-api-key
MOONSHOT_API_KEY=your-moonshot-api-key
GITHUB_TOKEN=your-github-token
```

然后在 `docker-compose.yml` 中引用：

```yaml
env_file:
  - .env
```

### 方式 2：启动后配置

1. 访问 WebUI (`http://localhost:25808`)
2. 首次启动会显示初始用户名和密码
3. 登录后在设置中配置各 Agent 的 API Key

## 持久化数据

Docker 配置了两个持久化卷：

| 路径 | 说明 |
|------|------|
| `/config` | AionUi 配置、会话历史、数据库 |
| `/workspace` | 工作目录（文件操作默认位置）|

## 自定义构建参数

```bash
# 指定 AionUi 版本构建
docker build \
  --build-arg AIONUI_VERSION=1.8.27 \
  -t aionui:1.8.27 .
```

##  troubleshooting

### 端口被占用

修改 `docker-compose.yml` 中的端口映射：

```yaml
ports:
  - "3000:25808"  # 主机3000端口映射到容器25808端口
```

### 内存不足

增加容器内存限制：

```yaml
deploy:
  resources:
    limits:
      memory: 8G
```

### CLI 工具未检测到

进入容器检查：

```bash
docker exec -it aionui-webui bash
which claude
which opencode
which kimi
```

## 安全注意事项

1. **不要在 Dockerfile 中硬编码 API Keys**
2. **使用 .env 文件并添加到 .gitignore**
3. **生产环境建议启用 HTTPS 反向代理**
4. **限制容器网络访问**（如需）

## 参考

- AionUi 官方文档：https://github.com/iOfficeAI/AionUi
- Claude Code: https://docs.anthropic.com/en/docs/agents-and-tools/claude-code
- Opencode: https://opencode.ai
- Kimi CLI: https://platform.moonshot.cn
