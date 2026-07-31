# 量界 · 卫生间建模工作台

从卫生间手绘测量图和可选现场照片提取结构化尺寸，先形成可追溯的 `MeasurementModel` 量房 JSON，再由确定性几何代码生成二维审图和三维模型。照片只补充固定设施和空间关系；明确测量值始终优先于图像估算。

## 本地运行

要求 Node.js 20+、Python 3.11+ 和 `uv`。

Windows 可直接双击仓库根目录的 `start-system.bat`。启动器会检查工具与
项目依赖、在缺少 `.env` 时复制模板、构建前端、启动后端并打开
`http://127.0.0.1:8000`。保持启动窗口开启；在窗口中按 Enter 可停止系统。

首次运行可能需要联网安装依赖。API 配置缺失时系统仍可启动，但 AI 识别功能
不可用，请在 `.env` 中补全 `OPENAI_BASE_URL`、`OPENAI_API_KEY` 和
`READ_MODEL`、`CHAT_MODEL`。

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
READ_MODEL=glm-4v-flash
CHAT_MODEL=glm-4.7-flash
```

密钥只存在于后端环境变量，不发送到浏览器。图片识别统一使用 `READ_MODEL`，流程协调与对话统一使用 `CHAT_MODEL`。429、1302、1305 和服务端错误会指数退避重试；401/403 鉴权错误不会重复请求。没有图像 bbox 证据的尺寸、门洞和设施不会自动进入三维模型。脱敏后的模型原始响应保存在 `backend/data/ai-traces`，便于定位供应商返回格式和识别错误。

## 使用流程

1. 新建项目并上传一张带尺寸的平面图；上传后先查看分辨率、清晰度、曝光和笔画对比预检。
2. 解析平面图；如果轮廓、尺度和净高足够，可跳过现场照片。
3. 需要时上传多张照片，补充马桶、台盆、淋浴房、地漏、管道和柱体等固定设施。
4. 在二维审图中修正尺寸、洞口和设施位置，处理错误与警告；可下载当前量房 JSON 留档。
5. 点击“确认数据”后，由同版量房 JSON 重建三维模型，检查比例并导出 GLB。

内部数据使用整数毫米；Three.js 和 GLB 使用米、Y 轴向上。程序定位为装修方案级工具，不替代施工复测、BIM 或隐蔽工程勘察。

## 手绘量房规则

推荐直接打印 [`public/measurement-template.html`](public/measurement-template.html) 的 A4 横向量房纸。核心规则如下：

- 全图只用一支黑色或深蓝色笔；墙体画连续实线，尺寸放在轮廓外侧并带尺寸线。
- 统一使用整数毫米并横向正写；横向和纵向都写连续分段尺寸链及一个总尺寸。
- 门窗固定填写 `D1`、`W1`、`W2`，字段统一为 `CG`（洞口距地）、`CK`（洞口内宽）、`CH`（洞口内高）。
- 点位不填写坐标表，直接在草图相对位置画标准符号并写简称；系统从符号中心派生相对坐标。
- 高度填写室内净高；整屋吊顶高度可直接写在房间轮廓中央，例如 `吊顶 2100`。
- 写错时单线划掉后在空白处重写，不覆盖或涂黑原数字。
- 拍照时完整保留纸张四边，镜头尽量垂直，原图长边不少于 2000 像素。

完整规范见 [`contracts/HANDDRAWN-CAPTURE-RULES.md`](contracts/HANDDRAWN-CAPTURE-RULES.md)，机器可读阈值见 [`contracts/capture-rules.json`](contracts/capture-rules.json)。不符合规范的旧草图仍可上传：视觉和 OCR 只提供候选，系统通过墙体拓扑、证据绑定和尺寸链闭合求解；不能唯一确定的数据会留在“需要确认”，不会静默补造。

上传后的图片质量检查可通过 `GET /api/assets/{asset_id}/capture-assessment` 单独调用。结果为 `ready`、`usable` 或 `retake`，该检查只提示拍摄质量，不阻止旧草图进入识别流程。

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
