document.addEventListener('DOMContentLoaded', () => {
    // ☁️ Cloudflare Edge-TTS Worker API 统一入口
    const CF_TTS_API = "https://cloudflare-edge-tts.tech-melon.workers.dev/tts";

    // 极简 HTML 转义工具
    const escapeHTML = (str) => String(str).replace(/[&<>'"]/g,
        tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
    );

    const fetchTTS = (body) => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        return fetch(CF_TTS_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: ctrl.signal
        }).finally(() => clearTimeout(timer));
    };

    let sharedAudioCtx = null;
    function applyGainToAudio(audio, volume) {
        if (volume <= 1.0) {
            audio.volume = Math.max(0, volume);
            return;
        }
        audio.volume = 1.0;
        try {
            if (!sharedAudioCtx) sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (sharedAudioCtx.state === 'suspended') sharedAudioCtx.resume();
            if (!audio.__sourceNode) {
                audio.__sourceNode = sharedAudioCtx.createMediaElementSource(audio);
                const gainNode = sharedAudioCtx.createGain();
                audio.__gainNode = gainNode;
                audio.__sourceNode.connect(gainNode);
                gainNode.connect(sharedAudioCtx.destination);
                audio.addEventListener('ended', () => {
                    try { audio.__sourceNode.disconnect(); } catch (e) { }
                    try { audio.__gainNode.disconnect(); } catch (e) { }
                    delete audio.__sourceNode;
                    delete audio.__gainNode;
                }, { once: true });
            }
            audio.__gainNode.gain.value = volume;
        } catch (e) {
            console.warn("[GMGN 盯盘伴侣] 超级音量失败:", e);
        }
    }

    // 🌟 Tab 切换逻辑（带状态持久化，重新打开插件时保留上次页面）
    const switchTab = (tabId) => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        const btn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
        if (btn) btn.classList.add('active');
        const panel = document.getElementById(tabId);
        if (panel) panel.classList.add('active');
        chrome.storage.local.set({ popupActiveTab: tabId });
    };

    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => switchTab(e.target.dataset.tab));
    });

    // 恢复上次活跃的 Tab
    chrome.storage.local.get(['popupActiveTab'], (result) => {
        if (result.popupActiveTab) switchTab(result.popupActiveTab);
    });

    // 极客版可搜索下拉框的核心驱动函数
    const els = {
        masterToggle: document.getElementById('masterToggle'),
        enableTwitterToggle: document.getElementById('enableTwitterToggle'),
        enableWalletToggle: document.getElementById('enableWalletToggle'),
        playDefaultToggle: document.getElementById('playDefaultToggle'), // 🌟 新增的未映射播放开关
        enableTTSToggle: document.getElementById('enableTTSToggle'), // 🌟 新增的 TTS 开关
        twitterTtsVoiceSelect: document.getElementById('twitterTtsVoiceSelect'),
        twitterTtsRateSelect: document.getElementById('twitterTtsRateSelect'),
        twitterTtsPitchSelect: document.getElementById('twitterTtsPitchSelect'),
        twitterTtsTestBtn: document.getElementById('twitterTtsTestBtn'),
        twitterVolume: document.getElementById('twitterVolume'),
        twitterVolumePercent: document.getElementById('twitterVolumePercent'),
        walletTtsVoiceSelect: document.getElementById('walletTtsVoiceSelect'),
        walletTtsRateSelect: document.getElementById('walletTtsRateSelect'),
        walletTtsPitchSelect: document.getElementById('walletTtsPitchSelect'),
        walletTtsTestBtn: document.getElementById('walletTtsTestBtn'),
        walletVolume: document.getElementById('walletVolume'),
        walletVolumePercent: document.getElementById('walletVolumePercent'),
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
        filterOther: document.getElementById('filterOther'),

        // Wallet Elements
        filterBuy: document.getElementById('filterBuy'),
        filterSellReduce: document.getElementById('filterSellReduce'),
        filterSellClear: document.getElementById('filterSellClear'),
        testWalletBuyBtn: document.getElementById('testWalletBuyBtn'),
        testWalletSellReduceBtn: document.getElementById('testWalletSellReduceBtn'),
        testWalletSellClearBtn: document.getElementById('testWalletSellClearBtn'),
        // 🧊 冷却器 UI 元素 — 同币冷却
        buyCooldownEnabled: document.getElementById('buyCooldownEnabled'),
        buyCooldownTime: document.getElementById('buyCooldownTime'),
        buyCooldownLabel: document.getElementById('buyCooldownLabel'),
        buyCooldownPanel: document.getElementById('buyCooldownPanel'),
        sellReduceCooldownEnabled: document.getElementById('sellReduceCooldownEnabled'),
        sellReduceCooldownTime: document.getElementById('sellReduceCooldownTime'),
        sellReduceCooldownLabel: document.getElementById('sellReduceCooldownLabel'),
        sellReduceCooldownPanel: document.getElementById('sellReduceCooldownPanel'),
        // 🏠 冷却器 UI 元素 — 同址冷却
        buyAddrCooldownEnabled: document.getElementById('buyAddrCooldownEnabled'),
        buyAddrCooldownTime: document.getElementById('buyAddrCooldownTime'),
        buyAddrCooldownLabel: document.getElementById('buyAddrCooldownLabel'),
        sellReduceAddrCooldownEnabled: document.getElementById('sellReduceAddrCooldownEnabled'),
        sellReduceAddrCooldownTime: document.getElementById('sellReduceAddrCooldownTime'),
        sellReduceAddrCooldownLabel: document.getElementById('sellReduceAddrCooldownLabel'),
        sellClearCooldownPanel: document.getElementById('sellClearCooldownPanel'),
        sellClearAddrCooldownEnabled: document.getElementById('sellClearAddrCooldownEnabled'),
        sellClearAddrCooldownTime: document.getElementById('sellClearAddrCooldownTime'),
        sellClearAddrCooldownLabel: document.getElementById('sellClearAddrCooldownLabel'),
        walletMinAmount: document.getElementById('walletMinAmount'),
        walletMaxAmount: document.getElementById('walletMaxAmount'),
        walletMinMcap: document.getElementById('walletMinMcap'),
        walletMaxMcap: document.getElementById('walletMaxMcap'),
        walletMinAge: document.getElementById('walletMinAge'),
        walletMaxAge: document.getElementById('walletMaxAge'),
        walletDictInput: document.getElementById('walletDictInput'),
        importWalletDictBtn: document.getElementById('importWalletDictBtn'),
        clearWalletDictBtn: document.getElementById('clearWalletDictBtn'),
        walletDictStatus: document.getElementById('walletDictStatus'),
        walletSearchInput: document.getElementById('walletSearchInput'),
        walletList: document.getElementById('walletList'),
        walletEditModal: document.getElementById('walletEditModal'),
        editWalletAddress: document.getElementById('editWalletAddress'),
        editWalletName: document.getElementById('editWalletName'),
        cancelWalletEditBtn: document.getElementById('cancelWalletEditBtn'),
        saveWalletEditBtn: document.getElementById('saveWalletEditBtn'),
        customWalletName: document.getElementById('customWalletName'),
        customWalletAddress: document.getElementById('customWalletAddress'),
        addCustomWalletBtn: document.getElementById('addCustomWalletBtn')
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
        chrome.storage.local.get([
            'twitterAudioMappings', 'customAudios', 'isMasterEnabled', 'enableTwitter', 'enableWallet', 
            'globalVolume', 'twitterVolume', 'walletVolume', 'eventFilters', 'playDefaultUnmapped', 
            'enableTTS', 'ttsVoice', 'ttsRate', 'ttsPitch', 'twitterTts', 'walletTts', 
            'walletFilters', 'walletDictionary'
        ], (result) => {
            const mappings = result.twitterAudioMappings || {};
            const customAudios = result.customAudios || {};

            // 默认全开，包含 other
            const filters = result.eventFilters || { tweet: true, repost: true, reply: true, quote: true, other: true };

            els.masterToggle.checked = result.isMasterEnabled !== false;
            els.enableTwitterToggle.checked = result.enableTwitter !== false;
            els.enableWalletToggle.checked = result.enableWallet !== false;
            els.playDefaultToggle.checked = result.playDefaultUnmapped !== false;
            els.enableTTSToggle.checked = result.enableTTS !== false;

            // 🌟 迁移和初始化音量设置
            const defaultVol = result.globalVolume !== undefined ? result.globalVolume : 1;
            const tVol = result.twitterVolume !== undefined ? result.twitterVolume : defaultVol;
            const wVol = result.walletVolume !== undefined ? result.walletVolume : defaultVol;
            
            els.twitterVolume.value = tVol;
            els.twitterVolumePercent.textContent = Math.round(tVol * 100) + '%';
            els.walletVolume.value = wVol;
            els.walletVolumePercent.textContent = Math.round(wVol * 100) + '%';

            // 🌟 迁移和初始化 TTS 设置
            const oldTts = {
                voice: result.ttsVoice || 'zh-CN-XiaoxiaoNeural',
                rate: result.ttsRate || '+0%',
                pitch: result.ttsPitch || '+0%'
            };

            const twitterTts = result.twitterTts || oldTts;
            const walletTts = result.walletTts || oldTts;

            // 适配旧版语速
            const normalizeRate = (r) => {
                if (r === '1.0' || r === '1') return '+0%';
                if (r === '0.9' || r === '-10%') return '+0%'; // "稍慢"选项已废弃，统一降级为正常
                if (r === '1.15') return '+15%';
                if (r === '1.3') return '+30%';
                return r;
            };
            const normalizePitch = (p) => {
                if (p === '0Hz' || p === '0') return '+0%';
                if (p === '-20Hz') return '-5%';
                if (p === '+20Hz') return '+5%';
                return p;
            };

            els.twitterTtsVoiceSelect.value = twitterTts.voice;
            els.twitterTtsRateSelect.value = normalizeRate(twitterTts.rate);
            els.twitterTtsPitchSelect.value = normalizePitch(twitterTts.pitch);

            els.walletTtsVoiceSelect.value = walletTts.voice;
            els.walletTtsRateSelect.value = normalizeRate(walletTts.rate);
            els.walletTtsPitchSelect.value = normalizePitch(walletTts.pitch);

            // 🌟 联动子集 UI：如果总开关关闭，则把子开关置灰并禁用
            const ttsSubSetting = document.getElementById('ttsSubSetting');
            if (ttsSubSetting) {
                ttsSubSetting.style.opacity = els.playDefaultToggle.checked ? '1' : '0.4';
                ttsSubSetting.style.pointerEvents = els.playDefaultToggle.checked ? 'auto' : 'none';
            }
            els.filterTweet.checked = filters.tweet !== false;
            els.filterRepost.checked = filters.repost !== false;
            els.filterReply.checked = filters.reply !== false;
            els.filterQuote.checked = filters.quote !== false;
            els.filterOther.checked = filters.other !== false; // 🌟 新增

            const walletFilters = result.walletFilters || { buy: true, sellReduce: true, sellClear: true, minAmount: 0 };
            els.filterBuy.checked = walletFilters.buy !== false;
            els.filterSellReduce.checked = walletFilters.sellReduce !== false;
            els.filterSellClear.checked = walletFilters.sellClear !== false;
            // 🧊 回显冷却器配置
            els.buyCooldownEnabled.checked = !!walletFilters.buyCooldownEnabled;
            els.buyCooldownTime.value = walletFilters.buyCooldownTime || 15;
            els.buyCooldownLabel.textContent = `${els.buyCooldownTime.value}s`;
            els.sellReduceCooldownEnabled.checked = !!walletFilters.sellReduceCooldownEnabled;
            els.sellReduceCooldownTime.value = walletFilters.sellReduceCooldownTime || 15;
            els.sellReduceCooldownLabel.textContent = `${els.sellReduceCooldownTime.value}s`;
            // 🏠 回显同址冷却器配置
            els.buyAddrCooldownEnabled.checked = !!walletFilters.buyAddrCooldownEnabled;
            els.buyAddrCooldownTime.value = walletFilters.buyAddrCooldownTime || 15;
            els.buyAddrCooldownLabel.textContent = `${els.buyAddrCooldownTime.value}s`;
            els.sellReduceAddrCooldownEnabled.checked = !!walletFilters.sellReduceAddrCooldownEnabled;
            els.sellReduceAddrCooldownTime.value = walletFilters.sellReduceAddrCooldownTime || 15;
            els.sellReduceAddrCooldownLabel.textContent = `${els.sellReduceAddrCooldownTime.value}s`;
            els.sellClearAddrCooldownEnabled.checked = !!walletFilters.sellClearAddrCooldownEnabled;
            els.sellClearAddrCooldownTime.value = walletFilters.sellClearAddrCooldownTime || 15;
            els.sellClearAddrCooldownLabel.textContent = `${els.sellClearAddrCooldownTime.value}s`;
            // 冷却器面板联动：买入/减仓/清仓关闭时，冷却器置灰
            els.buyCooldownPanel.style.opacity = els.filterBuy.checked ? '1' : '0.4';
            els.buyCooldownPanel.style.pointerEvents = els.filterBuy.checked ? 'auto' : 'none';
            els.sellReduceCooldownPanel.style.opacity = els.filterSellReduce.checked ? '1' : '0.4';
            els.sellReduceCooldownPanel.style.pointerEvents = els.filterSellReduce.checked ? 'auto' : 'none';
            els.sellClearCooldownPanel.style.opacity = els.filterSellClear.checked ? '1' : '0.4';
            els.sellClearCooldownPanel.style.pointerEvents = els.filterSellClear.checked ? 'auto' : 'none';
            els.walletMinAmount.value = walletFilters.minAmount || '';
            els.walletMaxAmount.value = walletFilters.maxAmount || '';
            els.walletMinMcap.value = walletFilters.minMcap || '';
            els.walletMaxMcap.value = walletFilters.maxMcap || '';
            els.walletMinAge.value = walletFilters.minAge || '';
            els.walletMaxAge.value = walletFilters.maxAge || '';

            const walletDictionary = result.walletDictionary || {};
            els.walletDictStatus.textContent = `已导入: ${Object.keys(walletDictionary).length} 个地址`;

            els.walletList.innerHTML = '';
            Object.entries(walletDictionary).forEach(([address, info]) => {
                const div = document.createElement('div');
                div.className = 'list-item';
                div.innerHTML = `
                    <div class="item-info">
                        <span class="item-title" title="${escapeHTML(info.rename)}">${escapeHTML(info.rename)}</span>
                        <span class="item-sub">${escapeHTML(address)}</span>
                    </div>
                    <div class="action-btns">
                        <button class="btn-icon edit" data-addr="${escapeHTML(address)}" data-name="${escapeHTML(info.rename)}">编辑</button>
                        <button class="btn-icon del" data-addr="${escapeHTML(address)}">删除</button>
                    </div>
                `;

                div.querySelector('.edit').addEventListener('click', (e) => {
                    els.editWalletAddress.value = e.target.dataset.addr;
                    els.editWalletName.value = e.target.dataset.name;
                    els.walletEditModal.style.display = 'flex';
                });

                div.querySelector('.del').addEventListener('click', (e) => {
                    const addr = e.target.dataset.addr;
                    chrome.storage.local.get(['walletDictionary'], (res) => {
                        const dict = res.walletDictionary || {};
                        delete dict[addr];
                        chrome.storage.local.set({ walletDictionary: dict }, () => {
                            showToast('已删除该钱包');
                            loadData();
                        });
                    });
                });

                els.walletList.appendChild(div);
            });

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
                optionsHtml += `<div class="custom-dropdown-item" data-value="${escapeHTML(opt.id)}" data-name="${escapeHTML(opt.name)}">${escapeHTML(opt.name)}</div>`;
            });

            els.customAudioList.innerHTML = '';
            Object.entries(customAudios).forEach(([customId, audioData]) => {
                const fileName = typeof audioData === 'string' ? '未知旧版音频' : audioData.name;
                const safeFileName = escapeHTML(fileName);
                const safeCustomId = escapeHTML(customId);
                optionsHtml += `<div class="custom-dropdown-item" data-value="${safeCustomId}" data-name="🎵 ${safeFileName}">🎵 ${safeFileName}</div>`;

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
                    applyGainToAudio(audio, parseFloat(els.twitterVolume.value));
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
                            <button class="btn-icon play" data-audio="${safeActualAudioId}" data-tid="${safeTid}" data-remark="${safeRemark}">▶ 试听</button>
                            <button class="btn-icon edit" data-tid="${safeTid}" data-audio="${safeActualAudioId}" data-audioname="${safeAudioName}" data-remark="${safeRemark}">编辑</button>
                            <button class="btn-icon del" data-tid="${safeTid}">删除</button>
                        </div>
                    `;

                    div.querySelector('.play').addEventListener('click', (e) => {
                        const audioId = e.target.dataset.audio;
                        const twitterId = e.target.dataset.tid;
                        const remark = e.target.dataset.remark;
                        let audioSrc;
                        let needsTTS = false;
                        let ttsText = '';

                        if (audioId.startsWith('custom_')) {
                            // 自定义音频：只播放，不 TTS
                            if (customAudios[audioId]) {
                                audioSrc = typeof customAudios[audioId] === 'string' ? customAudios[audioId] : customAudios[audioId].data;
                            } else {
                                showToast('音频文件丢失，播放默认音');
                                audioSrc = chrome.runtime.getURL('sounds/default.MP3');
                            }
                        } else {
                            // 内置音频
                            audioSrc = chrome.runtime.getURL(`sounds/${audioId}`);

                            // 🔥 关键修复：只有通用提示音才需要 TTS，人物专属音频不需要
                            // 🌟 新增：检查全局 TTS 开关（使用 els.enableTTSToggle 直接读取当前状态）
                            const genericSounds = ['default.MP3', 'preset1.MP3'];
                            if (els.enableTTSToggle.checked && genericSounds.includes(audioId)) {
                                needsTTS = true;
                                const speakerName = remark || twitterId;
                                ttsText = `${speakerName} 发推啦`;
                                // 🚀 如果启用 TTS，就抛弃默认铃声，纯听 TTS
                                audioSrc = null;
                            }
                        }

                        const playEdgeTTS = async () => {
                            try {
                                const res = await fetchTTS({
                                    text: ttsText,
                                    voice: els.twitterTtsVoiceSelect.value,
                                    rate: els.twitterTtsRateSelect.value,
                                    pitch: els.twitterTtsPitchSelect.value
                                });
                                if (!res.ok) throw new Error("TTS Request Failed");
                                const blob = await res.blob();
                                const audioUrl = URL.createObjectURL(blob);
                                const audio = new Audio(audioUrl);
                                applyGainToAudio(audio, parseFloat(els.twitterVolume.value) * 1.5);
                                audio.addEventListener('ended', () => {
                                    URL.revokeObjectURL(audioUrl);
                                    audio.removeAttribute('src');
                                    audio.load();
                                    if (audio.__sourceNode) {
                                        try { audio.__sourceNode.disconnect(); } catch (e) { }
                                        try { audio.__gainNode.disconnect(); } catch (e) { }
                                    }
                                });
                                audio.play().catch(e => showToast('TTS 播放失败'));
                            } catch (e) {
                                showToast('网络 TTS 失败，请检查连接');
                            }
                        };

                        if (audioSrc) {
                            const audio = new Audio(audioSrc);
                            applyGainToAudio(audio, parseFloat(els.twitterVolume.value));

                            if (needsTTS) {
                                audio.addEventListener('ended', playEdgeTTS);
                            }
                            audio.play().catch(err => showToast('播放失败'));
                        } else if (needsTTS) {
                            // 纯 TTS 试听
                            playEdgeTTS();
                        }
                    });

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

    const saveTwitterConfig = () => {
        chrome.storage.local.set({
            twitterTts: {
                voice: els.twitterTtsVoiceSelect.value,
                rate: els.twitterTtsRateSelect.value,
                pitch: els.twitterTtsPitchSelect.value
            },
            twitterVolume: parseFloat(els.twitterVolume.value)
        });
        els.twitterVolumePercent.textContent = Math.round(parseFloat(els.twitterVolume.value) * 100) + '%';
    };

    const saveWalletConfig = () => {
        chrome.storage.local.set({
            walletTts: {
                voice: els.walletTtsVoiceSelect.value,
                rate: els.walletTtsRateSelect.value,
                pitch: els.walletTtsPitchSelect.value
            },
            walletVolume: parseFloat(els.walletVolume.value)
        });
        els.walletVolumePercent.textContent = Math.round(parseFloat(els.walletVolume.value) * 100) + '%';
    };

    els.twitterTtsVoiceSelect.addEventListener('change', saveTwitterConfig);
    els.twitterTtsRateSelect.addEventListener('change', saveTwitterConfig);
    els.twitterTtsPitchSelect.addEventListener('change', saveTwitterConfig);
    els.twitterVolume.addEventListener('input', saveTwitterConfig);
    els.twitterVolume.addEventListener('change', saveTwitterConfig);

    els.walletTtsVoiceSelect.addEventListener('change', saveWalletConfig);
    els.walletTtsRateSelect.addEventListener('change', saveWalletConfig);
    els.walletTtsPitchSelect.addEventListener('change', saveWalletConfig);
    els.walletVolume.addEventListener('input', saveWalletConfig);
    els.walletVolume.addEventListener('change', saveWalletConfig);


    // 🌟 钱包专属试听逻辑
    const playWalletTTS = async (text) => {
        const voice = els.walletTtsVoiceSelect.value;
        const rate = els.walletTtsRateSelect.value;
        const pitch = els.walletTtsPitchSelect.value;
        els.toast.textContent = "生成语音中...";
        els.toast.classList.add('show');
        try {
            const res = await fetchTTS({ text, voice, rate, pitch });
            if (!res.ok) throw new Error("TTS Request Failed");
            const blob = await res.blob();
            const audioUrl = URL.createObjectURL(blob);
            const audio = new Audio(audioUrl);
            applyGainToAudio(audio, parseFloat(els.walletVolume.value) * 1.5);
            audio.play();
            els.toast.classList.remove('show');
        } catch (e) {
            console.error(e);
            showToast("TTS生成失败");
        }
    };

    els.testWalletBuyBtn.addEventListener('click', () => playWalletTTS("技术瓜买入比特币"));
    els.testWalletSellReduceBtn.addEventListener('click', () => playWalletTTS("技术瓜减仓比特币"));
    els.testWalletSellClearBtn.addEventListener('click', () => playWalletTTS("技术瓜清仓比特币"));

    // 🌟 系统设置 - 推特监控试听
    els.twitterTtsTestBtn.addEventListener('click', async () => {
        const text = "技术瓜发推啦";
        const voice = els.twitterTtsVoiceSelect.value;
        const rate = els.twitterTtsRateSelect.value;
        const pitch = els.twitterTtsPitchSelect.value;
        try {
            const res = await fetchTTS({ text, voice, rate, pitch });
            if (!res.ok) throw new Error("TTS Request Failed");
            const blob = await res.blob();
            const audioUrl = URL.createObjectURL(blob);
            const audio = new Audio(audioUrl);
            applyGainToAudio(audio, parseFloat(els.twitterVolume.value) * 1.5);
            audio.addEventListener('ended', () => {
                URL.revokeObjectURL(audioUrl);
                audio.removeAttribute('src');
                audio.load();
                if (audio.__sourceNode) {
                    try { audio.__sourceNode.disconnect(); } catch (e) { }
                    try { audio.__gainNode.disconnect(); } catch (e) { }
                }
            });
            audio.play().catch(e => showToast('TTS 播放失败'));
        } catch (e) {
            showToast('网络 TTS 失败，请检查连接');
        }
    });

    // 🌟 系统设置 - 钱包监控试听
    els.walletTtsTestBtn.addEventListener('click', () => playWalletTTS("技术瓜买入比特币"));

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

    els.walletSearchInput.addEventListener('input', (e) => {
        const searchTerm = e.target.value.trim().toLowerCase();
        els.walletList.querySelectorAll('.list-item').forEach(item => {
            const textContent = item.querySelector('.item-info').textContent.toLowerCase();
            item.style.display = textContent.includes(searchTerm) ? 'flex' : 'none';
        });
    });

    els.cancelWalletEditBtn.addEventListener('click', () => {
        els.walletEditModal.style.display = 'none';
    });

    els.saveWalletEditBtn.addEventListener('click', () => {
        const addr = els.editWalletAddress.value.trim().toLowerCase();
        const rename = els.editWalletName.value.trim();
        if (!rename) return showToast('备注不能为空');
        
        chrome.storage.local.get(['walletDictionary'], (res) => {
            const dict = res.walletDictionary || {};
            if (dict[addr]) {
                dict[addr].rename = rename;
                chrome.storage.local.set({ walletDictionary: dict }, () => {
                    showToast('钱包备注已更新');
                    els.walletEditModal.style.display = 'none';
                    loadData();
                });
            }
        });
    });

    // [已废弃] 全局音量控制已拆分为 twitterVolume / walletVolume 独立控制，事件已在 saveTwitterConfig / saveWalletConfig 中处理
    els.masterToggle.addEventListener('change', (e) => { chrome.storage.local.set({ isMasterEnabled: e.target.checked }, () => { showToast(e.target.checked ? '监听已开启' : '监听已暂停'); }); });
    els.enableTwitterToggle.addEventListener('change', (e) => { chrome.storage.local.set({ enableTwitter: e.target.checked }, () => { showToast(e.target.checked ? '推特监控已开启' : '推特监控已关闭'); }); });
    els.enableWalletToggle.addEventListener('change', (e) => { chrome.storage.local.set({ enableWallet: e.target.checked }, () => { showToast(e.target.checked ? '钱包监控已开启' : '钱包监控已关闭'); }); });
    els.playDefaultToggle.addEventListener('change', (e) => {
        chrome.storage.local.set({ playDefaultUnmapped: e.target.checked }, () => {
            showToast(e.target.checked ? '已开启默认音频' : '已关闭默认音频');

            // 🌟 联动子集 UI
            const ttsSubSetting = document.getElementById('ttsSubSetting');
            if (ttsSubSetting) {
                ttsSubSetting.style.opacity = e.target.checked ? '1' : '0.4';
                ttsSubSetting.style.pointerEvents = e.target.checked ? 'auto' : 'none';
            }
        });
    });
    els.enableTTSToggle.addEventListener('change', (e) => {
        chrome.storage.local.set({ enableTTS: e.target.checked }, () => {
            showToast(e.target.checked ? '已开启语音播报' : '已关闭语音播报');
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

        const MAX_AUDIO_SIZE = 50 * 1024 * 1024;  // 50MB
        const MAX_ZIP_SIZE = 200 * 1024 * 1024;   // 200MB

        // 🌟 技巧 2：将并行的 Promise.all 改为串行 await，防止瞬间撑爆内存
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const fileName = file.name;
            const fileExt = fileName.substring(fileName.lastIndexOf('.') + 1).toLowerCase();

            if (fileExt === 'zip') {
                if (file.size > MAX_ZIP_SIZE) { failCount++; continue; }
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
                if (file.size > MAX_AUDIO_SIZE) { failCount++; continue; }
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

    // 🌟 钱包监控设置保存
    const saveWalletFilters = () => {
        chrome.storage.local.set({
            walletFilters: {
                buy: els.filterBuy.checked,
                sellReduce: els.filterSellReduce.checked,
                sellClear: els.filterSellClear.checked,
                // 🧊 同币冷却器配置
                buyCooldownEnabled: els.buyCooldownEnabled.checked,
                buyCooldownTime: parseInt(els.buyCooldownTime.value) || 15,
                sellReduceCooldownEnabled: els.sellReduceCooldownEnabled.checked,
                sellReduceCooldownTime: parseInt(els.sellReduceCooldownTime.value) || 15,
                // 🏠 同址冷却器配置
                buyAddrCooldownEnabled: els.buyAddrCooldownEnabled.checked,
                buyAddrCooldownTime: parseInt(els.buyAddrCooldownTime.value) || 15,
                sellReduceAddrCooldownEnabled: els.sellReduceAddrCooldownEnabled.checked,
                sellReduceAddrCooldownTime: parseInt(els.sellReduceAddrCooldownTime.value) || 15,
                sellClearAddrCooldownEnabled: els.sellClearAddrCooldownEnabled.checked,
                sellClearAddrCooldownTime: parseInt(els.sellClearAddrCooldownTime.value) || 15,
                minAmount: parseFloat(els.walletMinAmount.value) || 0,
                maxAmount: parseFloat(els.walletMaxAmount.value) || 0,
                minMcap: parseFloat(els.walletMinMcap.value) || 0,
                maxMcap: parseFloat(els.walletMaxMcap.value) || 0,
                minAge: parseFloat(els.walletMinAge.value) || 0,
                maxAge: parseFloat(els.walletMaxAge.value) || 0
            }
        });
    };

    // 🧊 同币冷却器滑块实时标签更新 + 联动
    els.buyCooldownTime.addEventListener('input', () => {
        els.buyCooldownLabel.textContent = `${els.buyCooldownTime.value}s`;
    });
    els.buyCooldownTime.addEventListener('change', saveWalletFilters);
    els.buyCooldownEnabled.addEventListener('change', saveWalletFilters);
    els.sellReduceCooldownTime.addEventListener('input', () => {
        els.sellReduceCooldownLabel.textContent = `${els.sellReduceCooldownTime.value}s`;
    });
    els.sellReduceCooldownTime.addEventListener('change', saveWalletFilters);
    els.sellReduceCooldownEnabled.addEventListener('change', saveWalletFilters);

    // 🏠 同址冷却器滑块实时标签更新 + 联动
    els.buyAddrCooldownTime.addEventListener('input', () => {
        els.buyAddrCooldownLabel.textContent = `${els.buyAddrCooldownTime.value}s`;
    });
    els.buyAddrCooldownTime.addEventListener('change', saveWalletFilters);
    els.buyAddrCooldownEnabled.addEventListener('change', saveWalletFilters);
    els.sellReduceAddrCooldownTime.addEventListener('input', () => {
        els.sellReduceAddrCooldownLabel.textContent = `${els.sellReduceAddrCooldownTime.value}s`;
    });
    els.sellReduceAddrCooldownTime.addEventListener('change', saveWalletFilters);
    els.sellReduceAddrCooldownEnabled.addEventListener('change', saveWalletFilters);
    els.sellClearAddrCooldownTime.addEventListener('input', () => {
        els.sellClearAddrCooldownLabel.textContent = `${els.sellClearAddrCooldownTime.value}s`;
    });
    els.sellClearAddrCooldownTime.addEventListener('change', saveWalletFilters);
    els.sellClearAddrCooldownEnabled.addEventListener('change', saveWalletFilters);

    // 买入/减仓/清仓主开关联动冷却器面板
    els.filterBuy.addEventListener('change', () => {
        els.buyCooldownPanel.style.opacity = els.filterBuy.checked ? '1' : '0.4';
        els.buyCooldownPanel.style.pointerEvents = els.filterBuy.checked ? 'auto' : 'none';
        saveWalletFilters();
    });
    els.filterSellReduce.addEventListener('change', () => {
        els.sellReduceCooldownPanel.style.opacity = els.filterSellReduce.checked ? '1' : '0.4';
        els.sellReduceCooldownPanel.style.pointerEvents = els.filterSellReduce.checked ? 'auto' : 'none';
        saveWalletFilters();
    });
    els.filterSellClear.addEventListener('change', () => {
        els.sellClearCooldownPanel.style.opacity = els.filterSellClear.checked ? '1' : '0.4';
        els.sellClearCooldownPanel.style.pointerEvents = els.filterSellClear.checked ? 'auto' : 'none';
        saveWalletFilters();
    });
    els.walletMinAmount.addEventListener('change', saveWalletFilters);
    els.walletMaxAmount.addEventListener('change', saveWalletFilters);
    els.walletMinMcap.addEventListener('change', saveWalletFilters);
    els.walletMaxMcap.addEventListener('change', saveWalletFilters);
    els.walletMinAge.addEventListener('change', saveWalletFilters);
    els.walletMaxAge.addEventListener('change', saveWalletFilters);

    els.importWalletDictBtn.addEventListener('click', () => {
        const text = els.walletDictInput.value.trim();
        if (!text) return showToast('请输入 JSON 数据');
        try {
            const data = JSON.parse(text);
            const items = Array.isArray(data) ? data : [data];
            chrome.storage.local.get(['walletDictionary'], (result) => {
                const dict = result.walletDictionary || {};
                let count = 0;
                items.forEach(item => {
                    const nameToUse = item.rename || item.name;
                    if (item.address && nameToUse && /^[a-zA-Z0-9_\-]{20,70}$/.test(item.address)) {
                        dict[item.address.toLowerCase()] = { rename: nameToUse };
                        count++;
                    }
                });
                chrome.storage.local.set({ walletDictionary: dict }, () => {
                    showToast(`成功导入 ${count} 个钱包地址`);
                    els.walletDictInput.value = '';
                    loadData();
                });
            });
        } catch (e) {
            showToast('JSON 格式错误: ' + e.message, 3000);
        }
    });

    els.addCustomWalletBtn.addEventListener('click', () => {
        const name = els.customWalletName.value.trim();
        const address = els.customWalletAddress.value.trim();
        
        if (!name) return showToast('请输入钱包名称');
        if (!address) return showToast('请输入钱包地址');
        if (!/^[a-zA-Z0-9_\-]{20,70}$/.test(address)) {
            return showToast('钱包地址格式不正确', 3000);
        }

        chrome.storage.local.get(['walletDictionary'], (result) => {
            const dict = result.walletDictionary || {};
            const lowerAddr = address.toLowerCase();

            // 检查是否重复
            if (dict[lowerAddr]) {
                const oldName = dict[lowerAddr].rename;
                if (!confirm(`该钱包地址已存在，当前名称为 [${oldName}]。是否要将其覆盖为 [${name}]？`)) {
                    return; // 用户取消覆盖
                }
            }

            dict[lowerAddr] = { rename: name };
            
            chrome.storage.local.set({ walletDictionary: dict }, () => {
                showToast(`成功添加单地址: ${name}`);
                els.customWalletName.value = '';
                els.customWalletAddress.value = '';
                loadData();
            });
        });
    });

    els.clearWalletDictBtn.addEventListener('click', () => {
        if (confirm('确定要清空所有钱包地址映射吗？')) {
            chrome.storage.local.set({ walletDictionary: {} }, () => {
                showToast('已清空');
                loadData();
            });
        }
    });

    // 🌟 处理钱包设置面板的展开/收起下拉逻辑
    document.querySelectorAll('.toggle-panel-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const targetId = e.currentTarget.dataset.target;
            const targetEl = document.getElementById(targetId);
            if (targetEl.style.display === 'none' || targetEl.style.display === '') {
                targetEl.style.display = 'flex';
                e.currentTarget.innerHTML = '⚙️ ▲';
            } else {
                targetEl.style.display = 'none';
                e.currentTarget.innerHTML = '⚙️ ▼';
            }
        });
    });

    loadData();
});