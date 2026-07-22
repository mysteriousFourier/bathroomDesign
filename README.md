# 量界 · 卫生间建模工作台

从卫生间手绘测量图和可选现场照片提取结构化尺寸，先形成可追溯的 `MeasurementModel` 量房 JSON，再由确定性几何代码生成二维审图和三维模型。照片只补充固定设施和空间关系；明确测量值始终优先于图像估算。

## 本地运行

要求 Node.js 20+、Python 3.11+ 和 `uv`。

```powershell
Copy-Item .env.example .env
# 编辑 .env，填写兼容 API 地址、密钥和支持图像输入的模型名
npm install
$env:UV_CACHE_DIR='.uv-cache'
uv sync --dev
```

开发时打开两个 PowerShell 窗口：

```powershell
.\.venv\Scripts\python.exe -m uvicorn backend.app.main:app --reload --host 127.0.0.1 --port 8000
```

```powershell
npm run dev
```

浏览器访问 `http://127.0.0.1:5173`。生产构建后，FastAPI 会直接托管 `dist`：

```powershell
npm run build
.\.venv\Scripts\python.exe -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000
```

此时访问 `http://127.0.0.1:8000`。

## OpenAI 兼容接口

后端调用 `{OPENAI_BASE_URL}/chat/completions`，使用 Chat Completions 的多模态 `image_url` 格式。4.6V 优先通过视觉 Function Call 主动裁剪局部；旧模型由后端生成完整图和重叠局部图。识别流程先保存带 bbox 的原始证据，再识别底边尺寸链和关键尺寸，最后组装并复核几何结构。

```dotenv
OPENAI_BASE_URL=https://open.bigmodel.cn/api/paas/v4
OPENAI_API_KEY=填写你的智谱 API Key
OPENAI_MODEL=glm-4.6v-flash
OPENAI_QUALITY_MODEL=glm-4.6v
OPENAI_FALLBACK_MODEL=glm-4v-flash
```

密钥只存在于后端环境变量，不发送到浏览器。429、1302、1305 和服务端错误会先指数退避重试，再尝试回退模型；401/403 鉴权错误不会重复请求。没有图像 bbox 证据的尺寸、门洞和设施不会自动进入三维模型。脱敏后的模型原始响应保存在 `backend/data/ai-traces`，便于定位供应商返回格式和识别错误。

## 使用流程

1. 新建项目并上传一张带尺寸的平面图。
2. 解析平面图；如果轮廓、尺度和层高足够，可跳过现场照片。
3. 需要时上传多张照片，补充马桶、台盆、淋浴房、地漏、管道和柱体等固定设施。
4. 在二维审图中修正尺寸、洞口和设施位置，处理错误与警告；可下载当前量房 JSON 留档。
5. 点击“确认数据”后，由同版量房 JSON 重建三维模型，检查比例并导出 GLB。

内部数据使用整数毫米；Three.js 和 GLB 使用米、Y 轴向上。程序定位为装修方案级工具，不替代施工复测、BIM 或隐蔽工程勘察。

## 测试

```powershell
npm test
.\.venv\Scripts\python.exe -m pytest -q
npm run build
```

## Docker

先在当前终端设置三个 `OPENAI_*` 环境变量，然后运行：

```powershell
docker compose up --build
```

访问 `http://127.0.0.1:8000`。容器默认将项目数据保存到 `studio-data` 卷。公网部署前需要在反向代理层增加 HTTPS、身份认证、请求配额和访问日志脱敏。
