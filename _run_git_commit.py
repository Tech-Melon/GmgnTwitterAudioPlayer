import subprocess
import sys


def run():
    commands = [
        ["git", "add", "."],
        [
            "git",
            "commit",
            "-m",
            "feat: 优化TTS播报逻辑和调试日志\n\n- 添加规则列表试听按钮\n- 优化TTS语音选择和音量(提升50%)\n- 修复内置预设音频TTS播报逻辑(只有通用提示音才TTS)\n- 清理非必要调试日志，保留关键信息\n- 新增关键节点日志(配置加载、规则匹配、播放失败等)",
        ],
    ]

    for i, cmd in enumerate(commands, 1):
        print(f"[{i}/{len(commands)}] 执行: {' '.join(cmd)}")
        result = subprocess.run(cmd, check=False)
        if result.returncode != 0:
            print(f"命令失败，退出码: {result.returncode}")
            return result.returncode

    print("\n✅ 提交成功！")
    return 0


if __name__ == "__main__":
    sys.exit(run())
