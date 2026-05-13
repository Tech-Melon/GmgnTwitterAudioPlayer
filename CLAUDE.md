# CLAUDE.md

This file provides guidance to Claude Code when working with the `GmgnTwitterAudioPlayer` repository.

## Project Overview

这是一个 Chrome 浏览器扩展项目，旨在为特定的社交媒体信息流提供自定义的音频播报和监控功能。项目可能同时包含前端（Chrome Extension API、JS/TS、HTML）与后端的辅助脚本。

## 🚨 核心绝对禁令 (CRITICAL RULES)

- **根目录纯洁性**：**绝对禁止**将任何带有 `_run_` 前缀的临时脚本（如 `_run_*.py` 等用于绕过 UAC 或执行命令的脚本）创建在项目根目录！
- **临时脚本隔离**：所有临时脚本**必须且只能**创建在 `tmp/` 目录下（例如 `tmp/_run_execute_pack.py`），并在执行完毕后由系统或主动清理，以保持根目录和 Git 树的整洁。

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

## 📦 提交与打包标准化流程 (MANDATORY)

当需要提交代码并打包 Chrome 扩展时，**必须严格按照以下步骤顺序执行**，不可跳步或自行编写替代脚本：

### Step 1: 语法检查
```bash
node -c content.js
node -c inject.js
node -c popup.js
node -c background.js
```
所有 JS 文件必须通过 `node -c` 语法校验，零错误才能继续。

### Step 2: 升级版本号
修改 `manifest.json` 中的 `version` 字段（遵循 semver）：
- **patch**（x.y.Z）：Bug 修复、日志优化、代码重构
- **minor**（x.Y.0）：新增功能特性、UI 改版
- **major**（X.0.0）：架构级别的不兼容改动

### Step 3: Git 提交与推送
使用 `tmp/_run_xxx.py` 临时脚本封装 git 命令（遵守根目录纯洁性原则）：
```python
# tmp/_run_git_push.py
import subprocess, sys
COMMANDS = [
    ['git', 'add', '-A'],
    ['git', 'commit', '-m', '<conventional commit message>'],
    ['git', 'push', 'origin', 'main'],
]
# ...
```
Commit message 必须使用 Conventional Commits 格式：`feat:` / `fix:` / `refactor:` / `chore:`

### Step 4: 执行打包
**必须使用项目自带的打包脚本**，严禁自行编写打包逻辑：
```bash
python scripts/pack.py
```
该脚本会自动：
- 读取 `manifest.json` 版本号
- 清理旧版 ZIP 包
- 生成 `GmgnTwitterAudioPlayer-v{version}.zip`
- 输出商店发布文案（如有）

### ⚠️ 禁止事项
- ❌ 跳过语法检查直接提交
- ❌ 自行编写打包脚本替代 `scripts/pack.py`
- ❌ 手动拼装 ZIP 文件
- ❌ 在根目录创建 `_run_*.py` 临时脚本（必须放 `tmp/` 目录）

## 常用命令

```bash
# 语法检查
node -c content.js

# 打包扩展
python scripts/pack.py

# Git 状态
git status
git log -5 --oneline
```