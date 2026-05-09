import glob
import json
import os
import zipfile


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


if __name__ == "__main__":
    create_zip()
