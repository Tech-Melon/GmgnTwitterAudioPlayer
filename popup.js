document.addEventListener('DOMContentLoaded', () => {
    const els = {
        masterToggle: document.getElementById('masterToggle'),
        globalVolume: document.getElementById('globalVolume'),
        volumePercent: document.getElementById('volumePercent'),
        uploadBtn: document.getElementById('uploadBtn'),
        customAudioFile: document.getElementById('customAudioFile'),
        addRuleBtn: document.getElementById('addRuleBtn'),
        twitterIdInput: document.getElementById('twitterId'),
        audioSelect: document.getElementById('audioSelect'),
        rulesList: document.getElementById('rulesList'),
        customAudioList: document.getElementById('customAudioList'),
        toast: document.getElementById('toast'),
        editModal: document.getElementById('editModal'),
        editTwitterId: document.getElementById('editTwitterId'),
        editAudioSelect: document.getElementById('editAudioSelect'),
        saveEditBtn: document.getElementById('saveEditBtn'),
        cancelEditBtn: document.getElementById('cancelEditBtn'),
        // 新增的导入导出元素
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

            // 将新增的三个音频补充到代码的默认选项字符串中
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
                    // 🌟 需求 2：不在这里修改 mappings，规则依然保留
                    chrome.storage.local.set({ customAudios }, () => {
                        showToast('音频文件已删除');
                        loadData();
                    });
                });
                els.customAudioList.appendChild(div);
            });

            if (Object.keys(customAudios).length === 0) els.customAudioList.innerHTML = '<div style="font-size:12px; color:#86868b; text-align:center;">暂无自定义音频</div>';

            els.rulesList.innerHTML = '';
            Object.entries(mappings).forEach(([tid, audioVal]) => {
                // 兼容新老数据结构
                const isObj = typeof audioVal === 'object';
                const actualAudioId = isObj ? audioVal.id : audioVal;
                let displayAudioName = isObj ? audioVal.name : audioVal;

                // 🌟 如果是自定义音频，且文件被删除了，增加红字提示，但不改变原始规则
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
                div.innerHTML = `
                    <div class="item-info">
                        <span class="item-title">@${tid}</span>
                        <span class="item-sub">${displayAudioName}${statusTag}</span>
                    </div>
                    <div class="action-btns">
                        <button class="btn-icon edit" data-tid="${tid}" data-audio="${actualAudioId}">编辑</button>
                        <button class="btn-icon del" data-tid="${tid}">删除</button>
                    </div>
                `;

                div.querySelector('.del').addEventListener('click', () => {
                    delete mappings[tid];
                    chrome.storage.local.set({ twitterAudioMappings: mappings }, () => { showToast('规则已删除'); loadData(); });
                });

                div.querySelector('.edit').addEventListener('click', (e) => {
                    els.editTwitterId.value = e.target.dataset.tid;
                    // 如果音频丢失了，下拉菜单里没这个选项，这里强制设为 default 或者给个兜底
                    if (els.editAudioSelect.querySelector(`option[value="${e.target.dataset.audio}"]`)) {
                        els.editAudioSelect.value = e.target.dataset.audio;
                    } else {
                        els.editAudioSelect.value = 'default.MP3';
                    }
                    els.editModal.style.display = 'flex';
                });

                els.rulesList.appendChild(div);
            });

            if (Object.keys(mappings).length === 0) els.rulesList.innerHTML = '<div style="font-size:12px; color:#86868b; text-align:center;">暂无规则</div>';
        });
    }

    // 🌟 需求 1 & 5：导出规则 (带有年月日后缀的 JSON)
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

    // 🌟 需求 1 & 4：导入规则 (解耦，只导映射)
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
                        // 采用合并策略（覆盖同名规则，保留现有规则）
                        const newMappings = { ...currentMappings, ...importedMappings };
                        chrome.storage.local.set({ twitterAudioMappings: newMappings }, () => {
                            showToast('规则导入成功');
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

    els.uploadBtn.addEventListener('click', () => {
        const file = els.customAudioFile.files[0];
        if (!file) return showToast('请先选择一个音频文件！');
        const fileName = file.name;
        const fileExtension = fileName.substring(fileName.lastIndexOf('.') + 1).toLowerCase();
        const allowedExtensions = ['mp3', 'wav', 'ogg', 'aac', 'm4a', 'flac'];

        if (!allowedExtensions.includes(fileExtension)) {
            els.customAudioFile.value = '';
            return showToast(`不支持该格式，仅支持: ${allowedExtensions.join(',')}`);
        }

        const reader = new FileReader();
        reader.onload = function (e) {
            const base64Audio = e.target.result;
            const customId = `custom_${Date.now()}_${fileExtension}`;
            chrome.storage.local.get(['customAudios'], (result) => {
                const customAudios = result.customAudios || {};
                customAudios[customId] = { name: fileName, data: base64Audio };
                chrome.storage.local.set({ customAudios }, () => { showToast('导入成功'); els.customAudioFile.value = ''; loadData(); });
            });
        };
        reader.onerror = () => showToast('读取文件失败，请重试');
        reader.readAsDataURL(file);
    });

    els.addRuleBtn.addEventListener('click', () => {
        const tid = els.twitterIdInput.value.trim();
        const selectedAudioId = els.audioSelect.value;
        const selectedAudioName = els.audioSelect.options[els.audioSelect.selectedIndex].text.replace('🎵 ', '');

        if (!tid) return showToast('请输入 Twitter ID');
        chrome.storage.local.get(['twitterAudioMappings'], (result) => {
            const mappings = result.twitterAudioMappings || {};
            // 🌟 核心修改：保存为对象，记住文件的名称
            mappings[tid] = { id: selectedAudioId, name: selectedAudioName };
            chrome.storage.local.set({ twitterAudioMappings: mappings }, () => { showToast('映射添加成功'); els.twitterIdInput.value = ''; loadData(); });
        });
    });

    els.saveEditBtn.addEventListener('click', () => {
        const tid = els.editTwitterId.value;
        const selectedAudioId = els.editAudioSelect.value;
        const selectedAudioName = els.editAudioSelect.options[els.editAudioSelect.selectedIndex].text.replace('🎵 ', '');

        chrome.storage.local.get(['twitterAudioMappings'], (result) => {
            const mappings = result.twitterAudioMappings || {};
            mappings[tid] = { id: selectedAudioId, name: selectedAudioName };
            chrome.storage.local.set({ twitterAudioMappings: mappings }, () => { showToast('修改保存成功'); els.editModal.style.display = 'none'; loadData(); });
        });
    });

    els.cancelEditBtn.addEventListener('click', () => els.editModal.style.display = 'none');
    loadData();
});