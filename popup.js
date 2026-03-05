document.addEventListener('DOMContentLoaded', () => {
    // 极简 HTML 转义工具
    const escapeHTML = (str) => String(str).replace(/[&<>'"]/g,
        tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
    );

    // 极客版可搜索下拉框的核心驱动函数
    const els = {
        masterToggle: document.getElementById('masterToggle'),
        playDefaultToggle: document.getElementById('playDefaultToggle'), // 🌟 新增的未映射播放开关
        globalVolume: document.getElementById('globalVolume'),
        volumePercent: document.getElementById('volumePercent'),
        uploadBtn: document.getElementById('uploadBtn'),
        exportAudioZipBtn: document.getElementById('exportAudioZipBtn'),
        customAudioFile: document.getElementById('customAudioFile'),
        addRuleBtn: document.getElementById('addRuleBtn'),
        twitterIdInput: document.getElementById('twitterId'),
        twitterRemarkInput: document.getElementById('twitterRemark'),
        rulesList: document.getElementById('rulesList'),
        customAudioList: document.getElementById('customAudioList'),
        toast: document.getElementById('toast'),
        editModal: document.getElementById('editModal'),
        editTwitterId: document.getElementById('editTwitterId'),
        editTwitterRemark: document.getElementById('editTwitterRemark'),
        saveEditBtn: document.getElementById('saveEditBtn'),
        cancelEditBtn: document.getElementById('cancelEditBtn'),
        exportRulesBtn: document.getElementById('exportRulesBtn'),
        importRulesBtn: document.getElementById('importRulesBtn'),
        importRulesFile: document.getElementById('importRulesFile'),
        searchInput: document.getElementById('searchInput'),

        // 🌟 事件过滤复选框
        filterTweet: document.getElementById('filterTweet'),
        filterRepost: document.getElementById('filterRepost'),
        filterReply: document.getElementById('filterReply'),
        filterQuote: document.getElementById('filterQuote'),
        filterOther: document.getElementById('filterOther') // 🌟 新增
    };

    function showToast(message, duration = 2000) {
        els.toast.textContent = message;
        els.toast.classList.add('show');
        setTimeout(() => els.toast.classList.remove('show'), duration);
    }

    // 🌟 极客版可搜索下拉框的核心驱动函数
    function setupCustomDropdown(triggerId, menuId, searchId, listId, valueId, nameId) {
        const trigger = document.getElementById(triggerId);
        const menu = document.getElementById(menuId);
        const search = document.getElementById(searchId);
        const list = document.getElementById(listId);
        const valInput = document.getElementById(valueId);
        const nameInput = document.getElementById(nameId);

        // 🌟 核心修复：阻止菜单内部的点击事件冒泡，防止触发全局关闭
        menu.addEventListener('click', (e) => {
            e.stopPropagation();
        });

        // 点击展开/收起
        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            const isShowing = menu.classList.contains('show');
            document.querySelectorAll('.custom-dropdown-menu').forEach(m => m.classList.remove('show')); // 关闭其他
            if (!isShowing) {
                menu.classList.add('show');
                search.value = ''; // 清空搜索词
                search.focus();
                Array.from(list.children).forEach(child => child.style.display = 'block'); // 恢复所有选项
            }
        });

        // 点击选项事件委托
        list.addEventListener('click', (e) => {
            if (e.target.classList.contains('custom-dropdown-item')) {
                const id = e.target.dataset.value;
                const name = e.target.dataset.name;
                valInput.value = id;
                nameInput.value = name;
                trigger.querySelector('span').textContent = name;
                menu.classList.remove('show');
            }
        });

        // 搜索过滤逻辑
        search.addEventListener('input', (e) => {
            const term = e.target.value.toLowerCase();
            Array.from(list.children).forEach(child => {
                const text = child.dataset.name.toLowerCase();
                child.style.display = text.includes(term) ? 'block' : 'none';
            });
        });
    }

    // 全局点击关闭下拉框
    document.addEventListener('click', () => {
        document.querySelectorAll('.custom-dropdown-menu').forEach(m => m.classList.remove('show'));
    });

    // 初始化两个下拉框
    setupCustomDropdown('addSelectTrigger', 'addSelectMenu', 'addSelectSearch', 'addSelectList', 'addAudioValue', 'addAudioName');
    setupCustomDropdown('editSelectTrigger', 'editSelectMenu', 'editSelectSearch', 'editSelectList', 'editAudioValue', 'editAudioName');


    function loadData() {
        chrome.storage.local.get(['twitterAudioMappings', 'customAudios', 'isMasterEnabled', 'globalVolume', 'eventFilters', 'playDefaultUnmapped'], (result) => {
            const mappings = result.twitterAudioMappings || {};
            const customAudios = result.customAudios || {};

            // 默认全开，包含 other
            const filters = result.eventFilters || { tweet: true, repost: true, reply: true, quote: true, other: true };

            els.masterToggle.checked = result.isMasterEnabled !== false;
            // 🌟 默认勾选，所以当 undefined 时也为 true
            els.playDefaultToggle.checked = result.playDefaultUnmapped !== false;
            els.filterTweet.checked = filters.tweet !== false;
            els.filterRepost.checked = filters.repost !== false;
            els.filterReply.checked = filters.reply !== false;
            els.filterQuote.checked = filters.quote !== false;
            els.filterOther.checked = filters.other !== false; // 🌟 新增

            if (result.globalVolume !== undefined) {
                els.globalVolume.value = result.globalVolume;
                els.volumePercent.textContent = Math.round(result.globalVolume * 100) + '%';
            }

            // 🌟 渲染音频列表给自定义下拉框
            const defaultOptions = [
                { id: 'default.MP3', name: '默认提示音' },
                { id: 'preset1.MP3', name: '预设音 1' },
                { id: 'elonmusk.MP3', name: '马斯克专属' },
                { id: 'cz.MP3', name: 'CZ专属' },
                { id: 'heyi.MP3', name: '何一专属' }
            ];

            let optionsHtml = '';
            defaultOptions.forEach(opt => {
                optionsHtml += `<div class="custom-dropdown-item" data-value="${opt.id}" data-name="${opt.name}">${opt.name}</div>`;
            });

            els.customAudioList.innerHTML = '';
            Object.entries(customAudios).forEach(([customId, audioData]) => {
                const fileName = typeof audioData === 'string' ? '未知旧版音频' : audioData.name;
                optionsHtml += `<div class="custom-dropdown-item" data-value="${customId}" data-name="🎵 ${fileName}">🎵 ${fileName}</div>`;

                const div = document.createElement('div');
                div.className = 'list-item';
                const safeTitle = escapeHTML(fileName);
                div.innerHTML = `
                    <div class="item-info">
                        <span class="item-title" title="${safeTitle}">${safeTitle}</span>
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

            // 灌入两个下拉框
            document.getElementById('addSelectList').innerHTML = optionsHtml;
            document.getElementById('editSelectList').innerHTML = optionsHtml;

            if (Object.keys(customAudios).length === 0) els.customAudioList.innerHTML = '<div style="font-size:12px; color:#86868b; text-align:center;">暂无自定义音频</div>';

            els.rulesList.innerHTML = '';
            let needsSave = false;

            Object.entries(mappings)
                .sort((a, b) => a[0].localeCompare(b[0]))
                .forEach(([tid, audioVal]) => {
                    const isObj = typeof audioVal === 'object' && audioVal !== null;
                    let actualAudioId = isObj ? audioVal.id : audioVal;
                    let displayAudioName = isObj ? (audioVal.name || '未知音频') : audioVal;
                    const displayRemark = isObj ? (audioVal.remark || '') : '';

                    if (!actualAudioId || typeof actualAudioId !== 'string') return;

                    if (actualAudioId.startsWith('custom_') && !customAudios[actualAudioId]) {
                        const foundEntry = Object.entries(customAudios).find(([k, v]) => v.name === displayAudioName.replace('🎵 ', ''));
                        if (foundEntry) {
                            actualAudioId = foundEntry[0];
                            if (isObj) mappings[tid].id = actualAudioId;
                            else mappings[tid] = { id: actualAudioId, name: displayAudioName };
                            needsSave = true;
                        }
                    }

                    let statusTag = '';
                    if (actualAudioId.startsWith('custom_') && !customAudios[actualAudioId]) {
                        statusTag = ' <span style="color:#ff3b30">(丢失,将播默认音)</span>';
                    } else if (!isObj && customAudios[actualAudioId]) {
                        displayAudioName = `🎵 ${customAudios[actualAudioId].name}`;
                    } else if (actualAudioId === 'default.MP3') {
                        displayAudioName = '默认提示音';
                    }

                    const div = document.createElement('div');
                    div.className = 'list-item';
                    // ✅ 修改后：给涉及 DOM 属性注入的所有变量套上 escapeHTML 铠甲
                    const safeTid = escapeHTML(tid);
                    const safeRemark = escapeHTML(displayRemark);
                    const safeAudioName = escapeHTML(displayAudioName);
                    const safeActualAudioId = escapeHTML(actualAudioId); // 追加对 audioId 的防范，做到滴水不漏

                    const titleText = displayRemark
                        ? `@${safeTid} <span style="color: #ff9500; font-size: 11px; font-weight: normal; margin-left: 4px;">(${safeRemark})</span>`
                        : `@${safeTid}`;

                    div.innerHTML = `
                        <div class="item-info">
                            <span class="item-title">${titleText}</span>
                            <span class="item-sub">${safeAudioName}${statusTag}</span>
                        </div>
                        <div class="action-btns">
                            <button class="btn-icon edit" data-tid="${safeTid}" data-audio="${safeActualAudioId}" data-audioname="${safeAudioName}" data-remark="${safeRemark}">编辑</button>
                            <button class="btn-icon del" data-tid="${safeTid}">删除</button>
                        </div>
                    `;

                    div.querySelector('.del').addEventListener('click', () => {
                        delete mappings[tid];
                        chrome.storage.local.set({ twitterAudioMappings: mappings }, () => { showToast('规则已删除'); loadData(); });
                    });

                    div.querySelector('.edit').addEventListener('click', (e) => {
                        els.editTwitterId.value = e.target.dataset.tid;
                        els.editTwitterRemark.value = e.target.dataset.remark;

                        // 🌟 还原下拉框状态
                        const audioId = e.target.dataset.audio;
                        let audioName = e.target.dataset.audioname;
                        if (audioId.startsWith('custom_') && !customAudios[audioId]) audioName = '默认提示音 (原文件丢失)';

                        document.getElementById('editAudioValue').value = audioId;
                        document.getElementById('editAudioName').value = audioName;
                        document.getElementById('editSelectTrigger').querySelector('span').textContent = audioName;

                        els.editModal.style.display = 'flex';
                    });

                    els.rulesList.appendChild(div);
                });

            if (needsSave) chrome.storage.local.set({ twitterAudioMappings: mappings });
            if (Object.keys(mappings).length === 0) els.rulesList.innerHTML = '<div style="font-size:12px; color:#86868b; text-align:center;">暂无规则</div>';
        });
    }

    // 🌟 监听过滤开关变化，并保存到数据库
    const saveFilters = () => {
        chrome.storage.local.set({
            eventFilters: {
                tweet: els.filterTweet.checked,
                repost: els.filterRepost.checked,
                reply: els.filterReply.checked,
                quote: els.filterQuote.checked,
                other: els.filterOther.checked // 🌟 新增
            }
        });
    };
    els.filterTweet.addEventListener('change', saveFilters);
    els.filterRepost.addEventListener('change', saveFilters);
    els.filterReply.addEventListener('change', saveFilters);
    els.filterQuote.addEventListener('change', saveFilters);
    els.filterOther.addEventListener('change', saveFilters); // 🌟 新增

    els.exportRulesBtn.addEventListener('click', () => {
        chrome.storage.local.get(['twitterAudioMappings'], (result) => {
            const dataStr = JSON.stringify(result.twitterAudioMappings || {}, null, 2);
            const blob = new Blob([dataStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `GmgnRules_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.json`;
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
                        let addedCount = 0, dupCount = 0;
                        for (const [key, val] of Object.entries(importedMappings)) {
                            const cleanKey = key.trim().toLowerCase();
                            if (!cleanKey) continue;
                            if (currentMappings[cleanKey]) dupCount++;
                            else { currentMappings[cleanKey] = val; addedCount++; }
                        }
                        chrome.storage.local.set({ twitterAudioMappings: currentMappings }, () => {
                            showToast(`新增 ${addedCount} 条，跳过重复 ${dupCount} 条`, 3500);
                            els.importRulesFile.value = '';
                            loadData();
                        });
                    });
                }
            } catch (err) {
                showToast('导入失败：无效的文件');
                els.importRulesFile.value = '';
            }
        };
        reader.readAsText(file);
    });

    els.searchInput.addEventListener('input', (e) => {
        const searchTerm = e.target.value.trim().toLowerCase();
        els.rulesList.querySelectorAll('.list-item').forEach(item => {
            const textContent = item.querySelector('.item-info').textContent.toLowerCase();
            item.style.display = textContent.includes(searchTerm) ? 'flex' : 'none';
        });
    });

    els.globalVolume.addEventListener('input', (e) => { els.volumePercent.textContent = Math.round(e.target.value * 100) + '%'; });
    els.globalVolume.addEventListener('change', (e) => { chrome.storage.local.set({ globalVolume: parseFloat(e.target.value) }); });
    els.masterToggle.addEventListener('change', (e) => { chrome.storage.local.set({ isMasterEnabled: e.target.checked }, () => { showToast(e.target.checked ? '监听已开启' : '监听已暂停'); }); });
    els.playDefaultToggle.addEventListener('change', (e) => {
        chrome.storage.local.set({ playDefaultUnmapped: e.target.checked }, () => {
            // 🌟 原文：showToast(e.target.checked ? '未映射将播放默认音' : '未映射将静默推送');
            showToast(e.target.checked ? '已开启默认音频' : '已关闭默认音频');
        });
    });
    els.uploadBtn.addEventListener('click', async () => {
        const files = els.customAudioFile.files;
        if (!files || files.length === 0) return showToast('请先选择音频或 ZIP！');

        const allowedExtensions = ['mp3', 'wav', 'ogg', 'aac', 'm4a', 'flac'];
        let successCount = 0, failCount = 0, duplicateCount = 0;

        els.uploadBtn.textContent = '解包处理中...';
        els.uploadBtn.disabled = true;

        // 🌟 技巧 1：让出主线程，让 UI 按钮先变成“处理中”的状态
        await new Promise(resolve => setTimeout(resolve, 50));

        // 🌟 修复：先获取数据，再在外部处理循环，避免在 for 循环内部包裹回调
        const result = await new Promise(resolve => chrome.storage.local.get(['customAudios'], resolve));
        const customAudios = result.customAudios || {};

        const processAudioData = (fileName, base64Data) => {
            const customId = `custom_file_${encodeURIComponent(fileName)}`;
            if (customAudios[customId]) {
                duplicateCount++;
            } else {
                customAudios[customId] = { name: fileName, data: base64Data };
                successCount++;
            }
        };

        // 🌟 技巧 2：将并行的 Promise.all 改为串行 await，防止瞬间撑爆内存
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const fileName = file.name;
            const fileExt = fileName.substring(fileName.lastIndexOf('.') + 1).toLowerCase();

            if (fileExt === 'zip') {
                try {
                    const zip = new JSZip();
                    const loadedZip = await zip.loadAsync(file);

                    // 先收集所有有效的压缩包文件条目
                    const zipEntries = [];
                    loadedZip.forEach((relativePath, zipEntry) => {
                        if (zipEntry.dir || relativePath.includes('__MACOSX') || relativePath.split('/').pop().startsWith('.')) return;
                        const entryExt = relativePath.substring(relativePath.lastIndexOf('.') + 1).toLowerCase();
                        if (allowedExtensions.includes(entryExt)) zipEntries.push({ relativePath, zipEntry, entryExt });
                    });

                    // 逐个解析 Base64，避免并发过高
                    for (let j = 0; j < zipEntries.length; j++) {
                        const entry = zipEntries[j];
                        const base64Content = await entry.zipEntry.async('base64');
                        let mimeType = `audio/${entry.entryExt}`;
                        if (entry.entryExt === 'mp3') mimeType = 'audio/mpeg';

                        processAudioData(entry.relativePath.split('/').pop(), `data:${mimeType};base64,${base64Content}`);

                        // 🌟 技巧 3：每处理完一个文件，呼吸一次，防止假死
                        await new Promise(resolve => setTimeout(resolve, 0));
                    }
                } catch (e) { failCount++; }
            } else if (allowedExtensions.includes(fileExt)) {
                await new Promise((resolve) => {
                    const reader = new FileReader();
                    reader.onload = function (e) { processAudioData(fileName, e.target.result); resolve(); };
                    reader.onerror = () => { failCount++; resolve(); };
                    reader.readAsDataURL(file);
                });
            } else failCount++;
        }

        // 保存处理后的结果
        chrome.storage.local.set({ customAudios }, () => {
            showToast(`导入: ${successCount}个，已存在跳过: ${duplicateCount}个`, 3500);
            els.customAudioFile.value = '';
            els.uploadBtn.textContent = '导入音频(支持zip)';
            els.uploadBtn.disabled = false;
            loadData();
        });
    });

    els.exportAudioZipBtn.addEventListener('click', async () => {
        chrome.storage.local.get(['customAudios'], async (result) => {
            const customAudios = result.customAudios || {};
            const keys = Object.keys(customAudios);
            if (keys.length === 0) return showToast('音频库为空！');

            els.exportAudioZipBtn.textContent = '打包中...';
            els.exportAudioZipBtn.disabled = true;

            // 🌟 同样先让出主线程，刷新 UI
            await new Promise(resolve => setTimeout(resolve, 50));

            try {
                const zip = new JSZip();
                const folder = zip.folder("GmgnAudio_Backup");

                // 串行压入文件
                for (let i = 0; i < keys.length; i++) {
                    const id = keys[i];
                    const audioObj = customAudios[id];
                    const fileName = typeof audioObj === 'object' ? audioObj.name : `${id}.mp3`;
                    const base64Content = (typeof audioObj === 'object' ? audioObj.data : audioObj).split(',')[1];
                    if (base64Content) folder.file(fileName, base64Content, { base64: true });

                    // 每压入 5 个文件，让主线程呼吸一次
                    if (i % 5 === 0) await new Promise(resolve => setTimeout(resolve, 0));
                }

                // 🌟 技巧 4：compression: "STORE" 是降维打击！
                // 音频本就压缩过，强行 DEFLATE 浪费极其严重的 CPU，改为 STORE 直接打包存储，速度飞起！
                const zipBlob = await zip.generateAsync({
                    type: 'blob',
                    compression: "STORE"
                });

                const a = document.createElement('a');
                a.href = URL.createObjectURL(zipBlob);
                a.download = `Gmgn音频备份_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.zip`;
                a.click();
                showToast('🎉 导出成功！', 3000);
            } catch (error) {
                showToast('打包失败！');
            } finally {
                els.exportAudioZipBtn.textContent = '导出ZIP备份';
                els.exportAudioZipBtn.disabled = false;
            }
        });
    });

    // 🌟 修复：使用新的下拉框引擎读取数值
    els.addRuleBtn.addEventListener('click', () => {
        const tid = els.twitterIdInput.value.trim().toLowerCase().replace(/^@/, '');
        const remark = els.twitterRemarkInput.value.trim();
        const selectedAudioId = document.getElementById('addAudioValue').value;
        const selectedAudioName = document.getElementById('addAudioName').value.replace('🎵 ', '');

        if (!tid) return showToast('请输入 Twitter ID');

        chrome.storage.local.get(['twitterAudioMappings'], (result) => {
            const mappings = result.twitterAudioMappings || {};
            if (mappings[tid]) return showToast('该规则已存在，请编辑！', 3000);

            mappings[tid] = { id: selectedAudioId, name: selectedAudioName, remark: remark };
            chrome.storage.local.set({ twitterAudioMappings: mappings }, () => {
                showToast('映射添加成功');
                els.twitterIdInput.value = '';
                els.twitterRemarkInput.value = '';

                // 重置下拉框为默认状态
                document.getElementById('addAudioValue').value = 'default.MP3';
                document.getElementById('addAudioName').value = '默认提示音';
                document.getElementById('addSelectTrigger').querySelector('span').textContent = '默认提示音';

                loadData();
            });
        });
    });

    els.saveEditBtn.addEventListener('click', () => {
        const tid = els.editTwitterId.value.trim().toLowerCase().replace(/^@/, '');
        const remark = els.editTwitterRemark.value.trim();
        const selectedAudioId = document.getElementById('editAudioValue').value;
        const selectedAudioName = document.getElementById('editAudioName').value.replace('🎵 ', '');

        chrome.storage.local.get(['twitterAudioMappings'], (result) => {
            const mappings = result.twitterAudioMappings || {};
            mappings[tid] = { id: selectedAudioId, name: selectedAudioName, remark: remark };
            chrome.storage.local.set({ twitterAudioMappings: mappings }, () => { showToast('修改成功'); els.editModal.style.display = 'none'; loadData(); });
        });
    });

    els.cancelEditBtn.addEventListener('click', () => els.editModal.style.display = 'none');
    loadData();
});