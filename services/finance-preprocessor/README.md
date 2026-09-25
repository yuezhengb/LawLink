# LawLink 内部财务文件预处理

此容器只用于传统 `.xls` 转换和 PDF 表格/文字提取。它不连接数据库、不挂载业务原件存储、不映射宿主机端口，只在 `finance-preprocessor-net` 内由 LawLink app 调用。网络在容器运行时标记为 internal，不提供公网出站路由。

## 固定组件

- Python 官方镜像：`python:3.12.14-slim-bookworm`
- Python 包：`ocrmypdf==17.12.1`、`pdfplumber==0.11.10`、`pypdf==6.18.0`
- 系统工具：LibreOffice Calc headless、Ghostscript、qpdf、Poppler、Tesseract 与 `chi_sim`；镜像基于 Debian Bookworm。构建后用 `dpkg-query` 将实际系统包版本留在发布审计记录中。
- 上游与许可证：
  - [LibreOffice](https://github.com/LibreOffice/core)
  - [OCRmyPDF](https://github.com/ocrmypdf/OCRmyPDF)
  - [Tesseract OCR](https://github.com/tesseract-ocr/tesseract)
  - [Simplified Chinese trained data](https://github.com/tesseract-ocr/tessdata)
  - [pdfplumber](https://github.com/jsvine/pdfplumber)

## 运行与安全边界

Docker Compose `finance-preprocessor` profile 启动该服务。设置 `FINANCE_PREPROCESSOR_TOKEN` 后，app 使用内部地址 `http://finance-preprocessor:8080`；不要配置公网反代、端口映射或额外网络。

服务仅接受带 Bearer token 的 `POST /v1/preprocess`，只允许已知财务来源类型和 `.xls`/`.pdf` 文件，最大 25 MiB，PDF 最大 50 页。每个请求一次串行处理；OCR/转换有时限，临时目录位于容器 `/tmp` tmpfs，结束时删除。容器以 UID 65532 运行、只读根文件系统、丢弃 Linux capabilities，资源上限为 768 MiB、1 CPU、96 PIDs。

数字版 PDF 先用 pdfplumber 读取原文字层与表格；只有没有文字层的页才进入 OCRmyPDF/Tesseract。能形成表格的 OCR 行仍须人工复核；无法形成表格的页只提供带页码/坐标/置信度的候选，不会猜测生成交易记录。健康探针仅报告服务存活，不返回版本、配置、文件名或请求信息。请求日志不记录请求头、来源文件名、提取文本或本地路径。

测试命令：

```powershell
docker compose --profile finance-preprocessor build finance-preprocessor
docker compose --profile finance-preprocessor run --rm finance-preprocessor python -m unittest discover -s tests
```
