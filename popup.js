document.addEventListener('DOMContentLoaded', () => {
    const els = {
        masterToggle: document.getElementById('masterToggle'),
        globalVolume: document.getElementById('globalVolume'),
        volumePercent: document.getElementById('volumePercent'),
        uploadBtn: document.getElementById('uploadBtn'),
        exportAudioZipBtn: document.getElementById('exportAudioZipBtn'), // 🌟 新增这一行
        customAudioFile: document.getElementById('customAudioFile'),
        addRuleBtn: document.getElementById('addRuleBtn'),
        twitterIdInput: document.getElementById('twitterId'),
        twitterRemarkInput: document.getElementById('twitterRemark'), // 🌟 备注输入框
        audioSelect: document.getElementById('audioSelect'),
        rulesList: document.getElementById('rulesList'),
        customAudioList: document.getElementById('customAudioList'),
        toast: document.getElementById('toast'),
        editModal: document.getElementById('editModal'),
        editTwitterId: document.getElementById('editTwitterId'),
        editTwitterRemark: document.getElementById('editTwitterRemark'), // 🌟 编辑备注框
        editAudioSelect: document.getElementById('editAudioSelect'),
        saveEditBtn: document.getElementById('saveEditBtn'),
        cancelEditBtn: document.getElementById('cancelEditBtn'),
        exportRulesBtn: document.getElementById('exportRulesBtn'),
        importRulesBtn: document.getElementById('importRulesBtn'),
        importRulesFile: document.getElementById('importRulesFile')
    };

    function showToast(message, duration = 2000) {
        els.toast.textContent = message;
        els.toast.classList.add('show');
        setTimeout(() => els.toast.classList.remove('show'), duration);
    }

    function loadData() {
        chrome.storage.local.get(['twitterAudioMappings', 'customAudios', 'isMasterEnabled', 'globalVolume'], (result) => {
            const mappings = result.twitterAudioMappings || {};
            const customAudios = result.customAudios || {};

            els.masterToggle.checked = result.isMasterEnabled !== false;

            if (result.globalVolume !== undefined) {
                els.globalVolume.value = result.globalVolume;
                els.volumePercent.textContent = Math.round(result.globalVolume * 100) + '%';
            }

            const baseOptions = `<option value="default.MP3">默认提示音</option><option value="preset1.MP3">预设音 1</option><option value="elonmusk.MP3">马斯克专属</option><option value="cz.MP3">CZ专属</option><option value="heyi.MP3">何一专属</option>`;
            els.audioSelect.innerHTML = baseOptions;
            els.editAudioSelect.innerHTML = baseOptions;
            els.customAudioList.innerHTML = '';

            Object.entries(customAudios).forEach(([customId, audioData]) => {
                const fileName = typeof audioData === 'string' ? '未知旧版音频' : audioData.name;
                const optStr = `<option value="${customId}">🎵 ${fileName}</option>`;
                els.audioSelect.insertAdjacentHTML('beforeend', optStr);
                els.editAudioSelect.insertAdjacentHTML('beforeend', optStr);

                const div = document.createElement('div');
                div.className = 'list-item';
                div.innerHTML = `
                    <div class="item-info">
                        <span class="item-title" title="${fileName}">${fileName}</span>
                    </div>
                    <div class="action-btns">
                        <button class="btn-icon play" data-id="${customId}">▶ 试听</button>
                        <button class="btn-icon del" data-id="${customId}">删除</button>
                    </div>
                `;

                div.querySelector('.play').addEventListener('click', () => {
                    const audioSrc = typeof customAudios[customId] === 'string' ? customAudios[customId] : customAudios[customId].data;
                    const audio = new Audio(audioSrc);
                    audio.volume = parseFloat(els.globalVolume.value);
                    audio.play().catch(e => showToast('播放失败'));
                });

                div.querySelector('.del').addEventListener('click', () => {
                    delete customAudios[customId];
                    chrome.storage.local.set({ customAudios }, () => {
                        showToast('音频文件已删除');
                        loadData();
                    });
                });
                els.customAudioList.appendChild(div);
            });

            if (Object.keys(customAudios).length === 0) els.customAudioList.innerHTML = '<div style="font-size:12px; color:#86868b; text-align:center;">暂无自定义音频</div>';

            els.rulesList.innerHTML = '';
            let needsSave = false; // 🌟 标记是否发生了自动修复

            Object.entries(mappings).forEach(([tid, audioVal]) => {
                const isObj = typeof audioVal === 'object' && audioVal !== null;
                let actualAudioId = isObj ? audioVal.id : audioVal;
                let displayAudioName = isObj ? (audioVal.name || '未知音频') : audioVal;
                const displayRemark = isObj ? (audioVal.remark || '') : '';

                if (!actualAudioId || typeof actualAudioId !== 'string') {
                    return;
                }

                // 🚀 【新增：旧规则自动无感修复机制】
                if (actualAudioId.startsWith('custom_') && !customAudios[actualAudioId]) {
                    // 如果旧 ID 找不到，去现有的音频库里找“名字一模一样”的文件
                    const foundEntry = Object.entries(customAudios).find(([k, v]) => v.name === displayAudioName);
                    if (foundEntry) {
                        actualAudioId = foundEntry[0]; // 提取新版本的文件名 ID
                        if (isObj) {
                            mappings[tid].id = actualAudioId;
                        } else {
                            mappings[tid] = { id: actualAudioId, name: displayAudioName };
                        }
                        needsSave = true; // 告诉系统稍后静默保存
                    }
                }

                // 正常渲染逻辑
                let statusTag = '';
                if (actualAudioId.startsWith('custom_') && !customAudios[actualAudioId]) {
                    statusTag = ' <span style="color:#ff3b30">(丢失,将播默认音)</span>';
                } else if (!isObj && customAudios[actualAudioId]) {
                    displayAudioName = customAudios[actualAudioId].name;
                } else if (actualAudioId === 'default.MP3') {
                    displayAudioName = '默认提示音';
                }

                const div = document.createElement('div');
                div.className = 'list-item';
                const titleText = displayRemark ? `@${tid} (${displayRemark})` : `@${tid}`;

                div.innerHTML = `
                    <div class="item-info">
                        <span class="item-title">${titleText}</span>
                        <span class="item-sub">${displayAudioName}${statusTag}</span>
                    </div>
                    <div class="action-btns">
                        <button class="btn-icon edit" data-tid="${tid}" data-audio="${actualAudioId}" data-remark="${displayRemark}">编辑</button>
                        <button class="btn-icon del" data-tid="${tid}">删除</button>
                    </div>
                `;

                div.querySelector('.del').addEventListener('click', () => {
                    delete mappings[tid];
                    chrome.storage.local.set({ twitterAudioMappings: mappings }, () => { showToast('规则已删除'); loadData(); });
                });

                div.querySelector('.edit').addEventListener('click', (e) => {
                    els.editTwitterId.value = e.target.dataset.tid;
                    els.editTwitterRemark.value = e.target.dataset.remark;
                    if (els.editAudioSelect.querySelector(`option[value="${e.target.dataset.audio}"]`)) {
                        els.editAudioSelect.value = e.target.dataset.audio;
                    } else {
                        els.editAudioSelect.value = 'default.MP3';
                    }
                    els.editModal.style.display = 'flex';
                });

                els.rulesList.appendChild(div);
            });

            // 🚀 如果触发了自愈机制，静默更新一次数据库，彻底修好这些老数据
            if (needsSave) {
                chrome.storage.local.set({ twitterAudioMappings: mappings });
            }

            if (Object.keys(mappings).length === 0) els.rulesList.innerHTML = '<div style="font-size:12px; color:#86868b; text-align:center;">暂无规则</div>';
        });
    }

    els.exportRulesBtn.addEventListener('click', () => {
        chrome.storage.local.get(['twitterAudioMappings'], (result) => {
            const mappings = result.twitterAudioMappings || {};
            const dataStr = JSON.stringify(mappings, null, 2);
            const blob = new Blob([dataStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const date = new Date();
            const yyyy = date.getFullYear();
            const mm = String(date.getMonth() + 1).padStart(2, '0');
            const dd = String(date.getDate()).padStart(2, '0');
            const a = document.createElement('a');
            a.href = url;
            a.download = `GmgnRules_${yyyy}${mm}${dd}.json`;
            a.click();
            URL.revokeObjectURL(url);
            showToast('规则导出成功');
        });
    });

    els.importRulesBtn.addEventListener('click', () => els.importRulesFile.click());
    els.importRulesFile.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function (event) {
            try {
                const importedMappings = JSON.parse(event.target.result);
                if (typeof importedMappings === 'object' && importedMappings !== null) {
                    chrome.storage.local.get(['twitterAudioMappings'], (result) => {
                        const currentMappings = result.twitterAudioMappings || {};

                        // 🌟 核心防重 3：精细合并，遇到重复的保留本地数据，不覆盖
                        let addedCount = 0;
                        let dupCount = 0;
                        for (const [key, val] of Object.entries(importedMappings)) {
                            if (currentMappings[key]) {
                                dupCount++; // 已存在，记为跳过
                            } else {
                                currentMappings[key] = val; // 不存在，安全追加
                                addedCount++;
                            }
                        }

                        chrome.storage.local.set({ twitterAudioMappings: currentMappings }, () => {
                            let msg = `规则导入: 新增 ${addedCount} 条`;
                            if (dupCount > 0) msg += `，跳过重复 ${dupCount} 条`;

                            showToast(msg, 3500);
                            els.importRulesFile.value = '';
                            loadData();
                        });
                    });
                } else {
                    showToast('导入失败：JSON格式错误');
                }
            } catch (err) {
                showToast('导入失败：无效的文件');
            }
        };
        reader.readAsText(file);
    });

    els.globalVolume.addEventListener('input', (e) => { els.volumePercent.textContent = Math.round(e.target.value * 100) + '%'; });
    els.globalVolume.addEventListener('change', (e) => { chrome.storage.local.set({ globalVolume: parseFloat(e.target.value) }); });
    els.masterToggle.addEventListener('change', (e) => { chrome.storage.local.set({ isMasterEnabled: e.target.checked }, () => { showToast(e.target.checked ? '监听已开启' : '监听已暂停'); }); });

    els.uploadBtn.addEventListener('click', async () => {
        const files = els.customAudioFile.files;
        if (!files || files.length === 0) return showToast('请先选择音频文件或 ZIP 压缩包！');

        const allowedExtensions = ['mp3', 'wav', 'ogg', 'aac', 'm4a', 'flac'];
        let successCount = 0;
        let failCount = 0;
        let duplicateCount = 0;

        // 显示正在导入的提示
        els.uploadBtn.textContent = '读取与解包中...';
        els.uploadBtn.disabled = true;

        chrome.storage.local.get(['customAudios'], async (result) => {
            const customAudios = result.customAudios || {};

            // 定义一个公共的保存函数，处理去重逻辑
            const processAudioData = (fileName, base64Data) => {
                const customId = `custom_file_${encodeURIComponent(fileName)}`;
                if (customAudios[customId]) {
                    duplicateCount++;
                } else {
                    customAudios[customId] = { name: fileName, data: base64Data };
                    successCount++;
                }
            };

            // 遍历用户选中的所有文件（可能是多个音频，也可能是多个 ZIP）
            const readPromises = Array.from(files).map(async (file) => {
                const fileName = file.name;
                const fileExtension = fileName.substring(fileName.lastIndexOf('.') + 1).toLowerCase();

                // 🚀 引擎 A：如果识别到是 ZIP 压缩包
                if (fileExtension === 'zip') {
                    try {
                        const zip = new JSZip();
                        const loadedZip = await zip.loadAsync(file);
                        const zipPromises = [];

                        loadedZip.forEach((relativePath, zipEntry) => {
                            // 过滤文件夹，并且过滤掉 Mac 系统自带的 __MACOSX 隐藏缓存文件
                            if (zipEntry.dir || relativePath.includes('__MACOSX') || relativePath.split('/').pop().startsWith('.')) {
                                return;
                            }

                            const entryExt = relativePath.substring(relativePath.lastIndexOf('.') + 1).toLowerCase();
                            if (!allowedExtensions.includes(entryExt)) {
                                return; // 忽略 ZIP 里的非音频文件（比如文本、图片）
                            }

                            // 提取纯文件名（去掉 ZIP 里的文件夹路径）
                            const pureFileName = relativePath.split('/').pop();

                            // 提取并转换为 Base64
                            const p = zipEntry.async('base64').then(base64Content => {
                                // 组装标准的 Data URI 格式供浏览器原生 Audio 播放
                                let mimeType = `audio/${entryExt}`;
                                if (entryExt === 'mp3') mimeType = 'audio/mpeg';
                                const fullBase64 = `data:${mimeType};base64,${base64Content}`;
                                processAudioData(pureFileName, fullBase64);
                            });
                            zipPromises.push(p);
                        });

                        await Promise.all(zipPromises); // 等待这个 ZIP 里的所有文件解压完毕
                    } catch (e) {
                        console.error("[GmgnAudioPlayer] ZIP 解析失败:", e);
                        failCount++;
                    }
                }
                // 🚀 引擎 B：如果是普通的单体音频文件
                else if (allowedExtensions.includes(fileExtension)) {
                    return new Promise((resolve) => {
                        const reader = new FileReader();
                        reader.onload = function (e) {
                            processAudioData(fileName, e.target.result);
                            resolve();
                        };
                        reader.onerror = () => {
                            failCount++;
                            resolve();
                        };
                        reader.readAsDataURL(file); // 读取为 Base64
                    });
                }
                // 非法文件
                else {
                    failCount++;
                }
            });

            // 等待所有文件（或 ZIP 包）全部处理完毕
            await Promise.all(readPromises);

            // 一次性批量保存到底层数据库
            chrome.storage.local.set({ customAudios }, () => {
                let msg = `导入成功: ${successCount}个`;
                if (duplicateCount > 0) msg += `，已存在跳过: ${duplicateCount}个`;
                if (failCount > 0) msg += `，解析失败: ${failCount}个`;

                showToast(msg, 3500);
                els.customAudioFile.value = ''; // 清空选择框
                els.uploadBtn.textContent = '导入音频(支持zip)';
                els.uploadBtn.disabled = false;
                loadData(); // 瞬间刷新列表
            });
        });
    });

    // 🌟 核心功能：一键提取本地音频并打包为 ZIP
    els.exportAudioZipBtn.addEventListener('click', async () => {
        chrome.storage.local.get(['customAudios'], async (result) => {
            const customAudios = result.customAudios || {};
            const keys = Object.keys(customAudios);

            if (keys.length === 0) {
                return showToast('音频库为空，没有可导出的音频！');
            }

            // 锁定按钮，防止重复点击
            els.exportAudioZipBtn.textContent = '正在打包...';
            els.exportAudioZipBtn.disabled = true;

            try {
                // 初始化 JSZip 实例
                const zip = new JSZip();
                const folder = zip.folder("GmgnAudio_Backup"); // 在压缩包里建一个专属文件夹

                // 遍历数据库中的所有音频
                for (const id of keys) {
                    const audioObj = customAudios[id];
                    // 兼容你的新老数据结构
                    const fileName = typeof audioObj === 'object' ? audioObj.name : `${id}.mp3`;
                    const base64Data = typeof audioObj === 'object' ? audioObj.data : audioObj;

                    // Base64 格式通常为 "data:audio/mp3;base64,xxxxx..."
                    // 我们需要使用 split 剥离协议头，只把纯 base64 数据体喂给 JSZip
                    const base64Content = base64Data.split(',')[1];

                    if (base64Content) {
                        // 告诉 JSZip 这是 base64 格式，它会自动在内存中还原成真实的二进制文件
                        folder.file(fileName, base64Content, { base64: true });
                    }
                }

                // 在本地内存中异步生成 ZIP 文件的 Blob 数据
                const zipBlob = await zip.generateAsync({ type: 'blob' });

                // 创建虚拟下载链接并触发下载
                const url = URL.createObjectURL(zipBlob);
                const date = new Date();
                const dateStr = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;

                const a = document.createElement('a');
                a.href = url;
                a.download = `Gmgn音频包备份_${dateStr}.zip`;
                a.click();

                // 释放内存
                URL.revokeObjectURL(url);
                showToast('🎉 音频包导出成功！', 3000);
            } catch (error) {
                console.error("[GmgnAudioPlayer] ZIP 打包失败:", error);
                showToast('打包失败，请重试！');
            } finally {
                // 恢复按钮状态
                els.exportAudioZipBtn.textContent = '导出ZIP备份';
                els.exportAudioZipBtn.disabled = false;
            }
        });
    });

    els.addRuleBtn.addEventListener('click', () => {
        const tid = els.twitterIdInput.value.trim().toLowerCase();
        const remark = els.twitterRemarkInput.value.trim();
        const selectedAudioId = els.audioSelect.value;
        const selectedAudioName = els.audioSelect.options[els.audioSelect.selectedIndex].text.replace('🎵 ', '');

        if (!tid) return showToast('请输入 Twitter ID');

        chrome.storage.local.get(['twitterAudioMappings'], (result) => {
            const mappings = result.twitterAudioMappings || {};

            // 🌟 核心防重 2：检查 ID 是否已经存在
            if (mappings[tid]) {
                return showToast('该推特规则已存在，请在下方列表直接编辑！', 3000);
            }

            mappings[tid] = { id: selectedAudioId, name: selectedAudioName, remark: remark };
            chrome.storage.local.set({ twitterAudioMappings: mappings }, () => {
                showToast('映射添加成功');
                els.twitterIdInput.value = '';
                els.twitterRemarkInput.value = '';
                loadData();
            });
        });
    });

    els.saveEditBtn.addEventListener('click', () => {
        const tid = els.editTwitterId.value; // 本身已经是存好的小写了
        const remark = els.editTwitterRemark.value.trim(); // 🌟 取修改后的备注
        const selectedAudioId = els.editAudioSelect.value;
        const selectedAudioName = els.editAudioSelect.options[els.editAudioSelect.selectedIndex].text.replace('🎵 ', '');

        chrome.storage.local.get(['twitterAudioMappings'], (result) => {
            const mappings = result.twitterAudioMappings || {};
            mappings[tid] = { id: selectedAudioId, name: selectedAudioName, remark: remark };
            chrome.storage.local.set({ twitterAudioMappings: mappings }, () => { showToast('修改保存成功'); els.editModal.style.display = 'none'; loadData(); });
        });
    });

    els.cancelEditBtn.addEventListener('click', () => els.editModal.style.display = 'none');
    loadData();
});