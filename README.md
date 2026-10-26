# extractstamp · 印章提取（离线自托管版）

从照片 / 扫描件里抠出**红色或蓝色印章**，输出透明背景 PNG。全部图像处理在浏览器本地完成，图片不上传任何服务器。


## 特性

- 🖼 拖拽 / 点击 / 粘贴图片即可识别
- 🔴🔴 支持红色、蓝色印章；可统一填充指定颜色
- ⭕ 圆形印章检测（HoughCircles）与区域提取双模式
- 🎛 颜色容差、圆形灵敏度可调
- 🔒 **离线可用**：OpenCV.js 已打包进页面，运行时零外部请求
- 🐳 提供 Docker 镜像，一条 compose 命令即可部署

## 算法概览

HSV 双区间颜色掩码取印章 → 形态学闭运算连通笔画 → 淡边回补（把被冲淡的外缘接回来）→ 定位（圆形模式用 HoughCircles 只判"这团是不是圆的"，裁剪范围一律取连通域真实外接框；非圆形模式直接取连通域）→ 细长图形（箭头/下划线）按最小外接矩形长短边比排除 → 按掩码生成透明通道并紧致裁剪。

思路参考上游 [xxss0903/extractstamp](https://github.com/xxss0903/extractstamp)。

## 快速开始

### Docker Compose（推荐）

```bash
git clone https://github.com/boater-man/extractstamp.git
cd extractstamp
docker compose up -d
# 打开 http://localhost:8848
```

### 直接拉取镜像

```bash
docker run -d --name extractstamp -p 8848:80 --restart unless-stopped \
  ghcr.io/boater-man/extractstamp:latest
```

### 本地构建

```bash
docker build -t extractstamp .
docker run -d -p 8848:80 extractstamp
```

## 端口

| 容器端口 | 默认宿主端口 | 说明 |
|---------|------------|------|
| 80      | 8848       | nginx HTTP |

可在 `docker-compose.yml` 里修改宿主端口映射。

## 目录结构

```
extractstamp/
├── Dockerfile                    # nginx:alpine 托管静态站点
├── docker-compose.yml            # 一键部署
├── .github/workflows/
│   └── docker-publish.yml        # push main / tag 自动构建并推送 GHCR
├── public/
│   ├── index.html                # 工具页面（含全部 UI 与交互逻辑）
│   ├── extractstamp.js           # 核心提取算法（调用 OpenCV.js）
│   └── opencv.js                 # OpenCV.js 4.x（本地化，约 10MB）
└── README.md
```

## 隐私说明

所有图像解码、掩码运算、PNG 导出均在浏览器端完成。容器只负责静态文件分发，**不接收、不存储任何上传的图片**。

## License

MIT
