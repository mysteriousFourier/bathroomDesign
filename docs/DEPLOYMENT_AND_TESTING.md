# 部署与测试指南

本文适用于 `Bathroom Spatial Studio v1.0.2` 发布包。该版本用于功能验证和
方案评审，不替代施工复测、BIM、隐蔽工程勘察或正式生产安全评审。

## 1. 检查交付文件

交付应包含 ZIP 和同名 `.sha256` 文件。在 PowerShell 中执行：

```powershell
$expected = (Get-Content .\bathroom-spatial-studio-v1.0.2.sha256).Split()[0]
$actual = (Get-FileHash .\bathroom-spatial-studio-v1.0.2.zip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "安装包校验失败" }
```

校验通过后解压到本机短路径，例如 `C:\BathroomStudio`。不要直接在 ZIP 内运行。

## 2. Windows 一键启动

Windows 10/11 x64 测试机需提供 PowerShell 5.1+，并允许首次安装依赖时访问
`nodejs.org`、`github.com`、Python 包索引及所配置的模型接口。双击
`start-system.bat` 后，启动器会自动完成以下工作：

1. 检测 Node.js 20+、npm 和 `uv`。
2. 缺少工具时，将固定版本下载到项目内 `.tools/`，校验官方 SHA-256，全程无需管理员权限。
3. 从锁文件安装前后端依赖，缺少 `.env` 时从模板创建。
4. 构建前端、启动后端并打开浏览器。

代理或终端安全策略阻止自动下载时，可由管理员预装 Node.js 20+ 和 `uv`，启动器
会直接复用系统工具。

首次启动会创建 `.env`，但 AI 功能仍需填写以下配置：

```powershell
notepad .env
```

填写 `OPENAI_BASE_URL`、`OPENAI_API_KEY`、`READ_MODEL` 和 `CHAT_MODEL`。
`READ_MODEL` 必须支持图像输入。API 密钥只应写入本机 `.env`，不要通过邮件、截图
或测试反馈提交。

终端显示 `System is ready` 后访问 `http://127.0.0.1:8000`。测试期间保持终端窗口
开启，结束时按 Enter 关闭服务。语音功能需要额外依赖，可按需运行：

```powershell
.\start-system.bat -WithVoice
```

首次启用语音会下载较大的本地模型。需要手动控制浏览器时可加 `-NoBrowser`；只检查
并安装依赖时可加 `-CheckOnly`。

## 3. Docker 启动

已安装 Docker Desktop 的环境可在 PowerShell 设置配置后启动：

```powershell
$env:OPENAI_BASE_URL = "https://example.invalid/v1"
$env:OPENAI_API_KEY = "replace-me"
$env:READ_MODEL = "replace-me"
$env:CHAT_MODEL = "replace-me"
docker compose up --build -d
```

访问 `http://127.0.0.1:8000`。停止服务使用 `docker compose down`；项目数据保留在
`studio-data` 卷中。不要将示例地址或占位值用于真实测试。

## 4. 建议验收范围

1. 新建项目，上传一张带尺寸的平面图，检查图片质量提示和解析结果。
2. 在二维审图中核对轮廓、尺寸链、门窗和固定点位，确认异常项不会被静默接受。
3. 保存并确认量房数据，检查二维与三维结果是否来自同一组数据。
4. 选择自动布局方案，核对洁具、墙地面材质、尺寸和价格信息。
5. 导出量房 JSON 和 GLB，并在新项目中回读 JSON 验证数据可移交性。
6. 在未配置模型接口时启动系统，确认非 AI 页面仍可访问且界面明确提示配置缺失。

建议使用脱敏或虚构项目数据。对每个问题记录复现步骤、期望结果、实际结果、浏览器
版本、截图以及发生时间；同时附上 `.tmp/startup/` 中对应的后端日志。提交日志前先
检查其中是否包含业务数据、内网地址或其他敏感信息。

## 5. 数据与安全边界

- Windows 本地启动默认将项目数据库和上传文件写入 `backend/data/`；请由测试单位
  按自身制度备份、隔离和删除。
- Docker 部署默认使用 `studio-data` 数据卷。删除容器不会自动删除该卷。
- 模型请求会将测试人员主动提交的图片和文本发送到所配置的兼容 API 服务。
- 当前应用不内置身份认证、细粒度权限、TLS 终止或请求配额。跨主机或公网测试
  必须在受控网络和反向代理后部署，并补充 HTTPS、认证、限流及日志脱敏。
- AI 识别结果和自动布局必须人工复核，不能直接作为施工依据。

## 6. 故障定位

- 自动下载失败：确认代理允许访问下载地址，或由管理员预装 Node.js 20+ 和 `uv`。
- `8000` 端口被其他程序占用：停止占用程序后重试；启动器不会终止无法识别的服务。
- AI 功能不可用：检查 `.env` 四项配置以及模型接口的网络、鉴权和图像输入能力。
- 页面未更新：使用启动器输出中带 `?v=` 的地址，或清理浏览器站点缓存后重试。
- 启动失败：查看 `.tmp/startup/` 最新的 `stdout.log` 和 `stderr.log`。
