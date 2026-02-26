chrome.runtime.onInstalled.addListener(() => {
    // 检查本地数据库中是否已经存在映射规则
    chrome.storage.local.get(['twitterAudioMappings'], (result) => {
        // 只有当完全没有数据时（即全新安装），才注入默认规则
        // 这样不会覆盖老用户自己修改过的数据
        if (!result.twitterAudioMappings) {
            const defaultMappings = {
                "elonmusk": { id: "elonmusk.MP3", name: "马斯克专属", remark: "内置预设" },
                "cz_binance": { id: "cz.MP3", name: "CZ专属", remark: "内置预设" },
                "heyibinance": { id: "heyi.MP3", name: "何一专属", remark: "内置预设" }
            };

            chrome.storage.local.set({ twitterAudioMappings: defaultMappings }, () => {
                console.log("[GmgnAudioPlayer] 默认映射规则初始化成功！");
            });
        }
    });
});