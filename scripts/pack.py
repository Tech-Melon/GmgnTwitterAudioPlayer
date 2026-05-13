import glob
import json
import os
import zipfile
import sys

# 强制标准输出使用 UTF-8 编码，防止 Windows 默认 GBK 报错
if sys.stdout.encoding.lower() != 'utf-8':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except AttributeError:
        pass


def create_zip():
    # 切换工作目录到插件根目录（scripts 的上一级）
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    os.chdir(project_root)

    # 从 manifest.json 读取当前版本号
    manifest_path = "manifest.json"
    if not os.path.exists(manifest_path):
        print(f"Error: {manifest_path} not found in {project_root}")
        return

    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest_data = json.load(f)

    version = manifest_data.get("version", "unknown")
    zip_name = f"GmgnTwitterAudioPlayer-v{version}.zip"

    # 清理旧的压缩包
    old_zips = glob.glob("GmgnTwitterAudioPlayer-v*.zip")
    for old_zip in old_zips:
        if old_zip != zip_name:
            try:
                os.remove(old_zip)
                print(f"Removed old zip: {old_zip}")
            except Exception as e:
                print(f"Warning: could not remove {old_zip}: {e}")

    # 需要打包的文件和目录清单
    targets = [
        "background.js",
        "content.js",
        "inject.js",
        "manifest.json",
        "popup.html",
        "popup.js",
        "images",
        "lib",
        "sounds",
    ]

    print(f"Creating {zip_name}...")
    with zipfile.ZipFile(zip_name, "w", zipfile.ZIP_DEFLATED) as zipf:
        for target in targets:
            if os.path.isfile(target):
                zipf.write(target)
                print(f"Added {target}")
            elif os.path.isdir(target):
                for root, _, files in os.walk(target):
                    # 排除不必要的隐藏文件，如 .DS_Store
                    for file in files:
                        if not file.startswith("."):
                            file_path = os.path.join(root, file)
                            zipf.write(file_path)
                            print(f"Added {file_path}")
    print(f"Successfully created {zip_name}")

    # 提取并打印最新的商店发布文案
    readme_path = "README.md"
    if os.path.exists(readme_path):
        try:
            with open(readme_path, "r", encoding="utf-8") as f:
                content = f.read()

            start_marker = "## 📝 详细商店发布文案 (Store Changelog)"
            if start_marker in content:
                print("\n" + "=" * 60)
                print("🌟 [发现商店更新说明] 复制以下内容直接发布到谷歌商店：\n")

                # 提取区块
                text_after_marker = content.split(start_marker)[1]
                # 去除括号里的提示
                if ")*" in text_after_marker:
                    text_after_marker = text_after_marker.split(")*", 1)[1]

                # 读取到下一个 --- 为止
                store_text = text_after_marker.split("---")[0].strip()
                print(store_text)
                print("\n" + "=" * 60 + "\n")
        except Exception as e:
            print(f"提取发布文案失败: {e}")


if __name__ == "__main__":
    create_zip()
