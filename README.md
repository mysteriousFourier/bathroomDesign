# 卫生间量房建模工作台

从卫生间手绘测量图和可选现场照片提取结构化尺寸，先形成可追溯的 `MeasurementModel` 量房 JSON，再由确定性几何代码生成二维审图和三维模型。照片只补充固定设施和空间关系；明确测量值始终优先于图像估算。

## 本地运行

要求 Node.js 20+、Python 3.11+ 和 `uv`。

Windows 可直接双击仓库根目录的 `start-system.bat`。启动器会检查工具与
项目依赖、在缺少 `.env` 时复制模板、构建前端、启动后端并打开
`http://127.0.0.1:8000`。启动完成后终端会持续显示运行状态；保持窗口开启，使用结束后在窗口中按 Enter，启动器会停止后端并释放 `8000` 端口。

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

## 模型接口配置

后端使用 Chat Completions 兼容协议调用模型接口，并以多模态 `image_url` 格式提交图片。一次平面图识别只调用一次 `READ_MODEL`，专门抄录逐边尺寸、门洞及高度；轮廓和点位由本地图像处理提取，尺寸绑定和几何组装也由本地代码完成。进程内所有魔塔模型请求共用单并发门禁，同时最多执行 1 个请求。

```dotenv
OPENAI_BASE_URL=
OPENAI_API_KEY=
READ_MODEL=
CHAT_MODEL=
```

四项配置均由部署者按所用兼容接口填写：`READ_MODEL` 必须支持图像输入，`CHAT_MODEL` 用于设计对话等非平面图识别流程。密钥只存在于后端环境变量，不发送到浏览器。平面图单次识别不自动重试，以避免一次操作产生多次视觉计费；鉴权错误也不会重复请求。没有图像 bbox 证据的尺寸、门洞和设施不会自动进入三维模型。模型响应 trace 默认关闭，因为响应可能包含量房数值；仅在本机排错并确认保留策略后临时开启 `AI_TRACE_ENABLED`。

## 使用流程

1. 新建项目并上传一张带尺寸的平面图，或从“导入量房数据”读取已有 JSON、GeoJSON、SVG、DXF、DWG；上传图片后先查看分辨率、清晰度、曝光和笔画对比预检。
2. 解析平面图；生成结果先作为未保存草稿供核对，成功或失败都不会覆盖上一轮结果，只有主动保存或确认才会替换当前量房数据。如果轮廓、尺度和净高足够，可跳过现场照片。
3. 需要时上传多张照片，补充马桶、台盆、淋浴房、地漏、管道和柱体等固定设施。
4. 在二维审图中修正尺寸、洞口和设施位置，处理错误与警告；可下载当前量房 JSON 留档。
5. 点击“确认数据”后，由同版量房 JSON 重建三维模型，检查比例并导出 GLB。

内部数据使用整数毫米；Three.js 和 GLB 使用米、Y 轴向上。程序定位为装修方案级工具，不替代施工复测、BIM 或隐蔽工程勘察。

### 导入量房数据

- `JSON`：支持本项目内部 `MeasurementModel`、下载的量房契约、`RoomSpec` 和 GeoJSON。当前下载的量房契约可无损回读马桶、台盆、淋浴、地漏、排水、给水、电点、管井、柱体、暖气及其他点位的类型、用途、位置、尺寸和旋转角度。
- `SVG`：识别闭合路径、折线和矩形轮廓；根据元素 `id`、类名或标签识别门窗、地漏、排水、给水、电点和管井。
- `DXF`：读取模型空间、声明单位、图层、闭合多段线、首尾相接线段及带语义名称的块或点位。
- `DWG`：后端需安装 ODA File Converter 或 LibreDWG 的 `dwg2dxf`；未安装时界面会明确要求先另存为 DXF。
- `GeoJSON`：按平面工程坐标导入 Polygon 和带类型属性的 Point；需要人工指定坐标单位，不自动投影经纬度。

导入前先显示格式、单位、图层和解析警告；确认后才替换当前项目的结构化量房数据。所有导入结果均进入二维审图，不能绕过原有校验与人工确认直接建模。

## 手绘量房规则

推荐直接打印 [`public/measurement-template.html`](public/measurement-template.html) 的 A4 横向量房纸。核心规则如下：

- 全图只用一支黑色或深蓝色笔；墙体画连续实线，尺寸放在轮廓外侧并带尺寸线。
- 统一使用整数毫米并横向正写；横向和纵向都写连续分段尺寸链及一个总尺寸。
- 门窗固定填写 `D1`、`W1`、`W2`，字段统一为 `CG`（洞口距地）、`CK`（洞口内宽）、`CH`（洞口内高）。
- 点位不填写坐标表，直接在草图相对位置画标准符号并写简称；系统从符号中心派生相对坐标。
- 高度填写室内净高；整屋吊顶高度可直接写在房间轮廓中央，识别时只采用图片中的实际读数。
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

先在当前终端设置 `OPENAI_BASE_URL`、`OPENAI_API_KEY`、`READ_MODEL` 和 `CHAT_MODEL`，然后运行：

```powershell
docker compose up --build
```

访问 `http://127.0.0.1:8000`。容器默认将项目数据保存到 `studio-data` 卷。公网部署前需要在反向代理层增加 HTTPS、身份认证、请求配额和访问日志脱敏。
