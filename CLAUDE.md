# CLAUDE.md

This file provides guidance to Claude Code when working with the `GmgnTwitterAudioPlayer` repository.

## Project Overview

这是一个 Chrome 浏览器扩展项目，旨在为特定的社交媒体信息流提供自定义的音频播报和监控功能。项目可能同时包含前端（Chrome Extension API、JS/TS、HTML）与后端的辅助脚本。

## 🛠️ Python 编码与环境规范 (针对所有 .py 文件)

当需要编写、修改或重构 Python 辅助脚本时，必须严格遵守以下规范：
- **环境管理**：仅使用 `uv` 管理虚拟环境。安装依赖必须使用 `uv add <package>`，执行脚本必须使用 `uv run <script.py>`。
- **代码风格**：严格遵守 PEP 8 最佳实践。
- **异常处理**：始终在 `try...except` 块中指定明确的异常类型（例如 `except ValueError:` 或 `except KeyError:`）。**绝对禁止**使用裸 `except:`，如果需要捕获常规错误，请使用 `except Exception as e:`，以防止捕获 `SystemExit` 等系统级异常。
- **CLI 交互设计**：在编写终端工具或脚本时，默认采用**输入数字选择功能**的交互式菜单模式，避免要求用户输入长串的命令行参数。

## 🌐 Chrome 扩展开发规范 (针对前端文件)

当处理扩展本身的核心代码时：
- 优先使用 Chrome Manifest V3 标准。
- 确保 Service Worker (Background scripts) 的逻辑非持久化且能正确被唤醒。
- 在处理 DOM 和 Content Scripts 时，注意 Twitter 页面的动态渲染特性，优先使用 MutationObserver 而不是简单的定时器。

## 常用命令 (请根据实际情况调整)

```bash
# 假设你有这些命令，让 Claude 知道如何构建或测试你的插件
# npm install
# npm run build